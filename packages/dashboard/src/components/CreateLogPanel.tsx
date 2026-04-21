"use client";
import React, { useEffect, useRef, useState } from "react";
import type { StreamEvent } from "@/lib/streamParser";

interface Props {
  events: StreamEvent[];
  rawLogs: string[];
  expanded: boolean;
  onToggleExpand: () => void;
}

const TOOL_INPUT_PREVIEW_CHARS = 200;
const TEXT_PREVIEW_CHARS = 400;

function truncate(s: string, n: number): { preview: string; truncated: boolean } {
  if (s.length <= n) return { preview: s, truncated: false };
  return { preview: s.slice(0, n) + "…", truncated: true };
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function EventRow({ event }: { event: StreamEvent }) {
  const [expanded, setExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);

  const row: React.CSSProperties = {
    display: "flex",
    gap: 8,
    padding: "6px 8px",
    borderBottom: "1px solid var(--border)",
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    lineHeight: 1.5,
    alignItems: "flex-start",
  };

  const pill = (text: string, color: string): React.CSSProperties => ({
    color,
    fontWeight: 600,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    flexShrink: 0,
    minWidth: 68,
    paddingTop: 2,
  });

  const body: React.CSSProperties = {
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    flex: 1,
    minWidth: 0,
  };

  const clickableToggle: React.CSSProperties = {
    cursor: "pointer",
    color: "var(--accent)",
    fontSize: 11,
    marginLeft: 4,
    userSelect: "none",
  };

  switch (event.kind) {
    case "system_init":
      return (
        <div style={row}>
          <span style={pill("init", "var(--text-muted)")}>init</span>
          <span style={body}>
            {event.model} · session {event.sessionId.slice(0, 8)}
          </span>
        </div>
      );

    case "thinking": {
      const { preview, truncated } = truncate(event.text, TEXT_PREVIEW_CHARS);
      return (
        <div style={row}>
          <span style={pill("thinking", "#a855f7")}>thinking</span>
          <div style={body}>
            <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
              {showThinking ? event.text : preview}
            </span>
            {truncated && (
              <span onClick={() => setShowThinking((v) => !v)} style={clickableToggle}>
                {showThinking ? "[collapse]" : "[expand]"}
              </span>
            )}
          </div>
        </div>
      );
    }

    case "assistant_text": {
      const { preview, truncated } = truncate(event.text, TEXT_PREVIEW_CHARS);
      return (
        <div style={row}>
          <span style={pill("text", "var(--accent)")}>text</span>
          <div style={body}>
            <span style={{ color: "var(--text-primary)" }}>{expanded ? event.text : preview}</span>
            {truncated && (
              <span onClick={() => setExpanded((v) => !v)} style={clickableToggle}>
                {expanded ? "[collapse]" : "[expand]"}
              </span>
            )}
          </div>
        </div>
      );
    }

    case "tool_use": {
      const inputStr = formatInput(event.input);
      const { preview, truncated } = truncate(inputStr, TOOL_INPUT_PREVIEW_CHARS);
      return (
        <div style={row}>
          <span style={pill("tool", "#f59e0b")}>→ {event.name}</span>
          <div style={body}>
            <span style={{ color: "var(--text-secondary)" }}>
              {expanded ? inputStr : preview}
            </span>
            {truncated && (
              <span onClick={() => setExpanded((v) => !v)} style={clickableToggle}>
                {expanded ? "[collapse]" : "[expand]"}
              </span>
            )}
          </div>
        </div>
      );
    }

    case "tool_result": {
      const { preview, truncated } = truncate(event.content, TOOL_INPUT_PREVIEW_CHARS);
      return (
        <div style={row}>
          <span style={pill("result", event.isError ? "var(--error)" : "var(--success)")}>
            ← result
          </span>
          <div style={body}>
            <span style={{ color: event.isError ? "var(--error)" : "var(--text-secondary)" }}>
              {expanded ? event.content : preview}
            </span>
            {truncated && (
              <span onClick={() => setExpanded((v) => !v)} style={clickableToggle}>
                {expanded ? "[collapse]" : "[expand]"}
              </span>
            )}
          </div>
        </div>
      );
    }

    case "result":
      return (
        <div style={row}>
          <span style={pill("done", "var(--success)")}>done</span>
          <span style={body}>
            {(event.durationMs / 1000).toFixed(1)}s · ${event.cost.toFixed(4)}
          </span>
        </div>
      );

    case "raw":
      return (
        <div style={row}>
          <span style={pill("raw", "var(--text-muted)")}>raw</span>
          <span style={{ ...body, color: "var(--text-muted)" }}>{event.line}</span>
        </div>
      );
  }
}

export default function CreateLogPanel({ events, rawLogs, expanded, onToggleExpand }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events.length, rawLogs.length, showRaw]);

  const hasContent = events.length > 0 || rawLogs.length > 0;
  if (!hasContent) return null;

  const listStyle: React.CSSProperties = expanded
    ? {
        position: "fixed",
        inset: 24,
        zIndex: 1000,
        backgroundColor: "var(--bg-primary)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
      }
    : {
        backgroundColor: "var(--bg-primary)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        display: "flex",
        flexDirection: "column",
      };

  return (
    <>
      {expanded && (
        <div
          onClick={onToggleExpand}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.4)",
            zIndex: 999,
          }}
        />
      )}
      <div style={listStyle}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "6px 10px",
            borderBottom: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <span>
            {showRaw ? `${rawLogs.length} raw line${rawLogs.length === 1 ? "" : "s"}` : `${events.length} event${events.length === 1 ? "" : "s"}`}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setShowRaw((v) => !v)}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                borderRadius: 3,
                padding: "2px 8px",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              {showRaw ? "events" : "raw"}
            </button>
            <button
              onClick={onToggleExpand}
              style={{
                background: "none",
                border: "1px solid var(--border)",
                color: "var(--text-muted)",
                borderRadius: 3,
                padding: "2px 8px",
                fontSize: 10,
                cursor: "pointer",
              }}
            >
              {expanded ? "collapse" : "expand"}
            </button>
          </div>
        </div>
        <div
          ref={scrollRef}
          style={{
            flex: expanded ? 1 : undefined,
            maxHeight: expanded ? undefined : 280,
            overflowY: "auto",
          }}
        >
          {showRaw ? (
            <div
              style={{
                padding: 8,
                fontFamily: "'SF Mono', 'Fira Code', monospace",
                fontSize: 11,
                color: "var(--text-muted)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {rawLogs.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
          ) : events.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: "var(--text-muted)", textAlign: "center" }}>
              Waiting for agent output...
            </div>
          ) : (
            events.map((e) => <EventRow key={e.seq} event={e} />)
          )}
        </div>
      </div>
    </>
  );
}
