"use client";

import React, { useState, useMemo } from "react";

interface SkillEditorProps {
  skillName: string;
  content: string;
  onSave: (content: string) => void;
  activeTab?: string;
  onSetActive?: () => void;
}

export default function SkillEditor({
  skillName,
  content,
  onSave,
  activeTab = "active",
  onSetActive,
}: SkillEditorProps) {
  const [draft, setDraft] = useState(content);
  const [saved, setSaved] = useState(false);

  // Reset draft when content or tab changes
  const [prevContent, setPrevContent] = useState(content);
  const [prevTab, setPrevTab] = useState(activeTab);
  if (content !== prevContent || activeTab !== prevTab) {
    setPrevContent(content);
    setPrevTab(activeTab);
    setDraft(content);
    setSaved(false);
  }

  const isDirty = draft !== content;

  const stats = useMemo(() => {
    const lines = draft.split("\n").length;
    const chars = draft.length;
    return { lines, chars };
  }, [draft]);

  const handleSave = () => {
    onSave(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const fileLabel =
    activeTab === "active"
      ? `${skillName}/SKILL.md`
      : `${skillName}/SKILL.${activeTab}.md`;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        gap: 0,
        height: "100%",
      }}
    >
      {/* Editor header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          backgroundColor: "var(--bg-secondary)",
          borderBottom: "1px solid var(--border)",
          borderTopLeftRadius: 8,
          borderTopRightRadius: 8,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
            fontFamily:
              "'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', Menlo, Monaco, Consolas, monospace",
          }}
        >
          {fileLabel}
        </span>
        {isDirty && (
          <span
            style={{ fontSize: 11, color: "var(--warning)", fontWeight: 500 }}
          >
            Unsaved changes
          </span>
        )}
      </div>

      {/* Textarea */}
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        style={{
          flex: 1,
          resize: "none",
          backgroundColor: "var(--bg-primary)",
          color: "var(--text-primary)",
          border: "none",
          borderLeft: "1px solid var(--border)",
          borderRight: "1px solid var(--border)",
          padding: 16,
          fontSize: 13,
          lineHeight: 1.6,
          fontFamily:
            "'SF Mono', 'Fira Code', 'Fira Mono', 'Roboto Mono', Menlo, Monaco, Consolas, monospace",
          outline: "none",
          tabSize: 2,
        }}
      />

      {/* Footer */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 16px",
          backgroundColor: "var(--bg-secondary)",
          borderTop: "1px solid var(--border)",
          borderBottomLeftRadius: 8,
          borderBottomRightRadius: 8,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {stats.lines} lines, {stats.chars} chars
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          {onSetActive && (
            <button
              onClick={onSetActive}
              style={{
                backgroundColor: "color-mix(in srgb, var(--success) 20%, transparent)",
                color: "var(--success)",
                border: "1px solid color-mix(in srgb, var(--success) 40%, transparent)",
                borderRadius: 4,
                padding: "6px 16px",
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                transition: "background-color 0.15s",
              }}
            >
              Set Active
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty && !saved}
            style={{
              backgroundColor: saved
                ? "color-mix(in srgb, var(--success) 20%, transparent)"
                : isDirty
                  ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                  : "var(--bg-tertiary)",
              color: saved
                ? "var(--success)"
                : isDirty
                  ? "var(--accent)"
                  : "var(--text-muted)",
              border: `1px solid ${
                saved
                  ? "color-mix(in srgb, var(--success) 40%, transparent)"
                  : isDirty
                    ? "color-mix(in srgb, var(--accent) 40%, transparent)"
                    : "var(--border)"
              }`,
              borderRadius: 4,
              padding: "6px 16px",
              fontSize: 12,
              fontWeight: 500,
              cursor: isDirty ? "pointer" : "default",
              transition: "background-color 0.15s",
              opacity: !isDirty && !saved ? 0.5 : 1,
            }}
          >
            {saved ? "Saved" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
