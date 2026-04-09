"use client";

import React from "react";

interface ControlsProps {
  selectedTaskId?: number;
  onCommand: (cmd: { type: string; taskId?: number }) => void;
  paused: boolean;
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

export default function Controls({ selectedTaskId, onCommand, paused }: ControlsProps) {
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
            onClick={() => onCommand({ type: "command:resume_all" })}
            color="var(--success)"
          />
        ) : (
          <ControlButton
            label="Pause All"
            onClick={() => onCommand({ type: "command:pause_all" })}
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
                onCommand({ type: "command:pause_task", taskId: selectedTaskId })
              }
              color="var(--warning)"
            />
            <ControlButton
              label="Resume"
              onClick={() =>
                onCommand({ type: "command:resume_task", taskId: selectedTaskId })
              }
              color="var(--success)"
            />
            <ControlButton
              label="Retry"
              onClick={() =>
                onCommand({ type: "command:retry_task", taskId: selectedTaskId })
              }
              color="var(--accent)"
            />
            <ControlButton
              label="Skip"
              onClick={() =>
                onCommand({ type: "command:skip_task", taskId: selectedTaskId })
              }
              color="var(--text-muted)"
            />
          </div>
        )}
      </div>
    </div>
  );
}
