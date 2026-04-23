// ── Context Window Limits ────────────────────────────────────

export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  "claude-sonnet-4-6": 200_000,
  "claude-sonnet-4-6[1m]": 1_000_000,
  "claude-sonnet-4-7": 200_000,
  "claude-sonnet-4-7[1m]": 1_000_000,
  "claude-opus-4-6": 200_000,
  "claude-opus-4-6[1m]": 1_000_000,
  "claude-opus-4-7": 200_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
};

export const DEFAULT_CONTEXT_LIMIT = 200_000;

// ── Task States ──────────────────────────────────────────────

export type TaskState =
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

export type TaskPhase = "spec" | "execute" | "review" | "document" | "merge";

export type TaskEffort = "low" | "medium" | "high" | "max";

// ── Plan Parsing (agent → orchestrator contract) ────────────

export interface AgentTaskDef {
  title: string;
  description: string;
  dependsOn: string[];
  contextFiles?: string[];
}

export interface TasksFile {
  tasks: AgentTaskDef[];
}

// ── Core Entities ────────────────────────────────────────────

export interface Task {
  id: number;
  title: string;
  description: string;
  dependsOn: number[];
  effort: TaskEffort | null;
  filesChanged: string[];
  contextFiles: string[];
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
  context_files: string; // JSON array
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
  sessionId: string | null;
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
  session_id: string | null;
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

// ── Parse-Plan Persistence ───────────────────────────────────

/** Status derived from presence of parse-plan-meta.json + its exitCode. */
export type ParsePlanStatus = "ok" | "failed" | "unknown";

/**
 * Sidecar metadata written to <projectDir>/.orchestrator/parse-plan-meta.json
 * on every parse-plan run (both success and failure). Survives server restart.
 */
export interface ParsePlanMeta {
  projectName: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number;
  timedOut: boolean;
  errorKind: "plan_parse" | "plan_parse_timeout" | null;
  stderrTail: string;
  model: string;
  effort: TaskEffort;
  taskCount: number;
  sessionId: string | null;
  usage: {
    tokensIn: number;
    tokensOut: number;
    cost: number;
    subagentCount: number;
  };
}

// ── WebSocket Events ─────────────────────────────────────────

export type WSEventFromServer =
  | { type: "task:state_change"; taskId: number; oldState: TaskState; newState: TaskState; title?: string }
  | { type: "task:log_append"; taskId: number; line: string }
  | { type: "task:log_bulk"; taskId: number; lines: string[] }
  | { type: "task:agent_started"; taskId: number; phase: TaskPhase; model: string }
  | { type: "task:agent_finished"; taskId: number; phase: TaskPhase; tokens: number; cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheCreation: number; model: string; contextLimit: number; contextPercentage: number }
  | { type: "task:init"; taskId: number; title: string; description: string; dependsOn: number[]; milestone: string | null; effort: TaskEffort | null }
  | { type: "task:unblocked"; taskId: number }
  | { type: "task:awaiting_start"; taskId: number }
  | { type: "run:completed"; summary: RunSummary }
  | { type: "run:notification"; message: string; level: "info" | "warning" | "error" }
  | { type: "plan:loaded"; taskCount: number }
  | { type: "run:started"; mode: "automated" | "human_review"; sessionId: number }
  | { type: "task:created"; taskId: number; title: string }
  | { type: "task:needs_review"; taskId: number; gitDiff: string; agentLogSummary: string }
  | { type: "prompt:response"; taskId: number; response: string }
  | { type: "suggestion:new"; title: string; description: string; filePath: string }
  | { type: "branch:update"; taskId: number; branch: string; status: "created" | "merged" | "deleted" }
  | { type: "skills:list_result"; skills: Array<{ name: string; hasVariations: boolean }> }
  | { type: "skills:content"; skillName: string; content: string; variations: Array<{ name: string; content: string }> }
  | { type: "files:tree_result"; tree: Array<{ path: string; type: "file" | "directory"; children?: any[] }> }
  | { type: "project:created"; projectDir: string; dbPath: string; taskCount: number }
  | { type: "project:create_error"; error: string; kind?: "collision" | "plan_read" | "plan_parse" | "plan_parse_timeout" | "scaffold" | "concurrent" | "unknown"; projectDir?: string }
  | { type: "project:create_progress"; stage: "scaffolding" | "scaffolded" | "parsing_plan" | "plan_parsed" | "done"; projectName: string; projectDir?: string; taskCount?: number; message?: string }
  | { type: "project:create_log"; projectName: string; line: string }
  | { type: "project:create_agent_started"; projectName: string; model: string; effort: TaskEffort }
  | { type: "project:create_agent_usage"; projectName: string; tokensIn: number; tokensOut: number; cost: number; contextLimit: number; contextPercentage: number; subagentCount: number }
  | { type: "project:create_agent_finished"; projectName: string; model: string; tokensIn: number; tokensOut: number; cost: number; contextLimit: number; contextPercentage: number; subagentCount: number }
  | { type: "project:list_result"; projects: Array<{ name: string; path: string; taskCount: number; lastModified: string; parseStatus: ParsePlanStatus; hasTasksJson: boolean; canResumeParse: boolean }> }
  | { type: "project:info"; name: string; dir: string }
  | { type: "project:create_log_replay_start"; projectDir: string; projectName: string; meta: ParsePlanMeta | null }
  | { type: "project:create_log_replay_end"; projectDir: string };

export type WSEventFromClient =
  | { type: "task:pause"; taskId: number }
  | { type: "task:resume"; taskId: number }
  | { type: "task:retry"; taskId: number }
  | { type: "task:skip"; taskId: number }
  | { type: "run:pause_all" }
  | { type: "run:resume_all" }
  | { type: "plan:load"; markdown: string }
  | { type: "run:start"; mode: "automated" | "human_review" }
  | { type: "task:create"; title: string; description: string; dependsOn: number[]; milestone?: string; effort?: string }
  | { type: "task:approve"; taskId: number }
  | { type: "task:start"; taskId: number }
  | { type: "prompt:submit"; taskId: number; prompt: string; threadMode: "continue" | "new" }
  | { type: "skills:list" }
  | { type: "skills:get"; skillName: string }
  | { type: "skills:save"; skillName: string; content: string }
  | { type: "skills:save_variation"; skillName: string; variationName: string; content: string }
  | { type: "skills:activate"; skillName: string; variationName: string }
  | { type: "files:tree" }
  | { type: "project:create"; projectName: string; baseDir: string; planMarkdown?: string; planPath?: string }
  | { type: "project:list"; baseDir: string }
  | { type: "project:create_log_tail"; projectDir: string }
  | { type: "project:retry_parse"; projectDir: string }
  | { type: "project:resume_parse"; projectDir: string }
  | { type: "project:load_tasks"; projectDir: string }
  | { type: "project:open"; projectDir: string };

// ── Configuration ────────────────────────────────────────────

export interface OrchestratorConfig {
  projectDir: string;
  dbPath: string;
  maxConcurrency: number;
  taskTimeout: number;        // ms per task
  overallTimeout: number;     // ms for entire run
  wsPort: number;
  mode: "automated" | "human_review";
  pushAfterMerge: boolean;
  useMilestones: boolean;
  mainBranch: string;
  models: {
    spec: string;
    planning: string;
    execute: string;
    review: string;
    document: string;
    merge: string;
    learning: string;
  };
  phaseEffortDefaults: Record<TaskPhase, TaskEffort>;
  planningEffort: TaskEffort;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  projectDir: process.cwd(),
  dbPath: ".orchestrator/orchestrator.db",
  maxConcurrency: 4,
  taskTimeout: 10 * 60 * 1000,    // 10 minutes
  overallTimeout: 120 * 60 * 1000, // 2 hours
  wsPort: 3100,
  mode: "automated",
  pushAfterMerge: true,
  useMilestones: false,
  mainBranch: "main",
  models: {
    spec: "claude-sonnet-4-6",
    planning: "claude-opus-4-7[1m]",
    execute: "claude-sonnet-4-6",
    review: "claude-sonnet-4-6",
    document: "claude-sonnet-4-6",
    merge: "claude-opus-4-6",
    learning: "claude-opus-4-6",
  },
  phaseEffortDefaults: {
    spec: "medium",
    execute: "high",
    review: "medium",
    document: "medium",
    merge: "high",
  },
  planningEffort: "max",
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
  /** Fresh input tokens (does not include cache reads or cache creations). */
  tokensIn: number;
  tokensOut: number;
  /** Tokens served from the prompt cache (not context pressure). */
  cacheRead: number;
  /** Tokens written to the prompt cache during this call. */
  cacheCreation: number;
  duration: number;
  /** True when runTask aborted the subprocess because the timeout elapsed. */
  timedOut: boolean;
}
