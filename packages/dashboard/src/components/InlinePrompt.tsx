"use client";
import React, { useState } from "react";

interface InlinePromptProps {
  taskId: number;
  onSubmit: (prompt: string, threadMode: "continue" | "new") => void;
  lastResponse?: string;
}

export default function InlinePrompt({ taskId, onSubmit, lastResponse }: InlinePromptProps) {
  const [prompt, setPrompt] = useState("");
  const [threadMode, setThreadMode] = useState<"continue" | "new">("continue");

  const handleSubmit = () => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    onSubmit(trimmed, threadMode);
    setPrompt("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const pillStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--accent)" : "transparent",
    border: active ? "1px solid var(--accent)" : "1px solid var(--border)",
    color: active ? "#fff" : "var(--text-muted)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "2px 8px",
    borderRadius: 9999,
    cursor: "pointer",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
      {/* Input row */}
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a prompt to this task's agent..."
          style={{
            flex: 1,
            backgroundColor: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 12,
            color: "var(--text-primary)",
            outline: "none",
          }}
        />
        <button
          onClick={handleSubmit}
          style={{
            backgroundColor: "var(--accent)",
            border: "none",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 4,
            fontSize: 12,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          →
        </button>
      </div>

      {/* Thread mode toggle */}
      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
        <button style={pillStyle(threadMode === "continue")} onClick={() => setThreadMode("continue")}>
          Continue
        </button>
        <button style={pillStyle(threadMode === "new")} onClick={() => setThreadMode("new")}>
          New Thread
        </button>
      </div>

      {/* Last response */}
      {lastResponse && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            borderLeft: "2px solid var(--accent)",
            paddingLeft: 10,
            marginTop: 8,
            maxHeight: 120,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            lineHeight: 1.5,
          }}
        >
          {lastResponse}
        </div>
      )}
    </div>
  );
}
