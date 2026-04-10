"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import TaskGraph from "@/components/TaskGraph";
import LogViewer from "@/components/LogViewer";
import Controls from "@/components/Controls";
import CostPanel from "@/components/CostPanel";
import FileTree from "@/components/FileTree";
import PlanEditor from "@/components/PlanEditor";
import BranchGraph from "@/components/BranchGraph";
import InlinePrompt from "@/components/InlinePrompt";
import AddTaskForm from "@/components/AddTaskForm";
import ReviewPanel from "@/components/ReviewPanel";
import Suggestions from "@/components/Suggestions";
import PlanningChat from "@/components/PlanningChat";
import type { ChatMessage } from "@/components/PlanningChat";

export default function DashboardPage() {
  const { connected, tasks, logs, layers, costs, summary, fileTree, planStatus, promptResponses, pendingReviews, suggestions, sendCommand } =
    useWebSocket("ws://localhost:3100");

  const [selectedTaskId, setSelectedTaskId] = useState<number | undefined>();
  const [paused, setPaused] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [runActive, setRunActive] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [showPlanning, setShowPlanning] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatWaiting, setChatWaiting] = useState(false);

  const handleCreateTask = (taskDef: { title: string; description: string; dependsOn: number[]; milestone?: string; effort?: string }) => {
    sendCommand({ type: "task:create", ...taskDef });
    setShowAddTask(false);
  };

  const handleExecute = (mode: "automated" | "human_review") => {
    sendCommand({ type: "run:start", mode });
    setRunActive(true);
  };

  // Reset runActive when run completes
  useEffect(() => {
    if (summary) setRunActive(false);
  }, [summary]);

  // Request file tree on connection
  useEffect(() => {
    if (connected) {
      sendCommand({ type: "files:tree" });
    }
  }, [connected, sendCommand]);

  const taskGraphData = useMemo(() => {
    const data = new Map<number, { state: string; title?: string; description?: string; milestone?: string | null; dependsOn?: number[]; phase?: string; cost?: number; contextPercentage?: number }>();
    tasks.forEach((info, id) => {
      data.set(id, {
        state: info.state,
        title: info.title,
        description: info.description,
        milestone: info.milestone,
        dependsOn: info.dependsOn,
        phase: info.phase,
        cost: info.cost,
        contextPercentage: info.contextRollup?.peakPercentage,
      });
    });
    return data;
  }, [tasks]);

  const branchData = useMemo(() => {
    const m = new Map<number, { taskId: number; branch: string; status: "created" | "merged" | "deleted" }>();
    tasks.forEach((info, id) => {
      if (info.state === "spec" || info.state === "executing" || info.state === "reviewing" || info.state === "done" || info.state === "paused") {
        m.set(id, { taskId: id, branch: `task/${id}`, status: "created" });
      } else if (info.state === "merged") {
        m.set(id, { taskId: id, branch: `task/${id}`, status: "merged" });
      }
    });
    return m;
  }, [tasks]);

  const taskPositions = useMemo(() => {
    const positions = new Map<number, { layerIdx: number }>();
    const layerCache = new Map<number, number>();

    function computeLayer(id: number): number {
      if (layerCache.has(id)) return layerCache.get(id)!;
      const task = taskGraphData.get(id);
      if (!task?.dependsOn?.length) { layerCache.set(id, 0); return 0; }
      let maxDep = 0;
      for (const depId of task.dependsOn) {
        if (taskGraphData.has(depId)) {
          maxDep = Math.max(maxDep, computeLayer(depId) + 1);
        }
      }
      layerCache.set(id, maxDep);
      return maxDep;
    }

    taskGraphData.forEach((_, id) => {
      positions.set(id, { layerIdx: computeLayer(id) });
    });
    return positions;
  }, [taskGraphData]);

  const selectedLogs = useMemo(() => {
    if (selectedTaskId == null) {
      // Merge all logs
      const allLogs: string[] = [];
      logs.forEach((lines, taskId) => {
        lines.forEach((line) => allLogs.push(`[#${taskId}] ${line}`));
      });
      return allLogs;
    }
    return logs.get(selectedTaskId) ?? [];
  }, [logs, selectedTaskId]);

  const taskCosts = useMemo(() => {
    const m = new Map<number, number>();
    tasks.forEach((info, id) => {
      if (info.cost > 0) m.set(id, info.cost);
    });
    return m;
  }, [tasks]);

  const taskContextData = useMemo(() => {
    const m = new Map<number, { peakPercentage: number; totalTokensUsed: number }>();
    tasks.forEach((info, id) => {
      if (info.contextRollup && info.contextRollup.peakPercentage > 0) {
        m.set(id, info.contextRollup);
      }
    });
    return m;
  }, [tasks]);

  const handleChatSend = (message: string) => {
    setChatMessages(prev => [...prev, { role: "user", content: message, timestamp: Date.now() }]);
    setChatWaiting(true);
    sendCommand({ type: "prompt:submit", taskId: 0, prompt: message, threadMode: "continue" } as any);
  };

  // Listen for planning chat responses (taskId 0)
  useEffect(() => {
    const response = promptResponses.get(0);
    if (response && chatWaiting) {
      const lines = response.split("\n");
      const optionLines = lines.filter((l: string) => /^\s*[-*]\s/.test(l) || /^\s*\d+[.)]\s/.test(l));
      const options = optionLines.length >= 2 ? optionLines.map((l: string) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim()) : undefined;
      setChatMessages(prev => [...prev, { role: "assistant", content: response, options, timestamp: Date.now() }]);
      setChatWaiting(false);
    }
  }, [promptResponses, chatWaiting]);

  const handleLoadPlan = (markdown: string) => {
    sendCommand({ type: "plan:load", markdown });
  };

  const handlePromptSubmit = (taskId: number, prompt: string, threadMode: "continue" | "new") => {
    sendCommand({ type: "prompt:submit", taskId, prompt, threadMode });
  };

  const handleCommand = (cmd: { type: string; taskId?: number }) => {
    if (cmd.type === "command:pause_all") setPaused(true);
    if (cmd.type === "command:resume_all") setPaused(false);
    sendCommand(cmd as Parameters<typeof sendCommand>[0]);
  };

  const handleApprove = (taskId: number) => {
    sendCommand({ type: "task:approve", taskId } as any);
  };
  const handleReject = (taskId: number) => {
    sendCommand({ type: "task:retry", taskId } as any);
  };

  const activeReview = useMemo(() => {
    if (pendingReviews.size === 0) return null;
    const [first] = pendingReviews.values();
    return first;
  }, [pendingReviews]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 20px",
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            Claude Orchestrator
          </h1>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: connected ? "var(--success)" : "var(--error)",
            }}
          >
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: connected ? "var(--success)" : "var(--error)",
              }}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 13 }}>
          <span style={{ color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 8 }}>
            Tasks: {tasks.size}
            <button
              onClick={() => setShowAddTask(true)}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                color: "var(--accent)",
                fontSize: 14,
                fontWeight: 600,
                width: 28,
                height: 28,
                borderRadius: 6,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              +
            </button>
          </span>
          <span style={{ color: "var(--text-secondary)" }}>
            Cost: <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
              ${costs.totalCost.toFixed(4)}
            </span>
          </span>
          <button
            onClick={() => setShowPlanning(prev => !prev)}
            style={{
              background: showPlanning ? "rgba(59,130,246,0.15)" : "none",
              border: `1px solid ${showPlanning ? "var(--accent)" : "var(--border)"}`,
              color: showPlanning ? "var(--accent)" : "var(--text-muted)",
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Planning Chat
          </button>
          {summary && (
            <span
              style={{
                backgroundColor: "var(--success)20",
                color: "var(--success)",
                padding: "2px 8px",
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              Run Complete
            </span>
          )}
        </div>
      </header>

      {/* Main content */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
        }}
      >
        {/* Task graph + logs */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            padding: 16,
            gap: 16,
          }}
        >
          {/* Plan editor */}
          <PlanEditor
            onLoadPlan={handleLoadPlan}
            planLoaded={planStatus.loaded}
            taskCount={planStatus.taskCount}
          />

          {/* Branch visualization above DAG */}
          <BranchGraph branches={branchData} taskPositions={taskPositions} />

          {/* Task graph area */}
          <div style={{ flex: 1, minHeight: 200, display: "flex" }}>
            <TaskGraph
              tasks={taskGraphData}
              layers={layers}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          </div>

          {/* Review panel (shown when task needs human review) */}
          {activeReview && (
            <ReviewPanel
              review={activeReview}
              taskTitle={tasks.get(activeReview.taskId)?.title}
              onApprove={handleApprove}
              onReject={handleReject}
              onClose={() => {/* dismiss without action */}}
            />
          )}

          {/* Task Detail (shown when task selected) */}
          {selectedTaskId != null && (() => {
            const task = tasks.get(selectedTaskId);
            if (!task) return null;
            return (
              <div
                style={{
                  flexShrink: 0,
                  backgroundColor: "var(--bg-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                    #{selectedTaskId} {task.title ?? `Task ${selectedTaskId}`}
                  </span>
                  <button
                    onClick={() => setSelectedTaskId(undefined)}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      color: "var(--text-muted)",
                      fontSize: 11,
                      padding: "2px 8px",
                      borderRadius: 3,
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>

                {task.description && (
                  <div
                    style={{
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: "var(--text-secondary)",
                      whiteSpace: "pre-wrap",
                      maxHeight: 120,
                      overflowY: "auto",
                    }}
                  >
                    {task.description}
                  </div>
                )}

                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "var(--text-muted)" }}>
                  {task.milestone && (
                    <span>Milestone: <span style={{ color: "var(--text-secondary)" }}>{task.milestone}</span></span>
                  )}
                  {task.effort && (
                    <span>Effort: <span style={{ color: "var(--text-secondary)", textTransform: "capitalize" }}>{task.effort}</span></span>
                  )}
                  {task.dependsOn && task.dependsOn.length > 0 && (
                    <span>Depends on: <span style={{ color: "var(--text-secondary)" }}>{task.dependsOn.map(d => `#${d}`).join(", ")}</span></span>
                  )}
                  {task.model && (
                    <span>Model: <span style={{ color: "var(--text-secondary)" }}>{task.model}</span></span>
                  )}
                  {task.cost > 0 && (
                    <span>Cost: <span style={{ color: "var(--text-secondary)" }}>${task.cost.toFixed(4)}</span></span>
                  )}
                  {(task.tokensIn > 0 || task.tokensOut > 0) && (
                    <span>Tokens: <span style={{ color: "var(--text-secondary)" }}>{task.tokensIn.toLocaleString()} in / {task.tokensOut.toLocaleString()} out</span></span>
                  )}
                </div>

                <InlinePrompt
                  taskId={selectedTaskId}
                  onSubmit={(prompt, threadMode) => handlePromptSubmit(selectedTaskId, prompt, threadMode)}
                  lastResponse={promptResponses.get(selectedTaskId)}
                />
              </div>
            );
          })()}

          {/* Log viewer */}
          <div style={{ flexShrink: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                }}
              >
                {selectedTaskId != null ? `Logs - Task #${selectedTaskId}` : "All Logs"}
              </span>
            </div>
            <LogViewer logs={selectedLogs} maxHeight={250} />
          </div>

          {/* Planning Chat */}
          {showPlanning && (
            <div
              style={{
                flexShrink: 0,
                height: 380,
                borderTop: "1px solid var(--border)",
                backgroundColor: "var(--bg-secondary)",
                borderRadius: 8,
                border: "1px solid var(--border)",
                overflow: "hidden",
              }}
            >
              <PlanningChat
                messages={chatMessages}
                onSendMessage={handleChatSend}
                isWaiting={chatWaiting}
              />
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside
          style={{
            width: 240,
            flexShrink: 0,
            borderLeft: "1px solid var(--border)",
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            overflowY: "auto",
            backgroundColor: "var(--bg-primary)",
          }}
        >
          <CostPanel
            totalCost={costs.totalCost}
            tokensIn={costs.totalTokensIn}
            tokensOut={costs.totalTokensOut}
            taskCosts={taskCosts}
            taskContextData={taskContextData}
          />

          {/* Files */}
          <div
            style={{
              backgroundColor: "var(--bg-secondary)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: filesOpen ? 16 : "8px 16px",
            }}
          >
            <div
              onClick={() => setFilesOpen((v) => !v)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: "var(--text-muted)",
                cursor: "pointer",
                userSelect: "none",
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: filesOpen ? 12 : 0,
              }}
            >
              <span style={{ fontSize: 10 }}>{filesOpen ? "\u25BE" : "\u25B8"}</span>
              Files
            </div>
            {filesOpen && <FileTree tree={fileTree} />}
          </div>

          <Controls
            selectedTaskId={selectedTaskId}
            onCommand={handleCommand}
            paused={paused}
            runActive={runActive}
            onExecute={handleExecute}
          />

          <Suggestions suggestions={suggestions} />

          {/* Run Summary (shown when complete) */}
          {summary && (
            <div
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--success)40",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--success)",
                  marginBottom: 12,
                }}
              >
                Run Summary
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>Completed</span>
                  <span style={{ color: "var(--success)" }}>{summary.completed}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>Failed</span>
                  <span style={{ color: summary.failed > 0 ? "var(--error)" : "var(--text-secondary)" }}>
                    {summary.failed}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>Skipped</span>
                  <span style={{ color: "var(--text-secondary)" }}>{summary.skipped}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>Duration</span>
                  <span style={{ color: "var(--text-secondary)" }}>
                    {(summary.duration / 1000).toFixed(1)}s
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "var(--text-muted)" }}>Learnings</span>
                  <span style={{ color: "var(--text-secondary)" }}>{summary.learnings}</span>
                </div>
              </div>
            </div>
          )}

          {/* Learnings Summary (shown when available) */}
          {summary?.learningSummary && (
            <div
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  marginBottom: 12,
                }}
              >
                Learnings
              </div>
              <div
                style={{
                  fontSize: 12,
                  lineHeight: 1.6,
                  color: "var(--text-secondary)",
                  whiteSpace: "pre-wrap",
                  overflowY: "auto",
                  maxHeight: 300,
                }}
              >
                {summary.learningSummary}
              </div>
            </div>
          )}
        </aside>
      </div>

      {showAddTask && (
        <AddTaskForm
          existingTasks={tasks}
          onCreateTask={handleCreateTask}
          onClose={() => setShowAddTask(false)}
        />
      )}
    </div>
  );
}
