"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { parseStreamLine, resetStreamSeq, type StreamEvent } from "@/lib/streamParser";

// --- WS Event Types (decoupled from orchestrator package) ---

type TaskState =
  | "pending"
  | "spec"
  | "executing"
  | "reviewing"
  | "documenting"
  | "done"
  | "merged"
  | "failed"
  | "skipped"
  | "paused";

type TaskPhase = "spec" | "execute" | "review" | "document";

export type ProjectCreateStage = "scaffolding" | "scaffolded" | "parsing_plan" | "plan_parsed" | "done";
export type ProjectCreateErrorKind = "collision" | "plan_read" | "plan_parse" | "plan_parse_timeout" | "scaffold" | "concurrent" | "unknown";
export type ParsePlanStatus = "ok" | "failed" | "unknown";

export interface ParsePlanMeta {
  projectName: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number;
  timedOut: boolean;
  errorKind: "plan_parse" | "plan_parse_timeout" | null;
  stderrTail: string;
  model: string;
  effort: string;
  taskCount: number;
  sessionId: string | null;
  usage: { tokensIn: number; tokensOut: number; cost: number; subagentCount: number };
}

export interface ProjectListEntry {
  name: string;
  path: string;
  taskCount: number;
  lastModified: string;
  parseStatus: ParsePlanStatus;
  hasTasksJson: boolean;
  canResumeParse: boolean;
}

export interface PlanningAgentUsage {
  model: string | null;
  effort: string | null;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  contextLimit: number;
  contextPercentage: number;
  subagentCount: number;
  /** True between agent_started and agent_finished. */
  live: boolean;
}

export interface ProjectCreateState {
  active: boolean;
  projectName: string | null;
  projectDir: string | null;
  stage: ProjectCreateStage | null;
  message: string | null;
  logs: string[];
  events: StreamEvent[];
  taskCount: number;
  error: { message: string; kind?: ProjectCreateErrorKind; projectDir?: string } | null;
  planningUsage: PlanningAgentUsage;
  /** True while showing a persisted log (not a live run). Cleared when a retry starts. */
  historical: boolean;
  /** Populated during historical replay. */
  meta: ParsePlanMeta | null;
}

const MAX_CREATE_LOG_LINES = 2000;
const MAX_CREATE_EVENTS = 5000;

type WSEventFromServer =
  | { type: "task:state_change"; taskId: number; oldState: string; newState: TaskState; title?: string }
  | { type: "task:log_append"; taskId: number; line: string }
  | { type: "task:agent_started"; taskId: number; phase: TaskPhase; model: string }
  | { type: "task:agent_finished"; taskId: number; phase: TaskPhase; tokens: number; cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheCreation: number; model: string; contextLimit: number; contextPercentage: number }
  | { type: "layer:started"; layerIndex: number; taskIds: number[] }
  | { type: "layer:completed"; layerIndex: number }
  | { type: "task:init"; taskId: number; title: string; description: string; dependsOn: number[]; milestone: string | null; effort: string | null }
  | { type: "run:completed"; summary: RunSummary }
  | { type: "skills:list_result"; skills: Array<{ name: string; hasVariations: boolean }> }
  | { type: "skills:content"; skillName: string; content: string; variations: Array<{ name: string; content: string }> }
  | { type: "files:tree_result"; tree: TreeNodeWS[] }
  | { type: "prompt:response"; taskId: number; response: string }
  | { type: "task:created"; taskId: number; title: string }
  | { type: "plan:loaded"; taskCount: number }
  | { type: "task:needs_review"; taskId: number; gitDiff: string; agentLogSummary: string }
  | { type: "suggestion:new"; title: string; description: string; filePath: string }
  | { type: "run:started"; mode: "automated" | "human_review"; sessionId: number }
  | { type: "branch:update"; taskId: number; branch: string; status: "created" | "merged" | "deleted" }
  | { type: "task:awaiting_start"; taskId: number }
  | { type: "project:created"; projectDir: string; dbPath: string; taskCount: number }
  | { type: "project:create_error"; error: string; kind?: ProjectCreateErrorKind; projectDir?: string }
  | { type: "project:create_progress"; stage: ProjectCreateStage; projectName: string; projectDir?: string; taskCount?: number; message?: string }
  | { type: "project:create_log"; projectName: string; line: string }
  | { type: "project:create_agent_started"; projectName: string; model: string; effort: string }
  | { type: "project:create_agent_usage"; projectName: string; tokensIn: number; tokensOut: number; cost: number; contextLimit: number; contextPercentage: number; subagentCount: number }
  | { type: "project:create_agent_finished"; projectName: string; model: string; tokensIn: number; tokensOut: number; cost: number; contextLimit: number; contextPercentage: number; subagentCount: number }
  | { type: "project:list_result"; projects: ProjectListEntry[] }
  | { type: "project:info"; name: string; dir: string }
  | { type: "project:create_log_replay_start"; projectDir: string; projectName: string; meta: ParsePlanMeta | null }
  | { type: "project:create_log_replay_end"; projectDir: string }
  | { type: "run:notification"; message: string; level: "info" | "warning" | "error" };

interface TreeNodeWS {
  path: string;
  name: string;
  type: "file" | "directory";
  children?: TreeNodeWS[];
}

interface RunSummary {
  sessionId: number;
  totalTasks: number;
  completed: number;
  failed: number;
  skipped: number;
  totalCost: number;
  totalTokensIn: number;
  totalTokensOut: number;
  duration: number;
  learnings: number;
  learningSummary: string | null;
}

type WSEventFromClient =
  | { type: "run:pause_all" }
  | { type: "run:resume_all" }
  | { type: "task:pause"; taskId: number }
  | { type: "task:resume"; taskId: number }
  | { type: "task:retry"; taskId: number }
  | { type: "task:skip"; taskId: number }
  | { type: "task:approve"; taskId: number }
  | { type: "task:start"; taskId: number }
  | { type: "skills:list" }
  | { type: "skills:get"; skillName: string }
  | { type: "skills:save"; skillName: string; content: string }
  | { type: "skills:save_variation"; skillName: string; variationName: string; content: string }
  | { type: "skills:activate"; skillName: string; variationName: string }
  | { type: "files:tree" }
  | { type: "prompt:submit"; taskId: number; prompt: string; threadMode: "continue" | "new" }
  | { type: "task:create"; title: string; description: string; dependsOn: number[]; milestone?: string; effort?: string }
  | { type: "plan:load"; markdown: string }
  | { type: "run:start"; mode: "automated" | "human_review" }
  | { type: "project:create"; projectName: string; baseDir: string; planMarkdown?: string; planPath?: string }
  | { type: "project:list"; baseDir: string }
  | { type: "project:create_log_tail"; projectDir: string }
  | { type: "project:retry_parse"; projectDir: string }
  | { type: "project:resume_parse"; projectDir: string }
  | { type: "project:load_tasks"; projectDir: string }
  | { type: "project:open"; projectDir: string };

export interface PhaseContextInfo {
  phase: string;
  model: string;
  tokensUsed: number;
  contextLimit: number;
  contextPercentage: number;
}

export interface TaskInfo {
  state: TaskState;
  title?: string;
  description?: string;
  dependsOn?: number[];
  milestone?: string | null;
  effort?: string | null;
  phase?: TaskPhase;
  model?: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
  awaitingStart?: boolean;
  contextHistory: PhaseContextInfo[];
  contextRollup: { totalTokensUsed: number; peakPercentage: number };
}

export interface SkillListItem {
  name: string;
  hasVariations: boolean;
}

export interface SkillContent {
  skillName: string;
  content: string;
  variations: Array<{ name: string; content: string }>;
}

export interface ReviewData {
  taskId: number;
  gitDiff: string;
  agentLogSummary: string;
}

export interface Suggestion {
  title: string;
  description: string;
  filePath: string;
}

export interface WebSocketState {
  connected: boolean;
  tasks: Map<number, TaskInfo>;
  logs: Map<number, string[]>;
  layers: { active: number; completed: number[] };
  costs: { totalCost: number; totalTokensIn: number; totalTokensOut: number; totalCacheRead: number; totalCacheCreation: number };
  summary: RunSummary | null;
  skills: SkillListItem[];
  skillContent: SkillContent | null;
  fileTree: TreeNodeWS[];
  promptResponses: Map<number, string>;
  planStatus: { loaded: boolean; taskCount: number };
  pendingReviews: Map<number, ReviewData>;
  suggestions: Suggestion[];
  projectInfo: { name: string; dir: string } | null;
  projectList: ProjectListEntry[];
  projectError: string | null;
  projectCreateState: ProjectCreateState;
  sendCommand: (event: WSEventFromClient) => void;
}

const initialPlanningUsage: PlanningAgentUsage = {
  model: null,
  effort: null,
  tokensIn: 0,
  tokensOut: 0,
  cost: 0,
  contextLimit: 200_000,
  contextPercentage: 0,
  subagentCount: 0,
  live: false,
};

const initialCreateState: ProjectCreateState = {
  active: false,
  projectName: null,
  projectDir: null,
  stage: null,
  message: null,
  logs: [],
  events: [],
  taskCount: 0,
  error: null,
  planningUsage: initialPlanningUsage,
  historical: false,
  meta: null,
};

export function useWebSocket(url: string): WebSocketState {
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);

  const [connected, setConnected] = useState(false);
  const [tasks, setTasks] = useState<Map<number, TaskInfo>>(new Map());
  const [logs, setLogs] = useState<Map<number, string[]>>(new Map());
  const [layers, setLayers] = useState<{ active: number; completed: number[] }>({
    active: -1,
    completed: [],
  });
  const [costs, setCosts] = useState({
    totalCost: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalCacheRead: 0,
    totalCacheCreation: 0,
  });
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [skillContent, setSkillContent] = useState<SkillContent | null>(null);
  const [fileTree, setFileTree] = useState<TreeNodeWS[]>([]);
  const [promptResponses, setPromptResponses] = useState<Map<number, string>>(new Map());
  const [planStatus, setPlanStatus] = useState<{ loaded: boolean; taskCount: number }>({ loaded: false, taskCount: 0 });
  const [pendingReviews, setPendingReviews] = useState<Map<number, ReviewData>>(new Map());
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [projectInfo, setProjectInfo] = useState<{ name: string; dir: string } | null>(null);
  const [projectList, setProjectList] = useState<ProjectListEntry[]>([]);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectCreateState, setProjectCreateState] = useState<ProjectCreateState>(initialCreateState);

  const handleMessage = useCallback((event: MessageEvent) => {
    let data: WSEventFromServer;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (data.type) {
      case "task:state_change": {
        setTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(data.taskId) ?? {
            state: "pending" as TaskState,
            cost: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            contextHistory: [],
            contextRollup: { totalTokensUsed: 0, peakPercentage: 0 },
          };
          next.set(data.taskId, {
            ...existing,
            state: data.newState,
            title: data.title ?? existing.title,
            awaitingStart: data.newState === "pending" ? existing.awaitingStart : false,
          });
          return next;
        });
        if (data.newState === "merged" || data.newState === "failed" || data.newState === "pending") {
          setPendingReviews((prev) => {
            const next = new Map(prev);
            next.delete(data.taskId);
            return next;
          });
        }
        break;
      }

      case "task:init": {
        setTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(data.taskId) ?? {
            state: "pending" as TaskState,
            cost: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            contextHistory: [],
            contextRollup: { totalTokensUsed: 0, peakPercentage: 0 },
          };
          next.set(data.taskId, {
            ...existing,
            title: data.title,
            description: data.description,
            dependsOn: data.dependsOn,
            milestone: data.milestone,
            effort: data.effort,
          });
          return next;
        });
        break;
      }

      case "task:log_append": {
        setLogs((prev) => {
          const next = new Map(prev);
          const lines = next.get(data.taskId) ?? [];
          next.set(data.taskId, [...lines, data.line]);
          return next;
        });
        break;
      }

      case "task:agent_started": {
        setTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(data.taskId);
          if (existing) {
            next.set(data.taskId, {
              ...existing,
              phase: data.phase,
              model: data.model,
            });
          }
          return next;
        });
        break;
      }

      case "task:agent_finished": {
        setTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(data.taskId) ?? {
            state: "pending" as TaskState,
            cost: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            contextHistory: [],
            contextRollup: { totalTokensUsed: 0, peakPercentage: 0 },
          };
          const phaseInfo: PhaseContextInfo = {
            phase: data.phase,
            model: data.model,
            tokensUsed: data.tokensIn + data.tokensOut,
            contextLimit: data.contextLimit,
            contextPercentage: data.contextPercentage,
          };
          const history = [...existing.contextHistory, phaseInfo];
          const totalTokensUsed = history.reduce((s, h) => s + h.tokensUsed, 0);
          const peakPercentage = Math.max(...history.map((h) => h.contextPercentage));
          next.set(data.taskId, {
            ...existing,
            cost: existing.cost + data.cost,
            tokensIn: existing.tokensIn + data.tokensIn,
            tokensOut: existing.tokensOut + data.tokensOut,
            cacheRead: existing.cacheRead + (data.cacheRead ?? 0),
            cacheCreation: existing.cacheCreation + (data.cacheCreation ?? 0),
            contextHistory: history,
            contextRollup: { totalTokensUsed, peakPercentage },
          });
          return next;
        });
        setCosts((prev) => ({
          totalCost: prev.totalCost + data.cost,
          totalTokensIn: prev.totalTokensIn + data.tokensIn,
          totalTokensOut: prev.totalTokensOut + data.tokensOut,
          totalCacheRead: prev.totalCacheRead + (data.cacheRead ?? 0),
          totalCacheCreation: prev.totalCacheCreation + (data.cacheCreation ?? 0),
        }));
        break;
      }

      case "layer:started": {
        setLayers((prev) => ({
          ...prev,
          active: data.layerIndex,
        }));
        // Initialize tasks for this layer
        setTasks((prev) => {
          const next = new Map(prev);
          for (const id of data.taskIds) {
            if (!next.has(id)) {
              next.set(id, {
                state: "pending",
                cost: 0,
                tokensIn: 0,
                tokensOut: 0,
                cacheRead: 0,
                cacheCreation: 0,
                contextHistory: [],
                contextRollup: { totalTokensUsed: 0, peakPercentage: 0 },
              });
            }
          }
          return next;
        });
        break;
      }

      case "layer:completed": {
        setLayers((prev) => ({
          ...prev,
          completed: [...prev.completed, data.layerIndex],
        }));
        break;
      }

      case "run:completed": {
        setSummary(data.summary);
        setCosts((prev) => ({
          totalCost: data.summary.totalCost,
          totalTokensIn: data.summary.totalTokensIn,
          totalTokensOut: data.summary.totalTokensOut,
          totalCacheRead: prev.totalCacheRead,
          totalCacheCreation: prev.totalCacheCreation,
        }));
        break;
      }

      case "run:started": {
        // Could store mode/sessionId if needed
        break;
      }

      case "skills:list_result": {
        setSkills(data.skills);
        break;
      }

      case "skills:content": {
        setSkillContent({
          skillName: data.skillName,
          content: data.content,
          variations: data.variations,
        });
        break;
      }

      case "files:tree_result": {
        setFileTree(data.tree);
        break;
      }

      case "prompt:response": {
        setPromptResponses((prev) => {
          const next = new Map(prev);
          next.set(data.taskId, data.response);
          return next;
        });
        break;
      }

      case "task:created": {
        // Task will be added via task:init, no-op
        break;
      }

      case "plan:loaded": {
        setPlanStatus({ loaded: true, taskCount: data.taskCount });
        break;
      }

      case "task:needs_review": {
        setPendingReviews((prev) => {
          const next = new Map(prev);
          next.set(data.taskId, { taskId: data.taskId, gitDiff: data.gitDiff, agentLogSummary: data.agentLogSummary });
          return next;
        });
        break;
      }

      case "suggestion:new": {
        setSuggestions(prev => [...prev, { title: data.title, description: data.description, filePath: data.filePath }]);
        break;
      }

      case "branch:update": {
        // Branch info derived from task states; no-op for dedicated events
        break;
      }

      case "task:awaiting_start": {
        setTasks((prev) => {
          const next = new Map(prev);
          const existing = next.get(data.taskId) ?? {
            state: "pending" as TaskState,
            cost: 0,
            tokensIn: 0,
            tokensOut: 0,
            cacheRead: 0,
            cacheCreation: 0,
            contextHistory: [],
            contextRollup: { totalTokensUsed: 0, peakPercentage: 0 },
          };
          next.set(data.taskId, { ...existing, awaitingStart: true });
          return next;
        });
        break;
      }

      case "project:created": {
        setProjectInfo({ name: data.projectDir.split("/").pop() ?? "", dir: data.projectDir });
        setProjectError(null);
        setProjectCreateState((prev) => ({
          ...prev,
          active: false,
          stage: "done",
          taskCount: data.taskCount,
          message: "Project ready.",
          error: null,
        }));
        break;
      }

      case "project:create_error": {
        setProjectError(data.error);
        setProjectCreateState((prev) => ({
          ...prev,
          active: false,
          error: { message: data.error, kind: data.kind, projectDir: data.projectDir },
        }));
        break;
      }

      case "project:create_progress": {
        setProjectCreateState((prev) => {
          const isNewSession = prev.projectName !== data.projectName && data.stage === "scaffolding";
          if (isNewSession) resetStreamSeq();
          return {
            ...prev,
            active: data.stage !== "done",
            historical: false,
            projectName: data.projectName,
            projectDir: data.projectDir ?? prev.projectDir,
            stage: data.stage,
            message: data.message ?? prev.message,
            taskCount: data.taskCount ?? prev.taskCount,
            logs: isNewSession ? [] : prev.logs,
            events: isNewSession ? [] : prev.events,
            error: isNewSession ? null : prev.error,
            planningUsage: isNewSession ? initialPlanningUsage : prev.planningUsage,
          };
        });
        break;
      }

      case "project:create_log": {
        setProjectCreateState((prev) => {
          const nextLogs = [...prev.logs, data.line];
          if (nextLogs.length > MAX_CREATE_LOG_LINES) {
            nextLogs.splice(0, nextLogs.length - MAX_CREATE_LOG_LINES);
          }
          const parsed = parseStreamLine(data.line);
          const nextEvents = parsed.length > 0 ? [...prev.events, ...parsed] : prev.events;
          if (nextEvents.length > MAX_CREATE_EVENTS) {
            nextEvents.splice(0, nextEvents.length - MAX_CREATE_EVENTS);
          }
          return { ...prev, logs: nextLogs, events: nextEvents };
        });
        break;
      }

      case "project:create_agent_started": {
        setProjectCreateState((prev) => ({
          ...prev,
          projectName: data.projectName,
          planningUsage: {
            ...initialPlanningUsage,
            model: data.model,
            effort: data.effort,
            live: true,
          },
        }));
        break;
      }

      case "project:create_agent_usage": {
        setProjectCreateState((prev) => ({
          ...prev,
          planningUsage: {
            ...prev.planningUsage,
            tokensIn: data.tokensIn,
            tokensOut: data.tokensOut,
            cost: data.cost,
            contextLimit: data.contextLimit,
            contextPercentage: data.contextPercentage,
            subagentCount: data.subagentCount,
          },
        }));
        break;
      }

      case "project:create_agent_finished": {
        setProjectCreateState((prev) => ({
          ...prev,
          planningUsage: {
            ...prev.planningUsage,
            model: data.model,
            tokensIn: data.tokensIn,
            tokensOut: data.tokensOut,
            cost: data.cost,
            contextLimit: data.contextLimit,
            contextPercentage: data.contextPercentage,
            subagentCount: data.subagentCount,
            live: false,
          },
        }));
        break;
      }

      case "project:list_result": {
        setProjectList(data.projects);
        break;
      }

      case "project:info": {
        setProjectInfo({ name: data.name, dir: data.dir });
        break;
      }

      case "project:create_log_replay_start": {
        setProjectCreateState((prev) => {
          // If we're in a live run for a different project, don't clobber it.
          if (prev.active && prev.projectDir && prev.projectDir !== data.projectDir) return prev;
          const meta = data.meta;
          const errKind = meta?.errorKind ?? undefined;
          const errMessage = meta && errKind
            ? errKind === "plan_parse_timeout"
              ? `Agent timed out.${meta.stderrTail ? `\n${meta.stderrTail}` : ""}`
              : `Agent failed (exit ${meta.exitCode}).${meta.stderrTail ? `\n${meta.stderrTail}` : ""}`
            : null;
          return {
            ...initialCreateState,
            historical: true,
            projectName: data.projectName,
            projectDir: data.projectDir,
            stage: meta && meta.exitCode === 0 ? "plan_parsed" : "parsing_plan",
            message: meta
              ? `Persisted parse from ${new Date(meta.startedAt).toLocaleString()}`
              : "No prior parse log available for this project.",
            meta,
            taskCount: meta?.taskCount ?? 0,
            error: errMessage
              ? { message: errMessage, kind: errKind, projectDir: data.projectDir }
              : null,
            planningUsage: meta
              ? {
                  model: meta.model,
                  effort: meta.effort,
                  tokensIn: meta.usage.tokensIn,
                  tokensOut: meta.usage.tokensOut,
                  cost: meta.usage.cost,
                  contextLimit: initialPlanningUsage.contextLimit,
                  contextPercentage: 0,
                  subagentCount: meta.usage.subagentCount,
                  live: false,
                }
              : initialPlanningUsage,
          };
        });
        break;
      }

      case "project:create_log_replay_end": {
        // State was fully hydrated by replay_start + the replayed project:create_log
        // events; nothing more to do here.
        break;
      }

      case "run:notification": {
        // Could show as toast, for now no-op
        break;
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (socketRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    socketRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      reconnectDelayRef.current = 1000; // Reset backoff on success
    };

    ws.onclose = () => {
      setConnected(false);
      socketRef.current = null;

      // Auto-reconnect with exponential backoff
      const delay = reconnectDelayRef.current;
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectDelayRef.current = Math.min(delay * 2, 10000);
        connect();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = handleMessage;
  }, [url, handleMessage]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (socketRef.current) {
        socketRef.current.onclose = null; // Prevent reconnect on intentional close
        socketRef.current.close();
      }
    };
  }, [connect]);

  const sendCommand = useCallback((event: WSEventFromClient) => {
    if (event.type === "project:create") {
      resetStreamSeq();
      setProjectCreateState({
        ...initialCreateState,
        active: true,
        projectName: event.projectName,
        message: "Sending request...",
      });
      setProjectError(null);
    }
    if (event.type === "project:retry_parse") {
      resetStreamSeq();
      const projectName = event.projectDir.split("/").filter(Boolean).pop() ?? null;
      setProjectCreateState({
        ...initialCreateState,
        active: true,
        projectName,
        projectDir: event.projectDir,
        stage: "parsing_plan",
        message: "Retrying parse...",
      });
      setProjectError(null);
    }
    if (event.type === "project:resume_parse") {
      resetStreamSeq();
      const projectName = event.projectDir.split("/").filter(Boolean).pop() ?? null;
      setProjectCreateState({
        ...initialCreateState,
        active: true,
        projectName,
        projectDir: event.projectDir,
        stage: "parsing_plan",
        message: "Resuming prior parse session...",
      });
      setProjectError(null);
    }
    if (event.type === "project:load_tasks") {
      resetStreamSeq();
      const projectName = event.projectDir.split("/").filter(Boolean).pop() ?? null;
      setProjectCreateState({
        ...initialCreateState,
        active: true,
        projectName,
        projectDir: event.projectDir,
        stage: "plan_parsed",
        message: "Loading tasks from tasks.json...",
      });
      setProjectError(null);
    }
    if (event.type === "project:create_log_tail") {
      resetStreamSeq();
      const projectName = event.projectDir.split("/").filter(Boolean).pop() ?? null;
      setProjectCreateState({
        ...initialCreateState,
        active: false,
        historical: true,
        projectName,
        projectDir: event.projectDir,
        stage: "parsing_plan",
        message: "Loading persisted log...",
      });
    }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(event));
    }
  }, []);

  return {
    connected,
    tasks,
    logs,
    layers,
    costs,
    summary,
    skills,
    skillContent,
    fileTree,
    promptResponses,
    planStatus,
    pendingReviews,
    suggestions,
    projectInfo,
    projectList,
    projectError,
    projectCreateState,
    sendCommand,
  };
}

export type { TaskState, TaskPhase, WSEventFromClient, WSEventFromServer, RunSummary, TreeNodeWS };
