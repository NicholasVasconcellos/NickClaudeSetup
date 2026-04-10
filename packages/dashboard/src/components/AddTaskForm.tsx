"use client";
import React, { useState, useEffect } from "react";

interface AddTaskFormProps {
  existingTasks: Map<number, { title?: string; state: string }>;
  onCreateTask: (task: {
    title: string;
    description: string;
    dependsOn: number[];
    milestone?: string;
    effort?: string;
  }) => void;
  onClose: () => void;
}

export default function AddTaskForm({
  existingTasks,
  onCreateTask,
  onClose,
}: AddTaskFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [milestone, setMilestone] = useState("");
  const [effort, setEffort] = useState("");
  const [dependsOn, setDependsOn] = useState<Set<number>>(new Set());
  const [titleError, setTitleError] = useState(false);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSubmit = () => {
    if (!title.trim()) {
      setTitleError(true);
      return;
    }
    onCreateTask({
      title: title.trim(),
      description: description.trim(),
      dependsOn: Array.from(dependsOn),
      ...(milestone.trim() ? { milestone: milestone.trim() } : {}),
      ...(effort ? { effort } : {}),
    });
  };

  const toggleDep = (id: number) => {
    setDependsOn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const inputStyle = (field: string, error = false): React.CSSProperties => ({
    backgroundColor: "var(--bg-tertiary)",
    border: `1px solid ${error ? "#ef4444" : focusedField === field ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 4,
    padding: "8px 12px",
    fontSize: 13,
    color: "var(--text-primary)",
    outline: "none",
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "inherit",
  });

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 4,
    display: "block",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--bg-secondary)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          maxWidth: 560,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Create Task
        </div>

        {/* Title */}
        <div>
          <label style={labelStyle}>Title *</label>
          <input
            type="text"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (e.target.value.trim()) setTitleError(false);
            }}
            onFocus={() => setFocusedField("title")}
            onBlur={() => setFocusedField(null)}
            style={inputStyle("title", titleError)}
            placeholder="Task title"
          />
        </div>

        {/* Description */}
        <div>
          <label style={labelStyle}>Description</label>
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onFocus={() => setFocusedField("description")}
            onBlur={() => setFocusedField(null)}
            style={{ ...inputStyle("description"), resize: "vertical" }}
            placeholder="What should this task accomplish?"
          />
        </div>

        {/* Milestone */}
        <div>
          <label style={labelStyle}>Milestone</label>
          <input
            type="text"
            value={milestone}
            onChange={(e) => setMilestone(e.target.value)}
            onFocus={() => setFocusedField("milestone")}
            onBlur={() => setFocusedField(null)}
            style={inputStyle("milestone")}
            placeholder="Optional milestone"
          />
        </div>

        {/* Effort */}
        <div>
          <label style={labelStyle}>Effort</label>
          <select
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
            onFocus={() => setFocusedField("effort")}
            onBlur={() => setFocusedField(null)}
            style={{ ...inputStyle("effort"), cursor: "pointer" }}
          >
            <option value="">--</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="max">Max</option>
          </select>
        </div>

        {/* Dependencies */}
        {existingTasks.size > 0 && (
          <div>
            <label style={labelStyle}>Dependencies</label>
            <div
              style={{
                maxHeight: 200,
                overflowY: "auto",
                backgroundColor: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "4px 0",
              }}
            >
              {Array.from(existingTasks.entries()).map(([id, task]) => (
                <label
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 12px",
                    cursor: "pointer",
                    fontSize: 13,
                    color: "var(--text-secondary)",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={dependsOn.has(id)}
                    onChange={() => toggleDep(id)}
                    style={{ accentColor: "var(--accent)" }}
                  />
                  <span style={{ color: "var(--text-muted)" }}>#{id}</span>
                  {task.title ?? `Task ${id}`}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Buttons */}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 4,
          }}
        >
          <button
            onClick={onClose}
            onMouseEnter={() => setHovered("cancel")}
            onMouseLeave={() => setHovered(null)}
            style={{
              backgroundColor: hovered === "cancel" ? "var(--bg-tertiary)" : "transparent",
              color: "var(--text-muted)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            onMouseEnter={() => setHovered("create")}
            onMouseLeave={() => setHovered(null)}
            style={{
              backgroundColor: hovered === "create" ? "var(--accent)" : "var(--accent)dd",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              padding: "6px 16px",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Create Task
          </button>
        </div>
      </div>
    </div>
  );
}
