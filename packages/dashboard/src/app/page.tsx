"use client";

import React, { useState, useMemo } from "react";
import { useWebSocket } from "@/hooks/useWebSocket";
import TaskGraph from "@/components/TaskGraph";
import LogViewer from "@/components/LogViewer";
import Controls from "@/components/Controls";
import CostPanel from "@/components/CostPanel";

export default function DashboardPage() {
  const { connected, tasks, logs, layers, costs, summary, sendCommand } =
    useWebSocket("ws://localhost:3100");

  const [selectedTaskId, setSelectedTaskId] = useState<number | undefined>();
  const [paused, setPaused] = useState(false);

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

  const handleCommand = (cmd: { type: string; taskId?: number }) => {
    if (cmd.type === "command:pause_all") setPaused(true);
    if (cmd.type === "command:resume_all") setPaused(false);
    sendCommand(cmd as Parameters<typeof sendCommand>[0]);
  };

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
          <span style={{ color: "var(--text-secondary)" }}>
            Tasks: {tasks.size}
          </span>
          <span style={{ color: "var(--text-secondary)" }}>
            Cost: <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
              ${costs.totalCost.toFixed(4)}
            </span>
          </span>
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
          {/* Task graph area */}
          <div style={{ flex: 1, minHeight: 200, display: "flex" }}>
            <TaskGraph
              tasks={taskGraphData}
              layers={layers}
              selectedTaskId={selectedTaskId}
              onSelectTask={setSelectedTaskId}
            />
          </div>

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
          <Controls
            selectedTaskId={selectedTaskId}
            onCommand={handleCommand}
            paused={paused}
          />

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
    </div>
  );
}
