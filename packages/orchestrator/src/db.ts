import SQLiteDatabase from "better-sqlite3";
import fs from "fs";
import path from "path";

import type {
  Task,
  TaskRow,
  TaskEffort,
  AgentRun,
  AgentRunRow,
  TaskLog,
  Learning,
  LearningRow,
  MergeEvent,
  Session,
  TaskState,
  TaskPhase,
  OrchestratorConfig,
} from "./types.js";

// Re-export OrchestratorConfig so importers of db.ts can access it without
// touching types.ts directly (convenience, not required by spec but harmless).
export type { OrchestratorConfig };

// ── Row converters ────────────────────────────────────────────

function taskRowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    dependsOn: JSON.parse(row.depends_on) as number[],
    effort: (row.effort as TaskEffort) ?? null,
    filesChanged: JSON.parse(row.files_changed) as string[],
    state: row.state,
    phase: row.phase,
    milestone: row.milestone,
    worktreePath: row.worktree_path,
    branch: row.branch,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function agentRunRowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    taskId: row.task_id,
    phase: row.phase,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cost: row.cost,
    duration: row.duration,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function learningRowToLearning(row: LearningRow): Learning {
  return {
    id: row.id,
    taskId: row.task_id,
    phase: row.phase,
    rawNote: row.raw_note,
    actionableStep: row.actionable_step,
    validated: row.validated === 1,
    skillTarget: row.skill_target,
    createdAt: row.created_at,
  };
}

// ── Database class ────────────────────────────────────────────

export class Database {
  private db: SQLiteDatabase.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new SQLiteDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
  }

  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        depends_on TEXT NOT NULL DEFAULT '[]',
        effort TEXT,
        files_changed TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL DEFAULT 'pending',
        phase TEXT,
        milestone TEXT,
        worktree_path TEXT,
        branch TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS task_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        phase TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        phase TEXT NOT NULL,
        model TEXT NOT NULL,
        tokens_in INTEGER NOT NULL DEFAULT 0,
        tokens_out INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        phase TEXT NOT NULL,
        raw_note TEXT NOT NULL,
        actionable_step TEXT,
        validated INTEGER NOT NULL DEFAULT 0,
        skill_target TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS merge_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES tasks(id),
        status TEXT NOT NULL,
        conflict_resolved INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        summary_path TEXT,
        total_cost REAL NOT NULL DEFAULT 0
      );
    `);

    // Migrations: add columns that may be missing from older databases.
    // SQLite has no ADD COLUMN IF NOT EXISTS, so try/catch each one.
    const migrations = [
      "ALTER TABLE tasks ADD COLUMN effort TEXT",
      "ALTER TABLE tasks ADD COLUMN files_changed TEXT NOT NULL DEFAULT '[]'",
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
  }

  // ── Tasks ───────────────────────────────────────────────────

  createTask(
    title: string,
    description: string,
    dependsOn: number[],
    milestone?: string,
    effort?: TaskEffort | null,
  ): Task {
    const stmt = this.db.prepare(`
      INSERT INTO tasks (title, description, depends_on, milestone, effort)
      VALUES (?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      title,
      description,
      JSON.stringify(dependsOn),
      milestone ?? null,
      effort ?? null,
    );
    return this.getTask(info.lastInsertRowid as number) as Task;
  }

  getTask(id: number): Task | null {
    const row = this.db
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(id) as TaskRow | undefined;
    return row ? taskRowToTask(row) : null;
  }

  getAllTasks(): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks ORDER BY id")
      .all() as TaskRow[];
    return rows.map(taskRowToTask);
  }

  getTasksByState(state: TaskState): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE state = ? ORDER BY id")
      .all(state) as TaskRow[];
    return rows.map(taskRowToTask);
  }

  getTasksByMilestone(milestone: string): Task[] {
    const rows = this.db
      .prepare("SELECT * FROM tasks WHERE milestone = ? ORDER BY id")
      .all(milestone) as TaskRow[];
    return rows.map(taskRowToTask);
  }

  updateTaskState(id: number, state: TaskState, phase?: TaskPhase | null): void {
    this.db
      .prepare(
        "UPDATE tasks SET state = ?, phase = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(state, phase ?? null, id);
  }

  updateTaskWorktree(
    id: number,
    worktreePath: string | null,
    branch: string | null
  ): void {
    this.db
      .prepare(
        "UPDATE tasks SET worktree_path = ?, branch = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(worktreePath, branch, id);
  }

  incrementRetry(id: number): number {
    this.db
      .prepare(
        "UPDATE tasks SET retry_count = retry_count + 1, updated_at = datetime('now') WHERE id = ?"
      )
      .run(id);
    const row = this.db
      .prepare("SELECT retry_count FROM tasks WHERE id = ?")
      .get(id) as { retry_count: number } | undefined;
    return row?.retry_count ?? 0;
  }

  getCompletedTaskContext(taskIds: number[]): { titles: string; files: string[] } {
    if (taskIds.length === 0) return { titles: "", files: [] };
    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, title, files_changed FROM tasks WHERE id IN (${placeholders}) AND state IN ('done', 'merged') ORDER BY id`
      )
      .all(...taskIds) as Array<{ id: number; title: string; files_changed: string }>;
    const titles = rows.map((r) => `[${r.id}] ${r.title}`).join("\n");
    const files = rows.flatMap((r) => JSON.parse(r.files_changed) as string[]);
    return { titles, files };
  }

  updateFilesChanged(id: number, files: string[]): void {
    this.db
      .prepare(
        "UPDATE tasks SET files_changed = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(JSON.stringify(files), id);
  }

  // ── Task Logs ───────────────────────────────────────────────

  appendLog(taskId: number, phase: TaskPhase, content: string): void {
    this.db
      .prepare(
        "INSERT INTO task_logs (task_id, phase, content) VALUES (?, ?, ?)"
      )
      .run(taskId, phase, content);
  }

  getTaskLogs(taskId: number, phase?: TaskPhase): TaskLog[] {
    type LogRow = { id: number; task_id: number; phase: TaskPhase; content: string; timestamp: string };
    if (phase !== undefined) {
      const rows = this.db
        .prepare(
          "SELECT * FROM task_logs WHERE task_id = ? AND phase = ? ORDER BY id"
        )
        .all(taskId, phase) as LogRow[];
      return rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        phase: r.phase,
        content: r.content,
        timestamp: r.timestamp,
      }));
    }
    const rows = this.db
      .prepare("SELECT * FROM task_logs WHERE task_id = ? ORDER BY id")
      .all(taskId) as LogRow[];
    return rows.map((r) => ({
      id: r.id,
      taskId: r.task_id,
      phase: r.phase,
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  // ── Agent Runs ──────────────────────────────────────────────

  startAgentRun(taskId: number, phase: TaskPhase, model: string): number {
    const info = this.db
      .prepare(
        "INSERT INTO agent_runs (task_id, phase, model) VALUES (?, ?, ?)"
      )
      .run(taskId, phase, model);
    return info.lastInsertRowid as number;
  }

  finishAgentRun(
    runId: number,
    tokensIn: number,
    tokensOut: number,
    cost: number,
    duration: number
  ): void {
    this.db
      .prepare(
        `UPDATE agent_runs
         SET tokens_in = ?, tokens_out = ?, cost = ?, duration = ?, finished_at = datetime('now')
         WHERE id = ?`
      )
      .run(tokensIn, tokensOut, cost, duration, runId);
  }

  getAgentRuns(taskId?: number): AgentRun[] {
    if (taskId !== undefined) {
      const rows = this.db
        .prepare("SELECT * FROM agent_runs WHERE task_id = ? ORDER BY id")
        .all(taskId) as AgentRunRow[];
      return rows.map(agentRunRowToAgentRun);
    }
    const rows = this.db
      .prepare("SELECT * FROM agent_runs ORDER BY id")
      .all() as AgentRunRow[];
    return rows.map(agentRunRowToAgentRun);
  }

  // ── Learnings ───────────────────────────────────────────────

  captureLearning(taskId: number, phase: TaskPhase, rawNote: string): number {
    const info = this.db
      .prepare(
        "INSERT INTO learnings (task_id, phase, raw_note) VALUES (?, ?, ?)"
      )
      .run(taskId, phase, rawNote);
    return info.lastInsertRowid as number;
  }

  getAllLearnings(): Learning[] {
    const rows = this.db
      .prepare("SELECT * FROM learnings ORDER BY id")
      .all() as LearningRow[];
    return rows.map(learningRowToLearning);
  }

  // ── Merge Events ────────────────────────────────────────────

  recordMerge(
    taskId: number,
    status: "success" | "conflict" | "failed",
    conflictResolved: boolean
  ): void {
    this.db
      .prepare(
        "INSERT INTO merge_events (task_id, status, conflict_resolved) VALUES (?, ?, ?)"
      )
      .run(taskId, status, conflictResolved ? 1 : 0);
  }

  // ── Sessions ────────────────────────────────────────────────

  createSession(): number {
    const info = this.db
      .prepare("INSERT INTO sessions DEFAULT VALUES")
      .run();
    return info.lastInsertRowid as number;
  }

  finishSession(id: number, summaryPath: string | null, totalCost: number): void {
    this.db
      .prepare(
        "UPDATE sessions SET finished_at = datetime('now'), summary_path = ?, total_cost = ? WHERE id = ?"
      )
      .run(summaryPath, totalCost, id);
  }

  getSession(id: number): Session | null {
    type SessionRow = {
      id: number;
      started_at: string;
      finished_at: string | null;
      summary_path: string | null;
      total_cost: number;
    };
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      summaryPath: row.summary_path,
      totalCost: row.total_cost,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────

  close(): void {
    this.db.close();
  }
}
