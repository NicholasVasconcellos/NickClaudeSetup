"use client";
import React, { useState } from "react";

interface ReviewData {
  taskId: number;
  gitDiff: string;
  agentLogSummary: string;
}

interface ReviewPanelProps {
  review: ReviewData;
  taskTitle?: string;
  onApprove: (taskId: number) => void;
  onReject: (taskId: number) => void;
  onClose: () => void;
}

function DiffLine({ line }: { line: string }) {
  let color = "var(--text-secondary)";
  if (line.startsWith("+")) color = "#22c55e";
  else if (line.startsWith("-")) color = "#ef4444";
  else if (line.startsWith("@@")) color = "#06b6d4";
  else if (line.startsWith("diff") || line.startsWith("index")) color = "var(--text-muted)";
  return <div style={{ color }}>{line}</div>;
}

export default function ReviewPanel({ review, taskTitle, onApprove, onReject, onClose }: ReviewPanelProps) {
  const [tab, setTab] = useState<"diff" | "log">("diff");

  const tabStyle = (active: boolean): React.CSSProperties => ({
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "6px 12px",
    background: "none",
    border: "none",
    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
    color: active ? "var(--accent)" : "var(--text-muted)",
    cursor: "pointer",
    fontWeight: 600,
  });

  const preBlockStyle: React.CSSProperties = {
    backgroundColor: "#0d0d0d",
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 1.6,
    padding: 12,
    borderRadius: 6,
    maxHeight: 400,
    overflowY: "auto",
    margin: 0,
    whiteSpace: "pre",
    overflowX: "auto",
  };

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
        gap: 12,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
          Review Task #{review.taskId}{taskTitle ? ` \u2014 ${taskTitle}` : ""}
        </span>
        <button
          onClick={onClose}
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
          X
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)" }}>
        <button style={tabStyle(tab === "diff")} onClick={() => setTab("diff")}>Diff</button>
        <button style={tabStyle(tab === "log")} onClick={() => setTab("log")}>Agent Log</button>
      </div>

      {/* Content */}
      {tab === "diff" ? (
        <pre style={preBlockStyle}>
          {review.gitDiff.split("\n").map((line, i) => (
            <DiffLine key={i} line={line} />
          ))}
        </pre>
      ) : (
        <pre style={{ ...preBlockStyle, color: "var(--text-secondary)" }}>
          {review.agentLogSummary}
        </pre>
      )}

      {/* Actions */}
      <div style={{ display: "flex", gap: 12 }}>
        <button
          onClick={() => onApprove(review.taskId)}
          style={{
            flex: 1,
            padding: "10px 0",
            backgroundColor: "var(--success)",
            color: "#000",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Approve &amp; Merge
        </button>
        <button
          onClick={() => onReject(review.taskId)}
          style={{
            flex: 1,
            padding: "10px 0",
            backgroundColor: "transparent",
            color: "var(--error)",
            border: "1px solid var(--error)",
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Reject &amp; Retry
        </button>
      </div>
    </div>
  );
}
