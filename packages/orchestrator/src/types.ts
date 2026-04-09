// ── Task States ──────────────────────────────────────────────

export type TaskState =
  | "pending"
  | "spec"
  | "executing"
  | "reviewing"
  | "done"
  | "merged"
  | "failed"
  | "skipped"
  | "paused";

export type TaskPhase = "spec" | "execute" | "review" | "merge";

export type TaskEffort = "low" | "medium" | "high" | "max";

// ── Core Entities ────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  description: string;
  dependsOn: number[];
  effort: TaskEffort | null;
  filesChanged: string[];
  state: TaskState;
  phase: TaskPhase | null;
  milestone: string | null;
  worktreePath: string | null;
  branch: string | null;
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRow {
  id: number;
  title: string;
  description: string;
  depends_on: string; // JSON array
  effort: string | null;
  files_changed: string; // JSON array
  state: TaskState;
  phase: TaskPhase | null;
  milestone: string | null;
  worktree_path: string | null;
  branch: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

export interface AgentRun {
  id: number;
  taskId: number;
  phase: TaskPhase;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  duration: number;
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentRunRow {
  id: number;
  task_id: number;
  phase: TaskPhase;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration: number;
  started_at: string;
  finished_at: string | null;
}

export interface TaskLog {
  id: number;
  taskId: number;
  phase: TaskPhase;
  content: string;
  timestamp: string;
}

export interface Learning {
  id: number;
  taskId: number;
  phase: TaskPhase;
  rawNote: string;
  actionableStep: string | null;
  validated: boolean;
  skillTarget: string | null;
  createdAt: string;
}

export interface LearningRow {
  id: number;
  task_id: number;
  phase: TaskPhase;
  raw_note: string;
  actionable_step: string | null;
  validated: number; // SQLite boolean
  skill_target: string | null;
  created_at: string;
}

export interface MergeEvent {
  id: number;
  taskId: number;
  status: "success" | "conflict" | "failed";
  conflictResolved: boolean;
  timestamp: string;
}

export interface Session {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  summaryPath: string | null;
  totalCost: number;
}

// ── WebSocket Events ─────────────────────────────────────────

export type WSEventFromServer =
  | { type: "task:state_change"; taskId: number; oldState: TaskState; newState: TaskState }
  | { type: "task:log_append"; taskId: number; line: string }
  | { type: "task:agent_started"; taskId: number; phase: TaskPhase; model: string }
  | { type: "task:agent_finished"; taskId: number; phase: TaskPhase; tokens: number; cost: number }
  | { type: "task:unblocked"; taskId: number }
  | { type: "run:completed"; summary: RunSummary }
  | { type: "run:notification"; message: string; level: "info" | "warning" | "error" };

export type WSEventFromClient =
  | { type: "task:pause"; taskId: number }
  | { type: "task:resume"; taskId: number }
  | { type: "task:retry"; taskId: number }
  | { type: "task:skip"; taskId: number }
  | { type: "run:pause_all" }
  | { type: "run:resume_all" };

// ── Configuration ────────────────────────────────────────────

export interface OrchestratorConfig {
  projectDir: string;
  dbPath: string;
  maxConcurrency: number;
  taskTimeout: number;        // ms per task
  overallTimeout: number;     // ms for entire run
  wsPort: number;
  pushAfterMerge: boolean;
  mainBranch: string;
  models: {
    spec: string;
    execute: string;
    review: string;
    merge: string;
    learning: string;
  };
  phaseEffortDefaults: Record<TaskPhase, TaskEffort>;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  projectDir: process.cwd(),
  dbPath: ".orchestrator/orchestrator.db",
  maxConcurrency: 4,
  taskTimeout: 10 * 60 * 1000,    // 10 minutes
  overallTimeout: 120 * 60 * 1000, // 2 hours
  wsPort: 3100,
  pushAfterMerge: true,
  mainBranch: "main",
  models: {
    spec: "claude-sonnet-4-6",
    execute: "claude-sonnet-4-6",
    review: "claude-sonnet-4-6",
    merge: "claude-opus-4-6",
    learning: "claude-opus-4-6",
  },
  phaseEffortDefaults: {
    spec: "medium",
    execute: "high",
    review: "medium",
    merge: "high",
  },
};

// ── Run Summary ──────────────────────────────────────────────

export interface RunSummary {
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
  notifications: string[];
}

// ── Claude CLI Output ────────────────────────────────────────

export interface ClaudeResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  duration: number;
}
