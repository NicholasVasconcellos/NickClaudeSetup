"use client";

import React, { useState } from "react";

interface ControlsProps {
  selectedTaskId?: number;
  onCommand: (cmd: { type: string; taskId?: number }) => void;
  paused: boolean;
  runActive: boolean;
  onExecute: (mode: "automated" | "human_review") => void;
}

function ControlButton({
  label,
  onClick,
  color = "var(--accent)",
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  color?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        backgroundColor: disabled ? "var(--bg-tertiary)" : `${color}20`,
        color: disabled ? "var(--text-muted)" : color,
        border: `1px solid ${disabled ? "var(--border)" : `${color}40`}`,
        borderRadius: 4,
        padding: "6px 12px",
        fontSize: 12,
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        width: "100%",
        textAlign: "center" as const,
        transition: "background-color 0.15s",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) {
          e.currentTarget.style.backgroundColor = `${color}30`;
        }
      }}
      onMouseLeave={(e) => {
        if (!disabled) {
          e.currentTarget.style.backgroundColor = `${color}20`;
        }
      }}
    >
      {label}
    </button>
  );
}

export default function Controls({ selectedTaskId, onCommand, paused, runActive, onExecute }: ControlsProps) {
  const [mode, setMode] = useState<"automated" | "human_review">("automated");

  return (
    <div
      style={{
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      {/* Execute Section */}
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-muted)",
          marginBottom: 4,
        }}
      >
        Execute
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        {(["automated", "human_review"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              flex: 1,
              fontSize: 11,
              fontWeight: 500,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              padding: "5px 8px",
              borderRadius: 4,
              border: mode === m
                ? "1px solid var(--accent)"
                : "1px solid var(--border)",
              backgroundColor: mode === m ? "var(--accent)" : "transparent",
              color: mode === m ? "#fff" : "var(--text-muted)",
              cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {m === "automated" ? "Automated" : "Human Review"}
          </button>
        ))}
      </div>

      <button
        onClick={() => onExecute(mode)}
        disabled={runActive}
        style={{
          width: "100%",
          padding: 10,
          fontSize: 13,
          fontWeight: 600,
          borderRadius: 6,
          border: "none",
          backgroundColor: "var(--accent)",
          color: "#fff",
          cursor: runActive ? "not-allowed" : "pointer",
          opacity: runActive ? 0.5 : 1,
          animation: runActive ? "executePulse 1.5s ease-in-out infinite" : "none",
        }}
      >
        {runActive ? "Running..." : "\u25B6 Execute"}
      </button>

      <style>{`
        @keyframes executePulse {
          0%, 100% { background-color: #3b82f6; }
          50% { background-color: #60a5fa; }
        }
      `}</style>

      {/* Divider */}
      <div style={{ borderTop: "1px solid var(--border)", margin: "4px 0" }} />

      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-muted)",
          marginBottom: 4,
        }}
      >
        Global Controls
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {paused ? (
          <ControlButton
            label="Resume All"
            onClick={() => onCommand({ type: "run:resume_all" })}
            color="var(--success)"
          />
        ) : (
          <ControlButton
            label="Pause All"
            onClick={() => onCommand({ type: "run:pause_all" })}
            color="var(--warning)"
          />
        )}
      </div>

      <div
        style={{
          borderTop: "1px solid var(--border)",
          paddingTop: 12,
          marginTop: 4,
        }}
      >
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
          Task Controls
        </div>

        {selectedTaskId == null ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
            Select a task to see controls
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
              Task #{selectedTaskId}
            </div>
            <ControlButton
              label="Pause"
              onClick={() =>
                onCommand({ type: "task:pause", taskId: selectedTaskId })
              }
              color="var(--warning)"
            />
            <ControlButton
              label="Resume"
              onClick={() =>
                onCommand({ type: "task:resume", taskId: selectedTaskId })
              }
              color="var(--success)"
            />
            <ControlButton
              label="Retry"
              onClick={() =>
                onCommand({ type: "task:retry", taskId: selectedTaskId })
              }
              color="var(--accent)"
            />
            <ControlButton
              label="Skip"
              onClick={() =>
                onCommand({ type: "task:skip", taskId: selectedTaskId })
              }
              color="var(--text-muted)"
            />
          </div>
        )}
      </div>
    </div>
  );
}
