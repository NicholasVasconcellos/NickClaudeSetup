"use client";
import React, { useState, useRef, useCallback } from "react";

interface PlanEditorProps {
  onLoadPlan: (markdown: string) => void;
  planLoaded: boolean;
  taskCount?: number;
}

export default function PlanEditor({ onLoadPlan, planLoaded, taskCount }: PlanEditorProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [content, setContent] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [loadHover, setLoadHover] = useState(false);
  const [uploadHover, setUploadHover] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileRead = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string") setContent(text);
    };
    reader.readAsText(file);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileRead(file);
      // Reset so the same file can be re-selected
      e.target.value = "";
    },
    [handleFileRead],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (file) handleFileRead(file);
    },
    [handleFileRead],
  );

  const handleLoad = useCallback(() => {
    if (content.trim()) onLoadPlan(content);
  }, [content, onLoadPlan]);

  const accentColor = "var(--accent)";

  return (
    <div
      style={{
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {/* Header */}
      <button
        onClick={() => setCollapsed((p) => !p)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "10px 16px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          textAlign: "left",
        }}
      >
        <span style={{ fontSize: 10 }}>{collapsed ? "\u25B8" : "\u25BE"}</span>
        Plan
      </button>

      {/* Body */}
      {!collapsed && (
        <div style={{ padding: "0 16px 16px" }}>
          {/* Textarea with drag-and-drop */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
              position: "relative",
              border: dragOver
                ? "2px dashed var(--accent)"
                : "1px solid var(--border)",
              borderRadius: 6,
              backgroundColor: "#0d0d0d",
              transition: "border 0.15s",
            }}
          >
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste or drop a markdown plan here..."
              style={{
                width: "100%",
                minHeight: 300,
                padding: 12,
                backgroundColor: "transparent",
                color: "var(--text-primary)",
                border: "none",
                outline: "none",
                resize: "vertical",
                fontFamily: "'SF Mono', 'Fira Code', monospace",
                fontSize: 13,
                lineHeight: 1.5,
                boxSizing: "border-box",
              }}
            />
            {/* Drag overlay */}
            {dragOver && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "rgba(59,130,246,0.08)",
                  borderRadius: 6,
                  pointerEvents: "none",
                  color: "var(--accent)",
                  fontSize: 13,
                  fontWeight: 500,
                }}
              >
                Drop .md file here
              </div>
            )}
          </div>

          {/* Footer row: char count, buttons, success indicator */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: 10,
              gap: 10,
            }}
          >
            {/* Left: buttons */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.markdown,.txt"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                onMouseEnter={() => setUploadHover(true)}
                onMouseLeave={() => setUploadHover(false)}
                style={{
                  backgroundColor: uploadHover ? "var(--bg-tertiary)" : "transparent",
                  color: "var(--text-secondary)",
                  border: "1px solid var(--border)",
                  borderRadius: 4,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: "pointer",
                  transition: "background-color 0.15s",
                }}
              >
                Upload .md
              </button>
              <button
                onClick={handleLoad}
                disabled={!content.trim()}
                onMouseEnter={() => setLoadHover(true)}
                onMouseLeave={() => setLoadHover(false)}
                style={{
                  backgroundColor: !content.trim()
                    ? "var(--bg-tertiary)"
                    : loadHover
                      ? `${accentColor}30`
                      : `${accentColor}20`,
                  color: !content.trim() ? "var(--text-muted)" : accentColor,
                  border: `1px solid ${!content.trim() ? "var(--border)" : `${accentColor}40`}`,
                  borderRadius: 4,
                  padding: "6px 12px",
                  fontSize: 12,
                  fontWeight: 500,
                  cursor: !content.trim() ? "not-allowed" : "pointer",
                  transition: "background-color 0.15s",
                  opacity: !content.trim() ? 0.5 : 1,
                }}
              >
                Load Plan
              </button>

              {/* Success indicator */}
              {planLoaded && (
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--success)",
                    fontWeight: 500,
                  }}
                >
                  {"\u2713"} {taskCount} tasks loaded
                </span>
              )}
            </div>

            {/* Right: char count */}
            <span
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                flexShrink: 0,
              }}
            >
              {content.length.toLocaleString()} chars
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
