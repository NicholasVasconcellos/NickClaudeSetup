"use client";

import React, { useState } from "react";
import ContextBar from "./ContextBar";

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
  description?: string;
  milestone?: string | null;
  dependsOn?: number[];
  state: string;
  phase?: string;
  cost?: number;
  contextPercentage?: number;
  onClick?: () => void;
}

export default function TaskCard({ id, title, description, milestone, dependsOn, state, phase, cost, contextPercentage, onClick }: TaskCardProps) {
  const stateColor = STATE_COLORS[state] ?? "#525252";
  const [hovered, setHovered] = useState(false);

  const tooltipText = [
    title,
    description ? description.split("\n").slice(0, 3).join("\n") : null,
    milestone ? `Milestone: ${milestone}` : null,
    dependsOn && dependsOn.length > 0 ? `Depends on: ${dependsOn.map(d => `#${d}`).join(", ")}` : null,
  ].filter(Boolean).join("\n\n");

  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) => {
        setHovered(true);
        if (onClick) {
          e.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
          e.currentTarget.style.borderColor = stateColor;
        }
      }}
      onMouseLeave={(e) => {
        setHovered(false);
        e.currentTarget.style.backgroundColor = "var(--bg-secondary)";
        e.currentTarget.style.borderColor = `${stateColor}44`;
      }}
      style={{
        position: "relative",
        backgroundColor: "var(--bg-secondary)",
        border: `1px solid ${stateColor}44`,
        borderLeft: `3px solid ${stateColor}`,
        borderRadius: 6,
        padding: "10px 14px",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color 0.2s, background-color 0.2s",
        minWidth: 180,
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

      {(phase || (cost !== undefined && cost > 0)) && (
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

      {contextPercentage !== undefined && contextPercentage > 0 && (
        <div style={{ marginTop: 6 }}>
          <ContextBar percentage={contextPercentage} tokensUsed={0} contextLimit={0} compact />
        </div>
      )}

      {/* Hover tooltip */}
      {hovered && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            bottom: "calc(100% + 8px)",
            transform: "translateX(-50%)",
            backgroundColor: "var(--bg-secondary, #1a1a1a)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "12px 16px",
            minWidth: 260,
            maxWidth: 360,
            zIndex: 100,
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            pointerEvents: "none",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
            #{id} {title}
          </div>
          {description && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, whiteSpace: "pre-wrap", marginBottom: 6 }}>
              {description.split("\n").slice(0, 4).join("\n")}
            </div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 11, color: "var(--text-muted)" }}>
            {milestone && <span>Milestone: {milestone}</span>}
            {dependsOn && dependsOn.length > 0 && (
              <span>Deps: {dependsOn.map(d => `#${d}`).join(", ")}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { STATE_COLORS };
