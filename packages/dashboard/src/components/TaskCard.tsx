"use client";

import React from "react";

const STATE_COLORS: Record<string, string> = {
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

const STATE_LABELS: Record<string, string> = {
  pending: "Pending",
  spec: "Spec",
  executing: "Executing",
  reviewing: "Reviewing",
  done: "Done",
  merged: "Merged",
  failed: "Failed",
  skipped: "Skipped",
  paused: "Paused",
};

interface TaskCardProps {
  id: number;
  title: string;
  state: string;
  phase?: string;
  cost?: number;
  onClick?: () => void;
}

export default function TaskCard({ id, title, state, phase, cost, onClick }: TaskCardProps) {
  const stateColor = STATE_COLORS[state] ?? "#525252";

  return (
    <div
      onClick={onClick}
      style={{
        backgroundColor: "var(--bg-secondary)",
        border: `1px solid ${stateColor}44`,
        borderLeft: `3px solid ${stateColor}`,
        borderRadius: 6,
        padding: "10px 14px",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.2s, background-color 0.2s",
        minWidth: 180,
      }}
      onMouseEnter={(e) => {
        if (onClick) {
          e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
          e.currentTarget.style.borderColor = stateColor;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.backgroundColor = "var(--bg-secondary)";
        e.currentTarget.style.borderColor = `${stateColor}44`;
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontWeight: 500,
          }}
        >
          #{id}
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: stateColor,
            backgroundColor: `${stateColor}18`,
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          {STATE_LABELS[state] ?? state}
        </span>
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: "var(--text-primary)",
          lineHeight: 1.3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title || `Task ${id}`}
      </div>

      {(phase || cost !== undefined) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          {phase && (
            <span style={{ textTransform: "capitalize" }}>{phase}</span>
          )}
          {cost !== undefined && cost > 0 && (
            <span>${cost.toFixed(4)}</span>
          )}
        </div>
      )}
    </div>
  );
}

export { STATE_COLORS };
