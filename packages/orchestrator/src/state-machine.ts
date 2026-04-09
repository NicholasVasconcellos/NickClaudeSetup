import type { TaskState, TaskPhase } from "./types.js";
import type { Database } from "./db.js";

// ── Transitions map ───────────────────────────────────────────
//
// Keys are the "from" state. Values are the set of legal "to" states.
// Universal transitions (* → failed, * → paused, * → skipped) are
// handled separately so the per-state entries only describe happy-path
// and special edges.

const HAPPY_PATH: TaskState[] = [
  "pending",
  "spec",
  "executing",
  "reviewing",
  "done",
  "merged",
];

const TRANSITIONS: Record<TaskState, Set<TaskState>> = {
  pending:   new Set(["spec",      "failed", "paused", "skipped"]),
  spec:      new Set(["executing", "failed", "paused", "skipped"]),
  executing: new Set(["reviewing", "failed", "paused", "skipped"]),
  reviewing: new Set(["done",      "failed", "paused", "skipped"]),
  done:      new Set(["merged",    "failed",           "skipped"]),
  merged:    new Set([                                          ]),
  failed:    new Set([                                          ]),
  skipped:   new Set([                                          ]),
  paused:    new Set(["executing", "failed",           "skipped"]),
};

// ── State → Phase mapping ─────────────────────────────────────

const STATE_TO_PHASE: Partial<Record<TaskState, TaskPhase>> = {
  spec:      "spec",
  executing: "execute",
  reviewing: "review",
};

// ── StateMachine ─────────────────────────────────────────────

export class StateMachine {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // ── Core transition ────────────────────────────────────────

  /**
   * Validates and applies a state transition.
   * Returns the old state so callers can emit WebSocket events.
   */
  transition(taskId: number, targetState: TaskState, phase?: TaskPhase): TaskState {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`StateMachine: task ${taskId} not found`);
    }

    const currentState = task.state;

    if (!this.isValidTransition(currentState, targetState)) {
      throw new Error(
        `StateMachine: illegal transition for task ${taskId} — ` +
        `"${currentState}" → "${targetState}" is not allowed`
      );
    }

    const resolvedPhase = phase ?? this.getPhaseForState(targetState) ?? null;
    this.db.updateTaskState(taskId, targetState, resolvedPhase);

    return currentState;
  }

  // ── Validity check ─────────────────────────────────────────

  /** Returns true if the transition would be valid without performing it. */
  canTransition(taskId: number, targetState: TaskState): boolean {
    const task = this.db.getTask(taskId);
    if (!task) return false;
    return this.isValidTransition(task.state, targetState);
  }

  // ── Happy-path advance ─────────────────────────────────────

  /**
   * Moves the task one step forward along the happy path:
   *   pending → spec → executing → reviewing → done
   * Returns the new state.
   */
  advancePhase(taskId: number): TaskState {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`StateMachine: task ${taskId} not found`);
    }

    const currentIndex = HAPPY_PATH.indexOf(task.state);
    if (currentIndex === -1) {
      throw new Error(
        `StateMachine: cannot advance task ${taskId} — ` +
        `current state "${task.state}" is not on the happy path`
      );
    }

    const nextState = HAPPY_PATH[currentIndex + 1];
    if (nextState === undefined) {
      throw new Error(
        `StateMachine: cannot advance task ${taskId} — ` +
        `"${task.state}" is already the final happy-path state`
      );
    }

    this.transition(taskId, nextState);
    return nextState;
  }

  // ── Failure with retry logic ───────────────────────────────

  /**
   * Handles task failure:
   * - If retries remain: increments retry count, rewinds to "pending".
   * - If no retries: transitions to "failed".
   */
  fail(taskId: number): void {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`StateMachine: task ${taskId} not found`);
    }

    if (task.retryCount < task.maxRetries) {
      this.db.incrementRetry(taskId);
      this.db.updateTaskState(taskId, "pending", null);
    } else {
      this.transition(taskId, "failed");
    }
  }

  // ── Pause / resume ─────────────────────────────────────────

  /**
   * Transitions the task to "paused".
   * The previous state is implicit from context (e.g. WebSocket events);
   * on resume we conservatively return to "executing".
   */
  pause(taskId: number): void {
    this.transition(taskId, "paused");
  }

  /**
   * Moves the task from "paused" back to "executing".
   */
  resume(taskId: number): void {
    const task = this.db.getTask(taskId);
    if (!task) {
      throw new Error(`StateMachine: task ${taskId} not found`);
    }

    if (task.state !== "paused") {
      throw new Error(
        `StateMachine: cannot resume task ${taskId} — ` +
        `current state is "${task.state}", expected "paused"`
      );
    }

    this.transition(taskId, "executing");
  }

  // ── Skip ───────────────────────────────────────────────────

  /** Transitions the task to "skipped". */
  skip(taskId: number): void {
    this.transition(taskId, "skipped");
  }

  // ── Phase helpers ──────────────────────────────────────────

  /**
   * Maps a TaskState to its corresponding TaskPhase.
   * Returns null for states that have no associated phase.
   */
  getPhaseForState(state: TaskState): TaskPhase | null {
    return STATE_TO_PHASE[state] ?? null;
  }

  // ── Private helpers ────────────────────────────────────────

  private isValidTransition(from: TaskState, to: TaskState): boolean {
    return TRANSITIONS[from]?.has(to) ?? false;
  }
}
