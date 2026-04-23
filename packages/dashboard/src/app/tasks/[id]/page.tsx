"use client";

import React, { useMemo } from "react";
import { useParams, useRouter } from "next/navigation";
import { useWebSocket } from "@/hooks/useWebSocket";
import LogViewer from "@/components/LogViewer";

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = Number(params.id);

  const { connected, tasks, logs, costs } = useWebSocket("ws://localhost:3100");

  const task = tasks.get(taskId);
  const taskLogs = useMemo(
    () => (logs.get(taskId) ?? []).map((line) => ({ line })),
    [logs, taskId]
  );

  const stateColors: Record<string, string> = {
    pending: "#525252",
    spec: "#3b82f6",
    executing: "#06b6d4",
    reviewing: "#eab308",
    done: "#22c55e",
    merged: "#10b981",
    failed: "#ef4444",
    skipped: "#737373",
    paused: "#f97316",
  };

  const stateColor = task ? stateColors[task.state] ?? "#525252" : "#525252";

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
          <button
            onClick={() => router.push("/")}
            style={{
              background: "none",
              border: "1px solid var(--border)",
              color: "var(--text-secondary)",
              fontSize: 12,
              padding: "4px 10px",
              borderRadius: 4,
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "var(--text-muted)";
              e.currentTarget.style.color = "var(--text-primary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "var(--border)";
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            Back
          </button>
          <h1
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--text-primary)",
              margin: 0,
            }}
          >
            Task #{taskId}
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
      </header>

      {/* Content */}
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {!task ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-muted)",
              fontSize: 14,
            }}
          >
            {connected
              ? `Task #${taskId} not found. It may not have started yet.`
              : "Connecting to orchestrator..."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 900 }}>
            {/* Task info header */}
            <div
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 20,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 16,
                }}
              >
                <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
                  {task.title ?? `Task ${taskId}`}
                </h2>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: stateColor,
                    backgroundColor: `${stateColor}18`,
                    padding: "4px 10px",
                    borderRadius: 4,
                  }}
                >
                  {task.state}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                  gap: 16,
                }}
              >
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                    State
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: stateColor }}>
                    {task.state}
                  </div>
                </div>

                {task.phase && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                      Phase
                    </div>
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 500,
                        color: "var(--text-primary)",
                        textTransform: "capitalize",
                      }}
                    >
                      {task.phase}
                    </div>
                  </div>
                )}

                {task.model && (
                  <div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                      Model
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                      {task.model}
                    </div>
                  </div>
                )}

                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                    Cost
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                    ${task.cost.toFixed(4)}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                    Tokens In
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                    {task.tokensIn.toLocaleString()}
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                    Tokens Out
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                    {task.tokensOut.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* Log output */}
            <div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  color: "var(--text-muted)",
                  marginBottom: 8,
                }}
              >
                Log Output ({taskLogs.length} lines)
              </div>
              <LogViewer logs={taskLogs} maxHeight={600} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
