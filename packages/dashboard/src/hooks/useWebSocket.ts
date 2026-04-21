"use client";

import { useEffect, useRef, useState, useCallback } from "react";

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

type WSEventFromServer =
  | { type: "task:state_change"; taskId: number; oldState: string; newState: TaskState; title?: string }
  | { type: "task:log_append"; taskId: number; line: string }
  | { type: "task:agent_started"; taskId: number; phase: TaskPhase; model: string }
  | { type: "task:agent_finished"; taskId: number; phase: TaskPhase; tokens: number; cost: number; tokensIn: number; tokensOut: number; model: string; contextLimit: number; contextPercentage: number }
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
  | { type: "project:created"; projectDir: string; dbPath: string; taskCount: number }
  | { type: "project:create_error"; error: string }
  | { type: "project:list_result"; projects: Array<{ name: string; path: string; taskCount: number; lastModified: string }> }
  | { type: "project:info"; name: string; dir: string }
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
  | { type: "command:pause_all" }
  | { type: "command:resume_all" }
  | { type: "command:pause_task"; taskId: number }
  | { type: "command:resume_task"; taskId: number }
  | { type: "command:retry_task"; taskId: number }
  | { type: "command:skip_task"; taskId: number }
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
  | { type: "project:list"; baseDir: string };

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
  costs: { totalCost: number; totalTokensIn: number; totalTokensOut: number };
  summary: RunSummary | null;
  skills: SkillListItem[];
  skillContent: SkillContent | null;
  fileTree: TreeNodeWS[];
  promptResponses: Map<number, string>;
  planStatus: { loaded: boolean; taskCount: number };
  pendingReviews: Map<number, ReviewData>;
  suggestions: Suggestion[];
  projectInfo: { name: string; dir: string } | null;
  projectList: Array<{ name: string; path: string; taskCount: number; lastModified: string }>;
  projectError: string | null;
  sendCommand: (event: WSEventFromClient) => void;
}

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
  const [projectList, setProjectList] = useState<Array<{ name: string; path: string; taskCount: number; lastModified: string }>>([]);
  const [projectError, setProjectError] = useState<string | null>(null);

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
            contextHistory: [],
            contextRollup: { totalTokensUsed: 0, peakPercentage: 0 },
          };
          next.set(data.taskId, {
            ...existing,
            state: data.newState,
            title: data.title ?? existing.title,
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
            contextHistory: history,
            contextRollup: { totalTokensUsed, peakPercentage },
          });
          return next;
        });
        setCosts((prev) => ({
          totalCost: prev.totalCost + data.cost,
          totalTokensIn: prev.totalTokensIn + data.tokensIn,
          totalTokensOut: prev.totalTokensOut + data.tokensOut,
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
        setCosts({
          totalCost: data.summary.totalCost,
          totalTokensIn: data.summary.totalTokensIn,
          totalTokensOut: data.summary.totalTokensOut,
        });
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

      case "project:created": {
        setProjectInfo({ name: data.projectDir.split("/").pop() ?? "", dir: data.projectDir });
        setProjectError(null);
        break;
      }

      case "project:create_error": {
        setProjectError(data.error);
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
    sendCommand,
  };
}

export type { TaskState, TaskPhase, WSEventFromClient, WSEventFromServer, RunSummary, TreeNodeWS };
