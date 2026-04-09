"use client";

import React, { useEffect, useRef } from "react";

interface LogViewerProps {
  logs: string[];
  maxHeight?: number;
}

export default function LogViewer({ logs, maxHeight = 400 }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    // Auto-scroll if user is near the bottom (within 50px)
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScrollRef.current = nearBottom;
  };

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      style={{
        backgroundColor: "#0d0d0d",
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: "12px 16px",
        maxHeight,
        overflowY: "auto",
        fontFamily:
          '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", Menlo, Monaco, Consolas, monospace',
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {logs.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
          No log output yet...
        </div>
      ) : (
        logs.map((line, i) => (
          <div
            key={i}
            style={{
              color: line.includes("ERROR") || line.includes("error")
                ? "var(--error)"
                : line.includes("WARN") || line.includes("warn")
                  ? "var(--warning)"
                  : line.includes("SUCCESS") || line.includes("success")
                    ? "var(--success)"
                    : "var(--text-secondary)",
              borderBottom: "1px solid #1a1a1a",
              padding: "1px 0",
            }}
          >
            <span style={{ color: "var(--text-muted)", marginRight: 8, userSelect: "none" }}>
              {String(i + 1).padStart(4, " ")}
            </span>
            {line}
          </div>
        ))
      )}
    </div>
  );
}
