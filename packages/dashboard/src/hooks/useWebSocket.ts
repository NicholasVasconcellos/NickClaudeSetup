"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// --- WS Event Types (decoupled from orchestrator package) ---

type TaskState =
  | "pending"
  | "spec"
  | "executing"
  | "reviewing"
  | "done"
  | "merged"
  | "failed"
  | "skipped"
  | "paused";

type TaskPhase = "spec" | "execute" | "review";

type WSEventFromServer =
  | { type: "task:state_change"; taskId: number; oldState: string; newState: TaskState; title?: string }
  | { type: "task:log_append"; taskId: number; line: string }
  | { type: "task:agent_started"; taskId: number; phase: TaskPhase; model: string }
  | { type: "task:agent_finished"; taskId: number; phase: TaskPhase; tokens: number; cost: number }
  | { type: "layer:started"; layerIndex: number; taskIds: number[] }
  | { type: "layer:completed"; layerIndex: number }
  | { type: "run:completed"; summary: RunSummary };

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
  | { type: "command:skip_task"; taskId: number };

export interface TaskInfo {
  state: TaskState;
  title?: string;
  phase?: TaskPhase;
  model?: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
}

export interface WebSocketState {
  connected: boolean;
  tasks: Map<number, TaskInfo>;
  logs: Map<number, string[]>;
  layers: { active: number; completed: number[] };
  costs: { totalCost: number; totalTokensIn: number; totalTokensOut: number };
  summary: RunSummary | null;
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
          };
          next.set(data.taskId, {
            ...existing,
            state: data.newState,
            title: data.title ?? existing.title,
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
          const existing = next.get(data.taskId);
          if (existing) {
            next.set(data.taskId, {
              ...existing,
              cost: existing.cost + data.cost,
            });
          }
          return next;
        });
        setCosts((prev) => ({
          totalCost: prev.totalCost + data.cost,
          totalTokensIn: prev.totalTokensIn + data.tokens,
          totalTokensOut: prev.totalTokensOut,
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
    sendCommand,
  };
}

export type { TaskState, TaskPhase, WSEventFromClient, WSEventFromServer, RunSummary };
