"use client";
import React, { useState, useEffect, useRef, useCallback } from "react";
import type { PlanningAgentUsage, ProjectCreateState, ProjectCreateStage } from "@/hooks/useWebSocket";
import CreateLogPanel from "./CreateLogPanel";

function PlanningMetrics({ usage }: { usage: PlanningAgentUsage }) {
  const hasData =
    usage.live || usage.tokensIn > 0 || usage.tokensOut > 0 || usage.cost > 0 || usage.model;
  if (!hasData) return null;

  const pct = usage.contextPercentage;
  const barColor = pct >= 90 ? "var(--error)" : pct >= 70 ? "#f59e0b" : "var(--accent)";
  const total = usage.tokensIn + usage.tokensOut;
  const fmt = (n: number) => n.toLocaleString();

  const cell: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
  const label: React.CSSProperties = {
    fontSize: 10,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };
  const value: React.CSSProperties = {
    fontSize: 12,
    color: "var(--text-primary)",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
  };

  return (
    <div
      style={{
        backgroundColor: "var(--bg-tertiary)",
        border: "1px solid var(--border)",
        borderRadius: 4,
        padding: "8px 10px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: 10,
        }}
      >
        <div style={cell}>
          <span style={label}>Model</span>
          <span style={{ ...value, fontSize: 11 }} title={usage.model ?? ""}>
            {usage.model?.replace(/^claude-/, "") ?? "—"}
            {usage.effort ? ` · ${usage.effort}` : ""}
          </span>
        </div>
        <div style={cell}>
          <span style={label}>Tokens in</span>
          <span style={value}>{fmt(usage.tokensIn)}</span>
        </div>
        <div style={cell}>
          <span style={label}>Tokens out</span>
          <span style={value}>{fmt(usage.tokensOut)}</span>
        </div>
        <div style={cell}>
          <span style={label}>Cost</span>
          <span style={value}>${usage.cost.toFixed(4)}</span>
        </div>
        <div style={cell}>
          <span style={label}>Subagents</span>
          <span style={value}>
            {usage.subagentCount}
            {usage.live && (
              <span style={{ color: "var(--text-muted)", marginLeft: 4, fontSize: 10 }}>live</span>
            )}
          </span>
        </div>
      </div>
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 10,
            color: "var(--text-muted)",
            marginBottom: 3,
          }}
        >
          <span>Context</span>
          <span>
            {fmt(total)} / {fmt(usage.contextLimit)} ({pct.toFixed(1)}%)
          </span>
        </div>
        <div
          style={{
            height: 4,
            backgroundColor: "var(--bg-primary)",
            borderRadius: 2,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.min(100, pct)}%`,
              height: "100%",
              backgroundColor: barColor,
              transition: "width 0.3s ease, background-color 0.3s",
            }}
          />
        </div>
      </div>
    </div>
  );
}

interface ProjectInfo {
  name: string;
  path: string;
  taskCount: number;
  lastModified: string;
}

interface ProjectSetupProps {
  connected: boolean;
  projectList: ProjectInfo[];
  onCreateProject: (projectName: string, baseDir: string, planMarkdown?: string, planPath?: string) => void;
  onListProjects: (baseDir: string) => void;
  createError: string | null;
  createState: ProjectCreateState;
}

const STAGE_ORDER: ProjectCreateStage[] = ["scaffolding", "scaffolded", "parsing_plan", "plan_parsed", "done"];
const STAGE_LABEL: Record<ProjectCreateStage, string> = {
  scaffolding: "Scaffolding",
  scaffolded: "Scaffolded",
  parsing_plan: "Parsing plan (ultrathink)",
  plan_parsed: "Plan parsed",
  done: "Done",
};

type Tab = "create" | "open";

const NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  marginBottom: 4,
  display: "block",
};

const inputStyle = (focused: boolean, error = false): React.CSSProperties => ({
  backgroundColor: "var(--bg-tertiary)",
  border: `1px solid ${error ? "var(--error)" : focused ? "var(--accent)" : "var(--border)"}`,
  borderRadius: 4,
  padding: "8px 12px",
  fontSize: 13,
  color: "var(--text-primary)",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  fontFamily: "inherit",
});

export default function ProjectSetup({
  connected,
  projectList,
  onCreateProject,
  onListProjects,
  createError,
  createState,
}: ProjectSetupProps) {
  const [tab, setTab] = useState<Tab>("create");
  const [projectName, setProjectName] = useState("");
  const [baseDir, setBaseDir] = useState("~/Developer");
  const [planContent, setPlanContent] = useState("");
  const [planPath, setPlanPath] = useState("");
  const [skipPlan, setSkipPlan] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // List projects when switching to open tab or on mount if open tab
  useEffect(() => {
    if (tab === "open" && baseDir.trim()) {
      onListProjects(baseDir.trim());
    }
  }, [tab, baseDir, onListProjects]);

  // --- File handling (mirrors PlanEditor) ---
  const handleFileRead = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result;
      if (typeof text === "string") {
        setPlanContent(text);
        setSkipPlan(false);
      }
    };
    reader.readAsText(file);
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileRead(file);
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

  // --- Validation ---
  const validateName = useCallback((name: string): string | null => {
    if (!name.trim()) return "Project name is required";
    if (!NAME_REGEX.test(name)) return "Must start with alphanumeric; only letters, numbers, hyphens, dots, underscores";
    return null;
  }, []);

  const handleCreate = useCallback(() => {
    const err = validateName(projectName);
    if (err) {
      setNameError(err);
      return;
    }
    if (skipPlan) {
      onCreateProject(projectName.trim(), baseDir.trim(), undefined, undefined);
      return;
    }
    const trimmedPath = planPath.trim();
    if (trimmedPath) {
      onCreateProject(projectName.trim(), baseDir.trim(), undefined, trimmedPath);
      return;
    }
    const plan = planContent.trim() || undefined;
    onCreateProject(projectName.trim(), baseDir.trim(), plan, undefined);
  }, [projectName, baseDir, planContent, planPath, skipPlan, validateName, onCreateProject]);

  // --- Relative date formatting ---
  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      if (diffMins < 1) return "just now";
      if (diffMins < 60) return `${diffMins}m ago`;
      const diffHours = Math.floor(diffMins / 60);
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays < 30) return `${diffDays}d ago`;
      return d.toLocaleDateString();
    } catch {
      return iso;
    }
  };

  const creating = createState.active;
  const canCreate = !creating && projectName.trim() && baseDir.trim() && !validateName(projectName);
  const [logExpanded, setLogExpanded] = useState(false);

  const stageIndex = createState.stage ? STAGE_ORDER.indexOf(createState.stage) : -1;
  const showCreatePanel =
    creating ||
    createState.logs.length > 0 ||
    createState.events.length > 0 ||
    createState.error ||
    createState.stage === "done";

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "var(--bg-primary)",
        padding: 24,
      }}
    >
      <div
        style={{
          maxWidth: 600,
          width: "100%",
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: "var(--text-primary)",
              marginBottom: 6,
            }}
          >
            Orchestrator Dashboard
          </div>
          <div
            style={{
              fontSize: 13,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: connected ? "var(--success)" : "var(--error)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
            {connected ? "Connected" : "Disconnected"}
          </div>
        </div>

        {/* Card */}
        <div
          style={{
            backgroundColor: "var(--bg-secondary)",
            border: "1px solid var(--border)",
            borderRadius: 12,
            overflow: "hidden",
          }}
        >
          {/* Tabs */}
          <div
            style={{
              display: "flex",
              borderBottom: "1px solid var(--border)",
            }}
          >
            {(["create", "open"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                onMouseEnter={() => setHovered(`tab-${t}`)}
                onMouseLeave={() => setHovered(null)}
                style={{
                  flex: 1,
                  padding: "12px 0",
                  background: "none",
                  border: "none",
                  borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
                  color: tab === t ? "var(--text-primary)" : "var(--text-muted)",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                  ...(hovered === `tab-${t}` && tab !== t ? { color: "var(--text-secondary)" } : {}),
                }}
              >
                {t === "create" ? "Create New" : "Open Existing"}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
            {tab === "create" ? (
              <>
                {/* Project Name */}
                <div>
                  <label style={labelStyle}>Project Name *</label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => {
                      setProjectName(e.target.value);
                      if (nameError) setNameError(validateName(e.target.value));
                    }}
                    onBlur={() => {
                      setFocusedField(null);
                      if (projectName.trim()) setNameError(validateName(projectName));
                    }}
                    onFocus={() => setFocusedField("name")}
                    style={inputStyle(focusedField === "name", !!nameError)}
                    placeholder="my-project"
                  />
                  {nameError && (
                    <div style={{ fontSize: 11, color: "var(--error)", marginTop: 4 }}>
                      {nameError}
                    </div>
                  )}
                </div>

                {/* Project Directory */}
                <div>
                  <label style={labelStyle}>Project Directory</label>
                  <input
                    type="text"
                    value={baseDir}
                    onChange={(e) => setBaseDir(e.target.value)}
                    onFocus={() => setFocusedField("baseDir")}
                    onBlur={() => setFocusedField(null)}
                    style={inputStyle(focusedField === "baseDir")}
                    placeholder="~/Developer/my-project"
                  />
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Scaffold is written directly here — no extra subfolder is created.
                  </div>
                </div>

                {/* Plan section */}
                <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 6,
                    }}
                  >
                    <label style={{ ...labelStyle, marginBottom: 0 }}>Plan (Markdown)</label>
                    <label
                      style={{
                        fontSize: 12,
                        color: "var(--text-muted)",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: "pointer",
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={skipPlan}
                        onChange={(e) => setSkipPlan(e.target.checked)}
                        style={{ accentColor: "var(--accent)" }}
                      />
                      Skip — I'll add a plan later
                    </label>
                  </div>

                  {!skipPlan && (
                    <>
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
                          value={planContent}
                          onChange={(e) => setPlanContent(e.target.value)}
                          placeholder="Paste or drop a markdown plan here..."
                          onFocus={() => setFocusedField("plan")}
                          onBlur={() => setFocusedField(null)}
                          style={{
                            width: "100%",
                            minHeight: 180,
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

                      {/* Plan footer */}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginTop: 8,
                        }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept=".md,.markdown,.txt"
                            onChange={handleFileChange}
                            style={{ display: "none" }}
                          />
                          <button
                            onClick={() => fileInputRef.current?.click()}
                            onMouseEnter={() => setHovered("upload")}
                            onMouseLeave={() => setHovered(null)}
                            style={{
                              backgroundColor: hovered === "upload" ? "var(--bg-tertiary)" : "transparent",
                              color: "var(--text-secondary)",
                              border: "1px solid var(--border)",
                              borderRadius: 4,
                              padding: "5px 10px",
                              fontSize: 12,
                              fontWeight: 500,
                              cursor: "pointer",
                              transition: "background-color 0.15s",
                            }}
                          >
                            Upload .md
                          </button>
                        </div>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          {planContent.length.toLocaleString()} chars
                        </span>
                      </div>

                      {/* Plan File Path input */}
                      <div style={{ marginTop: 12 }}>
                        <label style={labelStyle}>Plan File Path (optional)</label>
                        <input
                          type="text"
                          value={planPath}
                          onChange={(e) => setPlanPath(e.target.value)}
                          onFocus={() => setFocusedField("planPath")}
                          onBlur={() => setFocusedField(null)}
                          style={inputStyle(focusedField === "planPath")}
                          placeholder="~/Desktop/plan.md"
                        />
                        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                          If set, this path is used instead of the pasted text.
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Progress panel (create in flight / completed / errored) */}
                {showCreatePanel && (
                  <div
                    style={{
                      backgroundColor: "var(--bg-primary)",
                      border: `1px solid ${createState.error ? "var(--error)" : "var(--border)"}`,
                      borderRadius: 6,
                      padding: 12,
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    {/* Stage header */}
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      {creating && (
                        <span
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: "50%",
                            border: "2px solid var(--accent)",
                            borderTopColor: "transparent",
                            animation: "spin 0.8s linear infinite",
                            display: "inline-block",
                          }}
                        />
                      )}
                      <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                        {createState.projectName
                          ? `${createState.error ? "Failed creating" : creating ? "Creating" : "Created"} ${createState.projectName}`
                          : "Project creation"}
                      </span>
                    </div>

                    {/* Stage steps */}
                    <div style={{ display: "flex", gap: 4, fontSize: 11, flexWrap: "wrap" }}>
                      {STAGE_ORDER.slice(0, 4).map((s, idx) => {
                        const reached = stageIndex >= idx;
                        const isCurrent = stageIndex === idx && creating;
                        return (
                          <span
                            key={s}
                            style={{
                              padding: "3px 8px",
                              borderRadius: 10,
                              border: `1px solid ${reached ? "var(--accent)" : "var(--border)"}`,
                              color: reached ? "var(--accent)" : "var(--text-muted)",
                              backgroundColor: isCurrent ? "rgba(59,130,246,0.1)" : "transparent",
                              fontWeight: isCurrent ? 600 : 400,
                            }}
                          >
                            {STAGE_LABEL[s]}
                          </span>
                        );
                      })}
                    </div>

                    {/* Current stage message */}
                    {createState.message && (
                      <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                        {createState.message}
                      </div>
                    )}

                    {/* Planning agent metrics (live cost / tokens / context) */}
                    <PlanningMetrics usage={createState.planningUsage} />

                    {/* Live agent events (parsed stream-json) */}
                    <CreateLogPanel
                      events={createState.events}
                      rawLogs={createState.logs}
                      expanded={logExpanded}
                      onToggleExpand={() => setLogExpanded((v) => !v)}
                    />


                    {/* Error detail */}
                    {createState.error && (
                      <div
                        style={{
                          fontSize: 12,
                          color: "var(--error)",
                          backgroundColor: "rgba(239,68,68,0.08)",
                          border: "1px solid var(--error)",
                          borderRadius: 4,
                          padding: "8px 10px",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {createState.error.kind === "collision" && createState.error.projectDir && (
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>
                            A project already exists at that path.
                          </div>
                        )}
                        {createState.error.kind === "concurrent" && (
                          <div style={{ marginBottom: 6, fontWeight: 600 }}>
                            Another create is already running.
                          </div>
                        )}
                        {createState.error.message}
                      </div>
                    )}
                  </div>
                )}

                {/* Fallback error display (no in-flight state) */}
                {createError && !showCreatePanel && (
                  <div
                    style={{
                      backgroundColor: "rgba(239,68,68,0.1)",
                      border: "1px solid var(--error)",
                      borderRadius: 6,
                      padding: "8px 12px",
                      fontSize: 12,
                      color: "var(--error)",
                    }}
                  >
                    {createError}
                  </div>
                )}

                {/* Create button */}
                <button
                  onClick={handleCreate}
                  disabled={!canCreate}
                  onMouseEnter={() => setHovered("create")}
                  onMouseLeave={() => setHovered(null)}
                  style={{
                    backgroundColor: !canCreate
                      ? "var(--bg-tertiary)"
                      : hovered === "create"
                        ? "var(--accent)"
                        : "var(--accent)dd",
                    color: !canCreate ? "var(--text-muted)" : "#fff",
                    border: "none",
                    borderRadius: 6,
                    padding: "10px 0",
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: !canCreate ? "not-allowed" : "pointer",
                    opacity: !canCreate ? 0.5 : 1,
                    transition: "background-color 0.15s, opacity 0.15s",
                    width: "100%",
                  }}
                >
                  {creating
                    ? createState.stage === "parsing_plan"
                      ? "Parsing plan (this can take minutes)..."
                      : createState.stage === "scaffolding"
                        ? "Scaffolding..."
                        : "Creating..."
                    : "Create Project"}
                </button>
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </>
            ) : (
              /* Open Existing tab */
              <>
                {projectList.length === 0 ? (
                  <div
                    style={{
                      textAlign: "center",
                      padding: "40px 0",
                      color: "var(--text-muted)",
                      fontSize: 13,
                    }}
                  >
                    No projects found in {baseDir}
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {projectList.map((project) => (
                      <button
                        key={project.path}
                        onMouseEnter={() => setHovered(`proj-${project.path}`)}
                        onMouseLeave={() => setHovered(null)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          backgroundColor:
                            hovered === `proj-${project.path}`
                              ? "var(--bg-tertiary)"
                              : "var(--bg-primary)",
                          border: "1px solid var(--border)",
                          borderRadius: 8,
                          padding: "12px 16px",
                          cursor: "pointer",
                          transition: "background-color 0.15s",
                          width: "100%",
                          textAlign: "left",
                        }}
                      >
                        <div>
                          <div
                            style={{
                              fontSize: 14,
                              fontWeight: 600,
                              color: "var(--text-primary)",
                              marginBottom: 2,
                            }}
                          >
                            {project.name}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {project.path}
                          </div>
                        </div>
                        <div style={{ textAlign: "right", flexShrink: 0, marginLeft: 16 }}>
                          <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                            {project.taskCount} task{project.taskCount !== 1 ? "s" : ""}
                          </div>
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {formatDate(project.lastModified)}
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
