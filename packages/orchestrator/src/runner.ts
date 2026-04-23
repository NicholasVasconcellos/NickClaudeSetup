import path from "node:path";
import fs from "node:fs";
import os from "node:os";

import { Database } from "./db.js";
import { GitManager } from "./git.js";
import {
  parsePlanToTasks,
  scaffoldProject,
  listProjects,
  agentParsePlan,
  loadSkillBody,
  readParsePlanState,
  readParsePlanMeta,
  loadTaskDefs,
  insertTaskDefs,
  parsePlanMetaPath,
  parseSessionIdFromLine,
} from "./project.js";
import { ClaudeRunner } from "./claude.js";
import { StateMachine } from "./state-machine.js";
import { EventBus } from "./ws-server.js";
import { LearningPipeline } from "./learning.js";
import { buildBlockedByMap, validateDAG } from "./dag.js";

import type {
  OrchestratorConfig,
  Task,
  TaskPhase,
  TaskState,
  RunSummary,
  WSEventFromClient,
  ParsePlanMeta,
} from "./types.js";
import { MODEL_CONTEXT_LIMITS, DEFAULT_CONTEXT_LIMIT } from "./types.js";

function extractAssistantText(stdout: string): string {
  if (!stdout.trim()) return "";
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as { type?: string; result?: string };
      if (typeof parsed.result === "string" && parsed.result.length > 0) {
        return parsed.result;
      }
    } catch {
      // skip
    }
  }
  return "";
}

// ── Runner ────────────────────────────────────────────────────

export class Runner {
  db: Database;
  git: GitManager;
  claude: ClaudeRunner;
  stateMachine: StateMachine;
  events: EventBus;
  learning: LearningPipeline;

  private abortController: AbortController;
  private mergeQueue: Promise<void>;
  private paused: boolean;
  private sessionId: number | null;

  private blockedBy: Map<number, Set<number>>;
  private dependentsOf: Map<number, number[]>;
  private activeTasks: number;
  private readyQueue: number[];
  private runResolve: (() => void) | null;
  private notifications: string[];
  private pendingApprovals: Map<number, () => void>;
  private creatingProject: string | null;
  private activeAbortControllers: Map<number, AbortController>;
  /** In human_review mode, task IDs waiting for an explicit task:start click. */
  private awaitingStart: Set<number>;

  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;

    this.db = new Database(config.dbPath);
    this.git = new GitManager(config);
    this.claude = new ClaudeRunner(config);
    this.stateMachine = new StateMachine(this.db);
    this.events = new EventBus(config.wsPort);
    this.learning = new LearningPipeline(this.db, this.claude, config);

    this.abortController = new AbortController();
    this.mergeQueue = Promise.resolve();
    this.paused = false;
    this.sessionId = null;
    this.blockedBy = new Map();
    this.dependentsOf = new Map();
    this.activeTasks = 0;
    this.readyQueue = [];
    this.runResolve = null;
    this.notifications = [];
    this.pendingApprovals = new Map();
    this.creatingProject = null;
    this.activeAbortControllers = new Map();
    this.awaitingStart = new Set();
  }

  // ── createTaskAbortController ─────────────────────────────
  //
  // Per-task controller that inherits aborts from the run-wide controller AND
  // can be individually aborted (e.g. from Pause All). Caller must call
  // cleanup() in a finally block to release the listener and map entry.
  private createTaskAbortController(taskId: number): { signal: AbortSignal; cleanup: () => void } {
    const ctrl = new AbortController();
    this.activeAbortControllers.set(taskId, ctrl);

    const onRunAbort = () => ctrl.abort();
    if (this.abortController.signal.aborted) {
      ctrl.abort();
    } else {
      this.abortController.signal.addEventListener("abort", onRunAbort, { once: true });
    }

    const cleanup = () => {
      this.abortController.signal.removeEventListener("abort", onRunAbort);
      if (this.activeAbortControllers.get(taskId) === ctrl) {
        this.activeAbortControllers.delete(taskId);
      }
    };

    return { signal: ctrl.signal, cleanup };
  }

  // ── swapDatabase ─────────────────────────────────────────
  //
  // Close the current DB and reopen at `dbPath`, propagating the new
  // instance to helpers that cached a reference at construction time
  // (StateMachine, LearningPipeline). Also rebuilds GitManager against
  // the updated config.projectDir — callers must set config.projectDir
  // before calling this.
  private swapDatabase(dbPath: string): void {
    this.db.close();
    this.config.dbPath = dbPath;
    this.db = new Database(dbPath);
    this.db.init();
    this.stateMachine.setDb(this.db);
    this.learning.setDb(this.db);
    this.git = new GitManager(this.config);
    this.events.setProjectDir(this.config.projectDir);
    this.recoverInterruptedTasks();
  }

  // Tasks left in a mid-phase state when the orchestrator exited (crash,
  // Ctrl-C, or a graceful shutdown) are stranded because drainReadyQueue
  // only dispatches "pending" tasks. Mark them paused so the dashboard can
  // show them and a user Resume click re-enqueues from the stored session_id.
  private recoverInterruptedTasks(): void {
    const midPhaseStates = ["spec", "executing", "reviewing", "documenting"] as const;
    const stuck = midPhaseStates.flatMap((s) => this.db.getTasksByState(s));
    if (stuck.length === 0) return;

    for (const task of stuck) {
      try {
        this.stateMachine.pause(task.id);
        console.log(`[runner] recovered task ${task.id} (${task.state} → paused, phase=${task.phase ?? "?"})`);
      } catch (err) {
        console.error(`[runner] failed to recover task ${task.id}:`, err);
      }
    }

    const finalized = this.db.finalizeAbandonedAgentRuns();
    if (finalized > 0) {
      console.log(`[runner] finalized ${finalized} abandoned agent_run(s)`);
    }
    console.log(`[runner] recovered ${stuck.length} interrupted task(s) into paused state`);
  }

  // ── init ──────────────────────────────────────────────────

  async init(): Promise<void> {
    // Create database tables
    this.db.init();

    // Crash recovery: clean up any orphaned worktrees from a previous run
    try {
      const orphanCount = await this.git.cleanupOrphanedWorktrees();
      if (orphanCount > 0) {
        console.log(`[runner] cleaned up ${orphanCount} orphaned worktree(s)`);
      }
    } catch (err) {
      console.debug(`[runner] skipped worktree cleanup (not a git repo):`, err instanceof Error ? err.message : err);
    }

    // Start the WebSocket server
    this.events.setProjectDir(this.config.projectDir);
    this.events.start();

    // Register event handlers for dashboard commands
    this.events.onCommand((event) => {
      this.handleCommand(event).catch((err) => {
        console.error("[runner] handleCommand error:", err);
      });
    });

    // Broadcast current project info to newly connected clients
    this.events.broadcast({
      type: "project:info",
      name: path.basename(this.config.projectDir),
      dir: this.config.projectDir,
    });

    // Verify Claude CLI is available
    const claudeAvailable = await this.claude.checkAvailable();
    if (!claudeAvailable) {
      console.warn(
        "[runner] WARNING: claude CLI not found or not responding — tasks will fail"
      );
    } else {
      console.log("[runner] claude CLI available");
    }

    console.log(
      `[runner] initialized — projectDir=${this.config.projectDir} ` +
        `db=${this.config.dbPath} ws=:${this.config.wsPort} ` +
        `concurrency=${this.config.maxConcurrency}`
    );
  }

  // ── run ───────────────────────────────────────────────────

  async run(): Promise<RunSummary> {
    const runStart = Date.now();

    this.notifications = [];

    // Create a new session record
    this.sessionId = this.db.createSession();
    console.log(`[runner] session ${this.sessionId} started`);

    // Set overall timeout
    const timeoutHandle = setTimeout(() => {
      console.warn("[runner] overall timeout reached — aborting");
      this.abortController.abort();
    }, this.config.overallTimeout);

    try {
      // Load and validate task graph
      const allTasks = this.db.getAllTasks();
      const { valid, errors } = validateDAG(allTasks);
      if (!valid) {
        throw new Error(`Invalid task graph: ${errors.join("; ")}`);
      }

      // Build blocked-by map (which deps still need to complete for each task)
      this.blockedBy = buildBlockedByMap(allTasks);

      // Build dependents map (inverse of dependsOn) for O(1) lookup in onTaskSettled
      this.dependentsOf = new Map();
      for (const task of allTasks) {
        for (const depId of task.dependsOn) {
          let list = this.dependentsOf.get(depId);
          if (!list) {
            list = [];
            this.dependentsOf.set(depId, list);
          }
          list.push(task.id);
        }
      }

      // Seed the ready queue with tasks that have no pending dependencies
      for (const task of allTasks) {
        const blocked = this.blockedBy.get(task.id);
        if (task.state === "pending" && blocked && blocked.size === 0) {
          this.readyQueue.push(task.id);
        }
      }

      console.log(
        `[runner] ${allTasks.length} task(s), ${this.readyQueue.length} initially ready`
      );

      // Start executing — drainReadyQueue fires tasks up to maxConcurrency,
      // and the promise resolves when no tasks are active and none are queued.
      if (this.readyQueue.length > 0) {
        this.drainReadyQueue();
        await new Promise<void>((resolve) => {
          this.runResolve = resolve;
        });
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Run the learning pipeline now that all tasks are done
    console.log("[runner] running learning pipeline...");
    const learningsDir = path.join(this.config.projectDir, ".orchestrator/learnings");
    let learningSummary: string | null = null;
    try {
      const result = await this.learning.runPipeline(learningsDir);
      learningSummary = result.summary;
      console.log(
        `[runner] learning pipeline — count=${result.count} summarized=${result.summary !== null}`
      );
    } catch (err) {
      console.error("[runner] learning pipeline failed (non-fatal):", err);
    }

    // Generate summary
    const summary = this._buildSummary(runStart, learningSummary);

    // Persist session finish
    this.db.finishSession(this.sessionId!, null, summary.totalCost);

    // Broadcast completion
    this.events.runCompleted(summary);

    console.log(
      `[runner] run complete — ` +
        `completed=${summary.completed} failed=${summary.failed} skipped=${summary.skipped} ` +
        `cost=$${summary.totalCost.toFixed(4)} duration=${Math.round(summary.duration / 1000)}s`
    );

    return summary;
  }

  // ── drainReadyQueue ─────────────────────────────────────────

  private drainReadyQueue(): void {
    if (this.paused) return;
    if (this.abortController.signal.aborted) return;

    const parked: number[] = [];

    while (
      this.readyQueue.length > 0 &&
      this.activeTasks < this.config.maxConcurrency
    ) {
      const taskId = this.readyQueue.shift()!;
      const task = this.db.getTask(taskId);
      if (!task || task.state !== "pending") continue;

      // In human_review mode, tasks must be explicitly started by the user
      // (the start click is the review checkpoint).
      if (this.config.mode === "human_review" && !this.awaitingStart.has(taskId)) {
        this.awaitingStart.add(taskId);
        this.events.broadcast({ type: "task:awaiting_start", taskId });
        parked.push(taskId);
        continue;
      }
      if (this.awaitingStart.has(taskId)) {
        // Still awaiting a start click — re-park and move on.
        parked.push(taskId);
        continue;
      }

      this.activeTasks++;
      console.log(
        `[runner] starting task ${taskId} (active: ${this.activeTasks}/${this.config.maxConcurrency})`
      );

      this.executeTask(task).finally(() => {
        this.onTaskSettled(taskId);
      });
    }

    // Keep parked tasks in the queue so a later task:start can reach them.
    for (const id of parked) this.readyQueue.push(id);
  }

  // ── onTaskSettled ──────────────────────────────────────────

  private onTaskSettled(taskId: number): void {
    this.activeTasks--;

    if (this.abortController.signal.aborted) {
      this.checkRunComplete();
      return;
    }

    const task = this.db.getTask(taskId);

    if (task && (task.state === "merged" || task.state === "done")) {
      // Success — unblock dependents
      const depIds = this.dependentsOf.get(taskId) ?? [];
      for (const depId of depIds) {
        const blocked = this.blockedBy.get(depId);
        if (!blocked) continue;
        blocked.delete(taskId);

        if (blocked.size === 0) {
          const dep = this.db.getTask(depId);
          if (dep && dep.state === "pending") {
            this.events.taskUnblocked(depId);
            this.readyQueue.push(depId);
            console.log(`[runner] task ${depId} unblocked by task ${taskId}`);
          }
        }
      }
    } else if (task && task.state === "failed") {
      // Permanent failure — stop the entire workflow
      const msg = `Workflow stopped: task #${taskId} "${task.title}" failed after ${task.retryCount}/${task.maxRetries} retries`;
      this.notifications.push(msg);
      this.events.notify(msg, "error");
      console.error(`[runner] ${msg}`);
      this.abortController.abort();
    } else if (task && task.state === "pending" && !this.abortController.signal.aborted && !this.paused) {
      // Rewound for retry — re-enqueue (guard abort so a concurrent failure doesn't
      // sneak a retry into the queue after the workflow has been stopped, and
      // guard paused so rewound tasks don't flood back in while pause is active)
      this.readyQueue.push(taskId);
      console.log(
        `[runner] task ${taskId} re-enqueued for retry (${task.retryCount}/${task.maxRetries})`
      );
    }

    this.drainReadyQueue();
    this.checkRunComplete();
  }

  // ── checkRunComplete ───────────────────────────────────────

  private checkRunComplete(): void {
    if (this.activeTasks > 0 || !this.runResolve) return;
    if (this.readyQueue.length === 0 || this.abortController.signal.aborted) {
      this.runResolve();
      this.runResolve = null;
    }
  }

  // ── runPhase ─────────────────────────────────────────────

  private static readonly PHASE_STATE: Record<Exclude<TaskPhase, "merge">, TaskState> = {
    spec: "spec",
    execute: "executing",
    review: "reviewing",
    document: "documenting",
  };

  private async runPhase(
    taskId: number,
    phase: Exclude<TaskPhase, "merge">,
    worktreePath: string,
    signal: AbortSignal,
    resumeSessionId?: string,
  ): Promise<void> {
    const targetState = Runner.PHASE_STATE[phase];
    const model = this.config.models[phase];

    const task = this.db.getTask(taskId)!;
    const oldState = this.stateMachine.transition(taskId, targetState);
    this.events.taskStateChanged(taskId, oldState, targetState, task.title);
    this.events.agentStarted(taskId, phase, model);
    const effort = task.effort ?? this.config.phaseEffortDefaults[phase];
    const runId = this.db.startAgentRun(taskId, phase, model);
    const prompt = this.buildPrompt(task, phase);
    if (resumeSessionId) {
      console.log(`[task:${taskId}] resuming ${phase} from session ${resumeSessionId}`);
    }

    let capturedSessionId: string | null = resumeSessionId ?? null;
    const result = await this.claude.runTask({
      prompt,
      cwd: worktreePath,
      model,
      effort,
      timeout: this.config.taskTimeout,
      signal,
      resumeSessionId,
      onOutput: (line) => {
        this.db.appendLog(taskId, phase, line);
        this.events.taskLogAppend(taskId, line);
        if (!capturedSessionId) {
          const sid = parseSessionIdFromLine(line);
          if (sid) {
            capturedSessionId = sid;
            this.db.setAgentRunSession(runId, sid);
          }
        }
      },
    });

    this.db.finishAgentRun(runId, result.tokensIn, result.tokensOut, result.cost, result.duration);
    const contextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
    // Use fresh tokens only for context pressure — cache-read tokens are already-counted
    // context re-attached by the server and do not compete for the window.
    const tokensUsed = result.tokensIn + result.tokensOut;
    const contextPercentage = Math.min(100, (tokensUsed / contextLimit) * 100);
    this.events.agentFinished(
      taskId, phase, tokensUsed, result.cost,
      result.tokensIn, result.tokensOut, result.cacheRead, result.cacheCreation,
      model, contextLimit, contextPercentage,
    );

    if (result.exitCode !== 0 && !signal.aborted) {
      throw new Error(`${phase} phase failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    console.log(`[task:${taskId}] ${phase} phase done`);
  }

  // ── executeTask ───────────────────────────────────────────

  private async executeTask(task: Task): Promise<void> {
    const { id: taskId } = task;
    const { signal, cleanup: cleanupSignal } = this.createTaskAbortController(taskId);

    let worktreePath: string | null = null;

    try {
      const wt = await this.git.createWorktree(taskId);
      worktreePath = wt.worktreePath;
      this.db.updateTaskWorktree(taskId, wt.worktreePath, wt.branch);
      console.log(`[task:${taskId}] worktree created at ${wt.worktreePath}`);
      this.events.branchUpdate(taskId, wt.branch, "created");

      const allPhases = ["spec", "execute", "review", "document"] as const;
      const currentPhase = task.phase as typeof allPhases[number] | null;
      const startIdx = currentPhase && allPhases.includes(currentPhase as typeof allPhases[number])
        ? allPhases.indexOf(currentPhase as typeof allPhases[number])
        : 0;

      for (const phase of allPhases.slice(startIdx)) {
        const resumeSid = phase === currentPhase
          ? this.db.getLatestSessionId(taskId, phase)
          : null;
        await this.runPhase(taskId, phase, wt.worktreePath, signal, resumeSid ?? undefined);
        if (signal.aborted) return;
      }

      // ── Transition to done, then enqueue merge ─────────────
      {
        const oldState = this.stateMachine.transition(taskId, "done");
        this.events.taskStateChanged(taskId, oldState, "done", task.title);
      }

      await this.enqueueMerge(taskId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[task:${taskId}] error: ${errorMsg}`);

      const freshTask = this.db.getTask(taskId);
      const currentPhase = freshTask?.phase ?? "execute";
      this.learning.capture(taskId, currentPhase, `Execution error: ${errorMsg}`);

      try {
        this.stateMachine.fail(taskId);
        const updatedTask = this.db.getTask(taskId);
        const newState = updatedTask?.state ?? "failed";
        this.events.taskStateChanged(taskId, freshTask?.state ?? "executing", newState, freshTask?.title);
        console.log(
          `[task:${taskId}] state after failure: ${newState} ` +
            `(retry ${updatedTask?.retryCount ?? "?"}/${updatedTask?.maxRetries ?? "?"})`
        );
      } catch (smErr) {
        console.error(`[task:${taskId}] state machine fail() threw:`, smErr);
      }
    } finally {
      cleanupSignal();
      if (worktreePath !== null) {
        const finalTask = this.db.getTask(taskId);
        if (finalTask && finalTask.state !== "merged" && finalTask.state !== "done") {
          await this.git.removeWorktree(taskId).catch((e) => {
            console.warn(`[task:${taskId}] worktree cleanup failed (non-fatal):`, e);
          });
          this.db.updateTaskWorktree(taskId, null, null);
          this.events.branchUpdate(taskId, `task/${taskId}`, "deleted");
        }
      }
    }
  }

  // ── enqueueMerge ─────────────────────────────────────────

  private async enqueueMerge(taskId: number): Promise<void> {
    // Chain onto the sequential merge queue so only one merge runs at a time
    this.mergeQueue = this.mergeQueue.then(() => this._doMerge(taskId));
    await this.mergeQueue;
  }

  private async _doMerge(taskId: number): Promise<void> {
    console.log(`[task:${taskId}] merging...`);

    const { success, conflicts } = await this.git.mergeTask(taskId);

    if (success) {
      this.db.recordMerge(taskId, "success", false);
      await this._finalizeMerge(taskId, "merged successfully");
    } else {
      // Merge conflict — spawn an agent to resolve it before giving up.
      // The working tree still has conflict markers at this point.
      console.warn(
        `[task:${taskId}] merge conflict in: ${conflicts.join(", ") || "(unknown files)"}`
      );

      this.db.recordMerge(taskId, "conflict", false);

      const resolved = await this._attemptConflictResolution(taskId, conflicts);

      if (resolved) {
        this.db.recordMerge(taskId, "success", true);
        await this._finalizeMerge(taskId, "merge conflict resolved and merged");
      } else {
        // Agent couldn't resolve — abort merge and fail the task
        try {
          await this.git.abortMerge();
        } catch (abortErr) {
          console.warn(`[task:${taskId}] merge abort failed:`, abortErr);
        }

        this.learning.capture(
          taskId,
          "merge",
          `Merge conflict in files: ${conflicts.join(", ")} — automatic resolution failed`
        );

        this.stateMachine.fail(taskId);
        const updatedTask = this.db.getTask(taskId);
        const newState = updatedTask?.state ?? "failed";
        this.events.taskStateChanged(taskId, "done", newState, updatedTask?.title);
      }
    }

    // Clean up worktree now that merge is settled
    await this.git.removeWorktree(taskId).catch((e) => {
      console.warn(`[task:${taskId}] post-merge worktree cleanup failed:`, e);
    });
    this.db.updateTaskWorktree(taskId, null, null);
  }

  // ── _finalizeMerge ──────────────────────────────────────────

  private async _finalizeMerge(taskId: number, logMsg: string): Promise<void> {
    try {
      const changedFiles = await this.git.getFilesChangedByMerge();
      this.db.updateFilesChanged(taskId, changedFiles);
    } catch (err) {
      console.warn(`[task:${taskId}] failed to record files changed:`, err);
    }

    if (this.config.pushAfterMerge) {
      try {
        await this.git.push();
        console.log(`[task:${taskId}] pushed to remote`);
      } catch (pushErr) {
        console.warn(`[task:${taskId}] push failed (non-fatal):`, pushErr);
      }
    }

    const oldState = this.stateMachine.transition(taskId, "merged");
    this.events.taskStateChanged(taskId, oldState, "merged", this.db.getTask(taskId)?.title);
    this.events.branchUpdate(taskId, `task/${taskId}`, "merged");
    console.log(`[task:${taskId}] ${logMsg}`);

    // Fire-and-forget suggestion generation
    this.generateSuggestions(taskId).catch(err => {
      console.warn(`[task:${taskId}] suggestion generation failed (non-fatal):`, err);
    });
  }

  // ── generateSuggestions ──────────────────────────────────────

  private async generateSuggestions(taskId: number): Promise<void> {
    const task = this.db.getTask(taskId);
    if (!task) return;

    const prompt = `You just completed this task: "${task.title}"
Description: ${task.description}

Files changed: ${task.filesChanged.join(", ") || "unknown"}

Based on what was implemented, suggest 1-3 follow-up features or improvements that would complement this work. For each suggestion, provide:
- A short title (under 60 chars)
- A 1-2 sentence description

Format your response as JSON array:
[{"title": "...", "description": "..."}]

Only suggest genuinely useful follow-ups, not generic advice. If nothing comes to mind, return an empty array [].`;

    const result = await this.claude.runTask({
      prompt,
      cwd: this.config.projectDir,
      model: this.config.models.learning,
      effort: "low",
      timeout: 60_000,
    });

    if (result.exitCode !== 0) return;

    // Parse suggestions from output
    const text = this.extractResultText(result.stdout);
    let suggestions: Array<{ title: string; description: string }> = [];

    try {
      const jsonMatch = text.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        suggestions = JSON.parse(jsonMatch[0]);
      }
    } catch {
      return;
    }

    if (!Array.isArray(suggestions) || suggestions.length === 0) return;

    // Save to .orchestrator/suggestions/
    const fs = await import("fs");
    const suggestionsDir = path.join(this.config.projectDir, ".orchestrator/suggestions");
    fs.mkdirSync(suggestionsDir, { recursive: true });

    for (const suggestion of suggestions) {
      if (!suggestion.title || !suggestion.description) continue;

      const safeName = suggestion.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
      const filePath = path.join(suggestionsDir, `${safeName}.md`);

      const content = `# ${suggestion.title}\n\n${suggestion.description}\n\n---\nGenerated after task #${taskId}: ${task.title}\n`;
      fs.writeFileSync(filePath, content, "utf8");

      this.events.suggestionNew(suggestion.title, suggestion.description, filePath);
      console.log(`[task:${taskId}] suggestion: ${suggestion.title}`);
    }
  }

  // ── extractResultText ──────────────────────────────────────

  private extractResultText(stdout: string): string {
    const lines = stdout.split("\n").filter(l => l.trim().startsWith("{"));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed.result === "string") return parsed.result;
      } catch { /* skip */ }
    }
    try {
      const parsed = JSON.parse(stdout.trim());
      if (typeof parsed.result === "string") return parsed.result;
    } catch { /* skip */ }
    return stdout;
  }

  // ── _attemptConflictResolution ─────────────────────────────

  /**
   * Spawns a Claude agent to resolve merge conflicts in the working tree.
   * Called while the merge is still in a conflicted state (markers present).
   * Returns true if the agent resolved the conflicts and committed.
   */
  private async _attemptConflictResolution(
    taskId: number,
    conflicts: string[]
  ): Promise<boolean> {
    const phase: TaskPhase = "merge";
    const model = this.config.models.merge;

    console.log(
      `[task:${taskId}] spawning merge-resolution agent for: ${conflicts.join(", ")}`
    );

    this.events.agentStarted(taskId, phase, model);
    const runId = this.db.startAgentRun(taskId, phase, model);

    // Gather context: branch logs + conflict diff
    let context: string;
    try {
      context = await this.git.getConflictContext(taskId);
    } catch (err) {
      console.warn(`[task:${taskId}] failed to gather conflict context:`, err);
      context = `Conflicted files: ${conflicts.join(", ")}`;
    }

    const prompt =
      `## Merge Conflict Resolution — Task #${taskId}\n\n` +
      `A merge from branch task/${taskId} into ${this.config.mainBranch} has produced conflicts.\n` +
      `The working tree contains conflict markers that you must resolve.\n\n` +
      `${context}\n\n` +
      `## Instructions\n` +
      `1. Read each conflicted file and understand the intent of BOTH sides.\n` +
      `2. Resolve every conflict — remove all <<<<<<< / ======= / >>>>>>> markers.\n` +
      `3. The result must preserve the intent of both the task branch and the main branch changes.\n` +
      `4. Do NOT delete functionality from either side unless it is truly redundant.\n` +
      `5. After resolving, run any available tests to verify nothing is broken.\n` +
      `6. Do NOT commit — the orchestrator will handle staging and committing.`;

    const effort = this.config.phaseEffortDefaults[phase];

    const { signal: mergeSignal, cleanup: cleanupMergeSignal } = this.createTaskAbortController(taskId);

    let result;
    try {
      result = await this.claude.runTask({
        prompt,
        cwd: this.config.projectDir,
        model,
        effort,
        timeout: this.config.taskTimeout,
        signal: mergeSignal,
        onOutput: (line) => {
          this.db.appendLog(taskId, phase, line);
          this.events.taskLogAppend(taskId, line);
        },
      });
    } finally {
      cleanupMergeSignal();
    }

    this.db.finishAgentRun(
      runId,
      result.tokensIn,
      result.tokensOut,
      result.cost,
      result.duration
    );
    const mergeContextLimit = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
    const mergeTokensUsed = result.tokensIn + result.tokensOut;
    const mergeContextPct = Math.min(100, (mergeTokensUsed / mergeContextLimit) * 100);
    this.events.agentFinished(
      taskId, phase, mergeTokensUsed, result.cost,
      result.tokensIn, result.tokensOut, result.cacheRead, result.cacheCreation,
      model, mergeContextLimit, mergeContextPct,
    );

    if (result.exitCode !== 0) {
      console.error(
        `[task:${taskId}] merge-resolution agent failed (exit ${result.exitCode})`
      );
      return false;
    }

    // Agent finished — try to stage and commit the resolved merge
    const committed = await this.git.stageAndCommitMerge(taskId);
    if (!committed) {
      console.error(
        `[task:${taskId}] merge-resolution agent ran but commit failed (unresolved markers?)`
      );
      return false;
    }

    return true;
  }

  // ── buildPrompt ───────────────────────────────────────────

  private buildPrompt(task: Task, phase: TaskPhase): string {
    const { titles, files } = this.db.getCompletedTaskContext(task.dependsOn);

    const taskSection =
      `## Task #${task.id}: ${task.title}\n\n` +
      task.description;

    const depTitleSection = titles.length > 0
      ? `\n\n## Completed dependency tasks\n${titles}`
      : "";

    const ctxFileRefs = task.contextFiles.length > 0
      ? `\n\n## Context files\n${task.contextFiles.map(f => `@${f}`).join(" ")}`
      : "";

    const depFileRefs = files.length > 0
      ? `\n\n## Dependency files\n${files.map(f => `@${f}`).join(" ")}`
      : "";

    // Inline the phase skill (slash command doesn't work), merge phase has no skill.
    const skillBody = phase !== "merge" ? loadSkillBody(this.config.projectDir, phase) : "";
    const skillSection = skillBody ? `${skillBody}\n\n---\n\n` : "";

    return `${skillSection}${taskSection}${depTitleSection}${ctxFileRefs}${depFileRefs}`;
  }

  // ── waitForApproval ──────────────────────────────────────

  private async waitForApproval(taskId: number): Promise<void> {
    const task = this.db.getTask(taskId)!;
    let gitDiff = "";
    try {
      gitDiff = await this.git.getWorktreeDiff(taskId);
    } catch { gitDiff = "(diff unavailable)"; }

    const logs = this.db.getTaskLogs(taskId);
    const agentLogSummary = logs.slice(-20).map(l => l.content).join("\n");

    this.events.taskNeedsReview(taskId, gitDiff, agentLogSummary);
    console.log(`[task:${taskId}] waiting for human approval...`);

    return new Promise<void>((resolve) => {
      this.pendingApprovals.set(taskId, resolve);
    });
  }

  // ── loadPlanFromMarkdown ────────────────────────────────────

  private loadPlanFromMarkdown(markdown: string): number {
    const result = parsePlanToTasks(this.db, markdown, this.config.useMilestones);

    if (result.errors.length > 0) {
      throw new Error(`Plan parsing errors:\n${result.errors.join("\n")}`);
    }

    // Emit WS events for each created task
    for (const task of result.tasks) {
      this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
      this.events.taskCreated(task.id, task.title);
    }

    return result.taskCount;
  }

  // ── loadPlanWithAgent ────────────────────────────────────────

  /**
   * Spawns a Claude agent with /get-tasks skill + ultrathink to parse
   * a plan into structured tasks. The most critical step of project setup.
   */
  async loadPlanWithAgent(planContent: string): Promise<number> {
    console.log("[runner] spawning agent to decompose plan (ultrathink)...");

    // Persist pasted plan to disk so downstream phases/agents see the real content.
    try {
      fs.writeFileSync(path.join(this.config.projectDir, "plan.md"), planContent);
    } catch (err) {
      console.warn("[runner] failed to write plan.md:", err);
    }

    const projectName = path.basename(this.config.projectDir);
    const planModel = this.config.models.planning;
    const planEffort = this.config.planningEffort;
    const planContextLimit = MODEL_CONTEXT_LIMITS[planModel] ?? DEFAULT_CONTEXT_LIMIT;

    this.events.broadcast({
      type: "project:create_agent_started",
      projectName,
      model: planModel,
      effort: planEffort,
    });

    const result = await agentParsePlan({
      claude: this.claude,
      db: this.db,
      planContent,
      projectDir: this.config.projectDir,
      model: planModel, // opus + max thinking for plan parsing
      effort: planEffort, // ultrathink — most important step
      timeout: this.config.taskTimeout,
      onOutput: (line) => {
        this.events.taskLogAppend(-1, line); // -1 = plan parsing pseudo-task
        this.events.broadcast({ type: "project:create_log", projectName, line });
      },
      onUsage: (usage) => {
        const used = usage.tokensIn + usage.tokensOut;
        const pct = Math.min(100, (used / planContextLimit) * 100);
        this.events.broadcast({
          type: "project:create_agent_usage",
          projectName,
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          cost: usage.cost,
          contextLimit: planContextLimit,
          contextPercentage: pct,
          subagentCount: usage.subagentCount,
        });
      },
    });

    const finalUsage = result.usage ?? { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 };
    const finalUsed = finalUsage.tokensIn + finalUsage.tokensOut;
    const finalPct = Math.min(100, (finalUsed / planContextLimit) * 100);
    this.events.broadcast({
      type: "project:create_agent_finished",
      projectName,
      model: result.model ?? planModel,
      tokensIn: finalUsage.tokensIn,
      tokensOut: finalUsage.tokensOut,
      cost: finalUsage.cost,
      contextLimit: planContextLimit,
      contextPercentage: finalPct,
      subagentCount: finalUsage.subagentCount,
    });

    if (result.errors.length > 0) {
      const errMsg = result.errors.join("\n");
      this.events.notify(`Plan parsing errors:\n${errMsg}`, "error");
      throw new Error(`Agent plan parsing errors:\n${errMsg}`);
    }

    // Emit WS events for each created task
    for (const task of result.tasks) {
      this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
      this.events.taskCreated(task.id, task.title);
    }

    this.events.planLoaded(result.taskCount);
    console.log(`[runner] agent created ${result.taskCount} tasks from plan`);
    return result.taskCount;
  }

  // ── handleCommand ─────────────────────────────────────────

  async handleCommand(event: WSEventFromClient): Promise<void> {
    switch (event.type) {
      case "task:pause": {
        const { taskId } = event;
        try {
          const t = this.db.getTask(taskId);
          this.stateMachine.pause(taskId);
          this.events.taskStateChanged(taskId, t?.state ?? "paused", "paused", t?.title);
          console.log(`[runner] task ${taskId} paused`);
        } catch (err) {
          console.error(`[runner] pause task ${taskId} failed:`, err);
        }
        break;
      }

      case "task:resume": {
        const { taskId } = event;
        try {
          const t = this.db.getTask(taskId);
          this.stateMachine.resume(taskId);
          this.events.taskStateChanged(taskId, "paused", "pending", t?.title);
          this.readyQueue.push(taskId);
          this.drainReadyQueue();
          console.log(`[runner] task ${taskId} resumed (phase=${t?.phase ?? "spec"})`);
        } catch (err) {
          console.error(`[runner] resume task ${taskId} failed:`, err);
        }
        break;
      }

      case "task:retry": {
        const { taskId } = event;
        try {
          const t = this.db.getTask(taskId);
          if (!t) {
            console.warn(`[runner] retry: task ${taskId} not found`);
            break;
          }
          const prevState = t.state;
          this.db.updateTaskState(taskId, "pending", null);
          this.events.taskStateChanged(taskId, prevState, "pending", t.title);
          console.log(`[runner] task ${taskId} reset to pending for retry`);

          // Enqueue for execution through the normal flow
          this.readyQueue.push(taskId);
          this.drainReadyQueue();
        } catch (err) {
          console.error(`[runner] retry task ${taskId} failed:`, err);
        }
        break;
      }

      case "task:skip": {
        const { taskId } = event;
        try {
          const t = this.db.getTask(taskId);
          if (!t) {
            console.warn(`[runner] skip: task ${taskId} not found`);
            break;
          }
          const prevState = t.state;
          this.stateMachine.skip(taskId);
          this.events.taskStateChanged(taskId, prevState, "skipped", t.title);
          console.log(`[runner] task ${taskId} skipped`);
        } catch (err) {
          console.error(`[runner] skip task ${taskId} failed:`, err);
        }
        break;
      }

      case "run:pause_all":
        this.paused = true;
        for (const [tid, ctrl] of this.activeAbortControllers) {
          try {
            ctrl.abort();
            console.log(`[runner] pause aborted active task ${tid}`);
          } catch (err) {
            console.warn(`[runner] failed to abort task ${tid}:`, err);
          }
        }
        console.log("[runner] run paused");
        break;

      case "run:resume_all":
        this.paused = false;
        console.log("[runner] run resumed");
        this.drainReadyQueue();
        break;

      case "task:approve": {
        const { taskId } = event;
        const resolver = this.pendingApprovals.get(taskId);
        if (resolver) {
          this.pendingApprovals.delete(taskId);
          resolver();
          console.log(`[runner] task ${taskId} approved`);
        } else {
          console.warn(`[runner] approve: no pending approval for task ${taskId}`);
        }
        break;
      }

      case "task:start": {
        const { taskId } = event;
        if (!this.awaitingStart.has(taskId)) {
          console.warn(`[runner] task:start: task ${taskId} not awaiting start`);
          break;
        }
        this.awaitingStart.delete(taskId);
        console.log(`[runner] task ${taskId} start approved by user`);
        this.drainReadyQueue();
        break;
      }

      case "prompt:submit": {
        const { taskId, prompt } = event;
        try {
          const model = this.config.models.planning ?? this.config.models.execute;
          const result = await this.claude.runTask({
            prompt,
            cwd: this.config.projectDir,
            model,
            effort: "medium",
            timeout: 5 * 60 * 1000,
          });
          const text = extractAssistantText(result.stdout) || result.stderr || "(no response)";
          this.events.promptResponse(taskId, text);
          console.log(`[runner] prompt:submit task=${taskId} responded (${text.length} chars, $${result.cost.toFixed(4)})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.promptResponse(taskId, `Error: ${msg}`);
          console.error(`[runner] prompt:submit failed:`, err);
        }
        break;
      }

      case "plan:load": {
        const { markdown } = event as { type: "plan:load"; markdown: string };
        try {
          const taskCount = await this.loadPlanWithAgent(markdown);
          console.log(`[runner] loaded ${taskCount} tasks from plan`);
        } catch (err) {
          console.error("[runner] plan:load failed:", err);
          this.events.notify(`Plan load failed: ${err}`, "error");
        }
        break;
      }

      case "run:start": {
        const { mode } = event as { type: "run:start"; mode: "automated" | "human_review" };
        this.config.mode = mode;
        console.log(`[runner] starting run in ${mode} mode`);
        // Don't await — run in background so WS stays responsive
        this.run().catch(err => {
          console.error("[runner] run failed:", err);
          this.events.notify(`Run failed: ${err}`, "error");
        });
        break;
      }

      case "task:create": {
        const { title, description, dependsOn, milestone, effort } = event as any;
        try {
          const task = this.db.createTask(title, description, dependsOn ?? [], milestone);
          this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
          this.events.taskCreated(task.id, task.title);
          console.log(`[runner] created task ${task.id}: ${title}`);
        } catch (err) {
          console.error("[runner] task:create failed:", err);
        }
        break;
      }

      case "project:create": {
        const { projectName, baseDir, planMarkdown, planPath } = event as {
          type: "project:create";
          projectName: string;
          baseDir: string;
          planMarkdown?: string;
          planPath?: string;
        };

        if (this.creatingProject) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "concurrent",
            error: `Another project creation is already in progress (${this.creatingProject}). Wait for it to finish or restart the server.`,
          });
          break;
        }
        this.creatingProject = projectName;

        try {
          // planPath takes precedence over pasted markdown
          let effectivePlan: string | undefined = planMarkdown;
          if (planPath && planPath.trim()) {
            const resolvedPath = planPath.startsWith("~")
              ? path.join(os.homedir(), planPath.slice(1))
              : path.resolve(planPath);
            try {
              effectivePlan = fs.readFileSync(resolvedPath, "utf-8");
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.events.broadcast({
                type: "project:create_error",
                kind: "plan_read",
                error: `Could not read plan file at ${resolvedPath}: ${msg}`,
              });
              return;
            }
          }

          this.events.broadcast({
            type: "project:create_progress",
            stage: "scaffolding",
            projectName,
            message: `Scaffolding ${projectName} in ${baseDir}...`,
          });

          let result;
          try {
            result = scaffoldProject({ projectName, baseDir, planMarkdown: effectivePlan });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const collision = /already exists and is not empty/i.test(msg);
            const attemptedDir = path.resolve(
              baseDir.startsWith("~") ? path.join(os.homedir(), baseDir.slice(1)) : baseDir,
            );
            this.events.broadcast({
              type: "project:create_error",
              kind: collision ? "collision" : "scaffold",
              error: msg,
              projectDir: attemptedDir,
            });
            console.error("[runner] project:create scaffold failed:", err);
            return;
          }

          this.events.broadcast({
            type: "project:create_progress",
            stage: "scaffolded",
            projectName,
            projectDir: result.projectDir,
            message: `Scaffold complete at ${result.projectDir}.`,
          });

          // Re-point Runner to new project
          this.config.projectDir = result.projectDir;
          this.swapDatabase(result.dbPath);

          let taskCount = 0;
          if (effectivePlan) {
            this.events.broadcast({
              type: "project:create_progress",
              stage: "parsing_plan",
              projectName,
              projectDir: result.projectDir,
              message: "Parsing plan with Claude (ultrathink). This may take several minutes...",
            });
            console.log("[runner] spawning agent to decompose plan (ultrathink)...");

            const planModel = this.config.models.planning;
            const planEffort = this.config.planningEffort;
            const planContextLimit = MODEL_CONTEXT_LIMITS[planModel] ?? DEFAULT_CONTEXT_LIMIT;
            this.events.broadcast({
              type: "project:create_agent_started",
              projectName,
              model: planModel,
              effort: planEffort,
            });

            const parseResult = await agentParsePlan({
              claude: this.claude,
              db: this.db,
              planContent: effectivePlan,
              projectDir: result.projectDir,
              projectName,
              model: planModel,
              effort: planEffort,
              // Parse-plan is a one-shot ultrathink call; it takes longer than per-task
              // execution. Override the shared 10-min task budget to 30 min here.
              timeout: 30 * 60 * 1000,
              onOutput: (line) => {
                this.events.broadcast({
                  type: "project:create_log",
                  projectName,
                  line,
                });
              },
              onUsage: (usage) => {
                const used = usage.tokensIn + usage.tokensOut;
                const pct = Math.min(100, (used / planContextLimit) * 100);
                this.events.broadcast({
                  type: "project:create_agent_usage",
                  projectName,
                  tokensIn: usage.tokensIn,
                  tokensOut: usage.tokensOut,
                  cost: usage.cost,
                  contextLimit: planContextLimit,
                  contextPercentage: pct,
                  subagentCount: usage.subagentCount,
                });
              },
            });

            const finalUsage = parseResult.usage ?? { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 };
            const finalUsed = finalUsage.tokensIn + finalUsage.tokensOut;
            const finalPct = Math.min(100, (finalUsed / planContextLimit) * 100);
            this.events.broadcast({
              type: "project:create_agent_finished",
              projectName,
              model: parseResult.model ?? planModel,
              tokensIn: finalUsage.tokensIn,
              tokensOut: finalUsage.tokensOut,
              cost: finalUsage.cost,
              contextLimit: planContextLimit,
              contextPercentage: finalPct,
              subagentCount: finalUsage.subagentCount,
            });

            if (parseResult.errors.length > 0) {
              const errMsg = parseResult.errors.join("\n");
              this.events.broadcast({
                type: "project:create_error",
                kind: parseResult.timedOut ? "plan_parse_timeout" : "plan_parse",
                error: `Plan parsing errors:\n${errMsg}`,
                projectDir: result.projectDir,
              });
              console.error("[runner] plan parse failed:", errMsg);
              return;
            }

            for (const task of parseResult.tasks) {
              this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
              this.events.taskCreated(task.id, task.title);
            }
            taskCount = parseResult.taskCount;
            this.events.planLoaded(taskCount);
            console.log(`[runner] agent created ${taskCount} tasks from plan`);

            this.events.broadcast({
              type: "project:create_progress",
              stage: "plan_parsed",
              projectName,
              projectDir: result.projectDir,
              taskCount,
              message: `Parsed ${taskCount} task${taskCount === 1 ? "" : "s"} from plan.`,
            });
          }

          this.events.broadcast({
            type: "project:create_progress",
            stage: "done",
            projectName,
            projectDir: result.projectDir,
            taskCount,
            message: "Project ready.",
          });
          this.events.broadcast({
            type: "project:created",
            projectDir: result.projectDir,
            dbPath: result.dbPath,
            taskCount,
          });
          this.events.broadcast({
            type: "project:info",
            name: projectName,
            dir: result.projectDir,
          });
          console.log(`[runner] created project: ${result.projectDir} (${taskCount} tasks)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({ type: "project:create_error", kind: "unknown", error: msg });
          console.error("[runner] project:create failed:", err);
        } finally {
          this.creatingProject = null;
        }
        break;
      }

      case "project:list": {
        const { baseDir } = event as { type: "project:list"; baseDir: string };
        try {
          const projects = listProjects(baseDir);
          this.events.broadcast({ type: "project:list_result", projects });
        } catch (err) {
          console.error("[runner] project:list failed:", err);
        }
        break;
      }

      case "project:create_log_tail": {
        const { projectDir } = event as { type: "project:create_log_tail"; projectDir: string };
        const resolvedDir = projectDir.startsWith("~")
          ? path.join(os.homedir(), projectDir.slice(1))
          : path.resolve(projectDir);
        const state = readParsePlanState(resolvedDir);
        const projectName = state.meta?.projectName ?? path.basename(resolvedDir);
        this.events.broadcast({
          type: "project:create_log_replay_start",
          projectDir: resolvedDir,
          projectName,
          meta: state.meta,
        });
        for (const line of state.logLines) {
          this.events.broadcast({ type: "project:create_log", projectName, line });
        }
        this.events.broadcast({ type: "project:create_log_replay_end", projectDir: resolvedDir });
        break;
      }

      case "project:retry_parse": {
        const { projectDir } = event as { type: "project:retry_parse"; projectDir: string };
        const resolvedDir = projectDir.startsWith("~")
          ? path.join(os.homedir(), projectDir.slice(1))
          : path.resolve(projectDir);
        const projectName = path.basename(resolvedDir);

        if (this.creatingProject) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "concurrent",
            error: `Another project creation is already in progress (${this.creatingProject}). Wait for it to finish.`,
          });
          break;
        }

        // Read the scaffold's plan.md (written by scaffoldProject).
        const planPath = path.join(resolvedDir, "plan.md");
        let effectivePlan: string;
        try {
          effectivePlan = fs.readFileSync(planPath, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({
            type: "project:create_error",
            kind: "plan_read",
            error: `Could not read plan.md at ${planPath}: ${msg}`,
            projectDir: resolvedDir,
          });
          break;
        }

        const dbPath = path.join(resolvedDir, ".orchestrator/orchestrator.db");
        if (!fs.existsSync(dbPath)) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "scaffold",
            error: `No orchestrator DB at ${dbPath}. Retry is only valid for previously-scaffolded projects.`,
            projectDir: resolvedDir,
          });
          break;
        }

        this.creatingProject = projectName;
        try {
          // Re-point Runner to the retry project (same pattern as project:create).
          this.config.projectDir = resolvedDir;
          this.swapDatabase(dbPath);

          // Refuse retry if tasks already exist — agentParsePlan would otherwise
          // double-insert. User must clear the project manually to re-parse.
          const existingTasks = this.db.getAllTasks();
          if (existingTasks.length > 0) {
            this.events.broadcast({
              type: "project:create_error",
              kind: "plan_parse",
              error: `Project already has ${existingTasks.length} tasks. Retry is only valid for empty/failed projects.`,
              projectDir: resolvedDir,
            });
            break;
          }

          this.events.broadcast({
            type: "project:create_progress",
            stage: "scaffolded",
            projectName,
            projectDir: resolvedDir,
            message: `Retrying parse for ${projectName}.`,
          });

          const planModel = this.config.models.planning;
          const planEffort = this.config.planningEffort;
          const planContextLimit = MODEL_CONTEXT_LIMITS[planModel] ?? DEFAULT_CONTEXT_LIMIT;

          this.events.broadcast({
            type: "project:create_progress",
            stage: "parsing_plan",
            projectName,
            projectDir: resolvedDir,
            message: "Re-parsing plan with Claude (ultrathink). This may take several minutes...",
          });
          this.events.broadcast({
            type: "project:create_agent_started",
            projectName,
            model: planModel,
            effort: planEffort,
          });

          const parseResult = await agentParsePlan({
            claude: this.claude,
            db: this.db,
            planContent: effectivePlan,
            projectDir: resolvedDir,
            projectName,
            model: planModel,
            effort: planEffort,
            timeout: 30 * 60 * 1000,
            onOutput: (line) => {
              this.events.broadcast({ type: "project:create_log", projectName, line });
            },
            onUsage: (usage) => {
              const used = usage.tokensIn + usage.tokensOut;
              const pct = Math.min(100, (used / planContextLimit) * 100);
              this.events.broadcast({
                type: "project:create_agent_usage",
                projectName,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                cost: usage.cost,
                contextLimit: planContextLimit,
                contextPercentage: pct,
                subagentCount: usage.subagentCount,
              });
            },
          });

          const finalUsage = parseResult.usage ?? { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 };
          const finalUsed = finalUsage.tokensIn + finalUsage.tokensOut;
          const finalPct = Math.min(100, (finalUsed / planContextLimit) * 100);
          this.events.broadcast({
            type: "project:create_agent_finished",
            projectName,
            model: parseResult.model ?? planModel,
            tokensIn: finalUsage.tokensIn,
            tokensOut: finalUsage.tokensOut,
            cost: finalUsage.cost,
            contextLimit: planContextLimit,
            contextPercentage: finalPct,
            subagentCount: finalUsage.subagentCount,
          });

          if (parseResult.errors.length > 0) {
            const errMsg = parseResult.errors.join("\n");
            this.events.broadcast({
              type: "project:create_error",
              kind: parseResult.timedOut ? "plan_parse_timeout" : "plan_parse",
              error: `Plan parsing errors:\n${errMsg}`,
              projectDir: resolvedDir,
            });
            console.error("[runner] retry plan parse failed:", errMsg);
            break;
          }

          for (const task of parseResult.tasks) {
            this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
            this.events.taskCreated(task.id, task.title);
          }
          const taskCount = parseResult.taskCount;
          this.events.planLoaded(taskCount);

          this.events.broadcast({
            type: "project:create_progress",
            stage: "plan_parsed",
            projectName,
            projectDir: resolvedDir,
            taskCount,
            message: `Re-parsed ${taskCount} task${taskCount === 1 ? "" : "s"} from plan.`,
          });
          this.events.broadcast({
            type: "project:create_progress",
            stage: "done",
            projectName,
            projectDir: resolvedDir,
            taskCount,
            message: "Project ready.",
          });
          this.events.broadcast({
            type: "project:created",
            projectDir: resolvedDir,
            dbPath,
            taskCount,
          });
          this.events.broadcast({ type: "project:info", name: projectName, dir: resolvedDir });
          console.log(`[runner] retry-parsed project: ${resolvedDir} (${taskCount} tasks)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({ type: "project:create_error", kind: "unknown", error: msg, projectDir: resolvedDir });
          console.error("[runner] project:retry_parse failed:", err);
        } finally {
          this.creatingProject = null;
        }
        break;
      }

      case "project:resume_parse": {
        const { projectDir } = event as { type: "project:resume_parse"; projectDir: string };
        const resolvedDir = projectDir.startsWith("~")
          ? path.join(os.homedir(), projectDir.slice(1))
          : path.resolve(projectDir);
        const projectName = path.basename(resolvedDir);

        const meta = readParsePlanMeta(resolvedDir);
        if (!meta || !meta.sessionId) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "plan_parse",
            error: "No session to resume. Use Retry parse instead.",
            projectDir: resolvedDir,
          });
          break;
        }

        if (this.creatingProject) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "concurrent",
            error: `Another project creation is already in progress (${this.creatingProject}). Wait for it to finish.`,
          });
          break;
        }

        const planPath = path.join(resolvedDir, "plan.md");
        let effectivePlan: string;
        try {
          effectivePlan = fs.readFileSync(planPath, "utf-8");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({
            type: "project:create_error",
            kind: "plan_read",
            error: `Could not read plan.md at ${planPath}: ${msg}`,
            projectDir: resolvedDir,
          });
          break;
        }

        const dbPath = path.join(resolvedDir, ".orchestrator/orchestrator.db");
        if (!fs.existsSync(dbPath)) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "scaffold",
            error: `No orchestrator DB at ${dbPath}.`,
            projectDir: resolvedDir,
          });
          break;
        }

        this.creatingProject = projectName;
        try {
          this.config.projectDir = resolvedDir;
          this.swapDatabase(dbPath);

          const existingTasks = this.db.getAllTasks();
          if (existingTasks.length > 0) {
            this.events.broadcast({
              type: "project:create_error",
              kind: "plan_parse",
              error: `Project already has ${existingTasks.length} tasks. Resume is only valid for empty/failed projects.`,
              projectDir: resolvedDir,
            });
            break;
          }

          this.events.broadcast({
            type: "project:create_progress",
            stage: "scaffolded",
            projectName,
            projectDir: resolvedDir,
            message: `Resuming parse for ${projectName} from session ${meta.sessionId.slice(0, 8)}…`,
          });

          const planModel = this.config.models.planning;
          const planEffort = this.config.planningEffort;
          const planContextLimit = MODEL_CONTEXT_LIMITS[planModel] ?? DEFAULT_CONTEXT_LIMIT;

          this.events.broadcast({
            type: "project:create_progress",
            stage: "parsing_plan",
            projectName,
            projectDir: resolvedDir,
            message: "Resuming prior parse session…",
          });
          this.events.broadcast({
            type: "project:create_agent_started",
            projectName,
            model: planModel,
            effort: planEffort,
          });

          const parseResult = await agentParsePlan({
            claude: this.claude,
            db: this.db,
            planContent: effectivePlan,
            projectDir: resolvedDir,
            projectName,
            model: planModel,
            effort: planEffort,
            timeout: 30 * 60 * 1000,
            resumeSessionId: meta.sessionId,
            onOutput: (line) => {
              this.events.broadcast({ type: "project:create_log", projectName, line });
            },
            onUsage: (usage) => {
              const used = usage.tokensIn + usage.tokensOut;
              const pct = Math.min(100, (used / planContextLimit) * 100);
              this.events.broadcast({
                type: "project:create_agent_usage",
                projectName,
                tokensIn: usage.tokensIn,
                tokensOut: usage.tokensOut,
                cost: usage.cost,
                contextLimit: planContextLimit,
                contextPercentage: pct,
                subagentCount: usage.subagentCount,
              });
            },
          });

          const finalUsage = parseResult.usage ?? { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 };
          const finalUsed = finalUsage.tokensIn + finalUsage.tokensOut;
          const finalPct = Math.min(100, (finalUsed / planContextLimit) * 100);
          this.events.broadcast({
            type: "project:create_agent_finished",
            projectName,
            model: parseResult.model ?? planModel,
            tokensIn: finalUsage.tokensIn,
            tokensOut: finalUsage.tokensOut,
            cost: finalUsage.cost,
            contextLimit: planContextLimit,
            contextPercentage: finalPct,
            subagentCount: finalUsage.subagentCount,
          });

          if (parseResult.errors.length > 0) {
            const errMsg = parseResult.errors.join("\n");
            this.events.broadcast({
              type: "project:create_error",
              kind: parseResult.timedOut ? "plan_parse_timeout" : "plan_parse",
              error: `Plan parsing errors:\n${errMsg}`,
              projectDir: resolvedDir,
            });
            console.error("[runner] resume plan parse failed:", errMsg);
            break;
          }

          for (const task of parseResult.tasks) {
            this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
            this.events.taskCreated(task.id, task.title);
          }
          const taskCount = parseResult.taskCount;
          this.events.planLoaded(taskCount);

          this.events.broadcast({
            type: "project:create_progress",
            stage: "plan_parsed",
            projectName,
            projectDir: resolvedDir,
            taskCount,
            message: `Resumed-parsed ${taskCount} task${taskCount === 1 ? "" : "s"} from plan.`,
          });
          this.events.broadcast({
            type: "project:create_progress",
            stage: "done",
            projectName,
            projectDir: resolvedDir,
            taskCount,
            message: "Project ready.",
          });
          this.events.broadcast({
            type: "project:created",
            projectDir: resolvedDir,
            dbPath,
            taskCount,
          });
          this.events.broadcast({ type: "project:info", name: projectName, dir: resolvedDir });
          console.log(`[runner] resumed-parsed project: ${resolvedDir} (${taskCount} tasks)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({ type: "project:create_error", kind: "unknown", error: msg, projectDir: resolvedDir });
          console.error("[runner] project:resume_parse failed:", err);
        } finally {
          this.creatingProject = null;
        }
        break;
      }

      case "project:load_tasks": {
        const { projectDir } = event as { type: "project:load_tasks"; projectDir: string };
        const resolvedDir = projectDir.startsWith("~")
          ? path.join(os.homedir(), projectDir.slice(1))
          : path.resolve(projectDir);
        const projectName = path.basename(resolvedDir);

        if (this.creatingProject) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "concurrent",
            error: `Another project creation is already in progress (${this.creatingProject}). Wait for it to finish.`,
          });
          break;
        }

        const dbPath = path.join(resolvedDir, ".orchestrator/orchestrator.db");
        if (!fs.existsSync(dbPath)) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "scaffold",
            error: `No orchestrator DB at ${dbPath}. Project must be scaffolded first.`,
            projectDir: resolvedDir,
          });
          break;
        }

        this.creatingProject = projectName;
        try {
          this.config.projectDir = resolvedDir;
          this.swapDatabase(dbPath);

          const existingTasks = this.db.getAllTasks();
          if (existingTasks.length > 0) {
            this.events.broadcast({
              type: "project:create_error",
              kind: "plan_parse",
              error: `Project already has ${existingTasks.length} tasks. Load-tasks refuses to add duplicates.`,
              projectDir: resolvedDir,
            });
            break;
          }

          const taskDefs = await loadTaskDefs(resolvedDir);
          const { created, errors } = insertTaskDefs(this.db, taskDefs);

          if (errors.length > 0) {
            this.events.broadcast({
              type: "project:create_error",
              kind: "plan_parse",
              error: `Task load errors:\n${errors.join("\n")}`,
              projectDir: resolvedDir,
            });
            console.error("[runner] project:load_tasks errors:", errors);
            break;
          }

          const now = new Date().toISOString();
          const meta: ParsePlanMeta = {
            projectName,
            startedAt: now,
            finishedAt: now,
            exitCode: 0,
            timedOut: false,
            errorKind: null,
            stderrTail: "",
            model: "manual-load",
            effort: "medium",
            taskCount: created.length,
            sessionId: null,
            usage: { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 },
          };
          try {
            fs.writeFileSync(parsePlanMetaPath(resolvedDir), JSON.stringify(meta, null, 2));
          } catch {
            // best-effort
          }

          for (const task of created) {
            this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
            this.events.taskCreated(task.id, task.title);
          }
          this.events.planLoaded(created.length);
          this.events.broadcast({
            type: "project:create_progress",
            stage: "done",
            projectName,
            projectDir: resolvedDir,
            taskCount: created.length,
            message: `Loaded ${created.length} task${created.length === 1 ? "" : "s"} from tasks.json.`,
          });
          this.events.broadcast({
            type: "project:created",
            projectDir: resolvedDir,
            dbPath,
            taskCount: created.length,
          });
          this.events.broadcast({ type: "project:info", name: projectName, dir: resolvedDir });
          console.log(`[runner] loaded tasks into project: ${resolvedDir} (${created.length} tasks)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({ type: "project:create_error", kind: "plan_parse", error: msg, projectDir: resolvedDir });
          console.error("[runner] project:load_tasks failed:", err);
        } finally {
          this.creatingProject = null;
        }
        break;
      }

      case "project:open": {
        const { projectDir } = event as { type: "project:open"; projectDir: string };
        const resolvedDir = projectDir.startsWith("~")
          ? path.join(os.homedir(), projectDir.slice(1))
          : path.resolve(projectDir);
        const projectName = path.basename(resolvedDir);

        if (this.creatingProject) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "concurrent",
            error: `Another project creation is already in progress (${this.creatingProject}). Wait for it to finish.`,
          });
          break;
        }

        const dbPath = path.join(resolvedDir, ".orchestrator/orchestrator.db");
        if (!fs.existsSync(dbPath)) {
          this.events.broadcast({
            type: "project:create_error",
            kind: "scaffold",
            error: `No orchestrator DB at ${dbPath}. Project must be scaffolded first.`,
            projectDir: resolvedDir,
          });
          break;
        }

        try {
          this.config.projectDir = resolvedDir;
          this.swapDatabase(dbPath);

          // Broadcast project:info FIRST so the dashboard clears any stale
          // state from a previous open before we start replaying events.
          this.events.broadcast({ type: "project:info", name: projectName, dir: resolvedDir });

          const tasks = this.db.getAllTasks();
          for (const task of tasks) {
            this.events.taskInit(task.id, task.title, task.description, task.dependsOn, task.milestone, task.effort);
            if (task.state !== "pending") {
              this.events.taskStateChanged(task.id, "pending", task.state, task.title);
            }
          }

          // Replay persisted logs and agent runs so the dashboard rehydrates
          // per-task log history, costs, tokens. Cache stats are not
          // persisted; they replay as 0 (acceptable for historical view).
          for (const task of tasks) {
            const logs = this.db.getTaskLogs(task.id);
            if (logs.length === 0) continue;
            this.events.taskLogBulk(task.id, logs.map((r) => r.content));
          }
          const allRuns = this.db.getAgentRuns();
          for (const run of allRuns) {
            if (run.finishedAt === null) continue;
            this.events.agentStarted(run.taskId, run.phase, run.model);
            const contextLimit = MODEL_CONTEXT_LIMITS[run.model] ?? DEFAULT_CONTEXT_LIMIT;
            const tokensUsed = run.tokensIn + run.tokensOut;
            const contextPercentage = Math.min(100, (tokensUsed / contextLimit) * 100);
            this.events.agentFinished(
              run.taskId, run.phase, tokensUsed, run.cost,
              run.tokensIn, run.tokensOut, 0, 0,
              run.model, contextLimit, contextPercentage,
            );
          }

          this.events.planLoaded(tasks.length);
          console.log(`[runner] opened project: ${resolvedDir} (${tasks.length} tasks, replayed ${allRuns.length} agent_runs)`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.events.broadcast({ type: "project:create_error", kind: "unknown", error: msg, projectDir: resolvedDir });
          console.error("[runner] project:open failed:", err);
        }
        break;
      }

      default:
        console.warn("[runner] unknown command received:", event);
    }
  }

  // ── shutdown ──────────────────────────────────────────────

  async shutdown(): Promise<void> {
    console.log("[runner] shutting down...");

    // Signal all running Claude processes to stop
    this.abortController.abort();

    // Wait for any in-progress merges to settle
    await this.mergeQueue.catch(() => {});

    // Run the learning pipeline with whatever we have
    console.log("[runner] running end-of-shutdown learning pipeline...");
    const learningsDir = path.join(this.config.projectDir, ".orchestrator/learnings");
    try {
      await this.learning.runPipeline(learningsDir);
    } catch (err) {
      console.error("[runner] shutdown learning pipeline failed:", err);
    }

    // Close the database
    this.db.close();

    // Stop WebSocket server
    await this.events.stop().catch((err) => {
      console.error("[runner] ws server stop failed:", err);
    });

    console.log("[runner] shutdown complete");
  }

  // ── _buildSummary ────────────────────────────────────────

  private _buildSummary(runStart: number, learningSummary: string | null = null): RunSummary {
    const allTasks = this.db.getAllTasks();
    const allRuns = this.db.getAgentRuns();
    const allLearnings = this.db.getAllLearnings();

    const completed = allTasks.filter(
      (t) => t.state === "merged" || t.state === "done"
    ).length;
    const failed = allTasks.filter((t) => t.state === "failed").length;
    const skipped = allTasks.filter((t) => t.state === "skipped").length;

    const totalCost = allRuns.reduce((sum, r) => sum + r.cost, 0);
    const totalTokensIn = allRuns.reduce((sum, r) => sum + r.tokensIn, 0);
    const totalTokensOut = allRuns.reduce((sum, r) => sum + r.tokensOut, 0);

    return {
      sessionId: this.sessionId!,
      totalTasks: allTasks.length,
      completed,
      failed,
      skipped,
      totalCost,
      totalTokensIn,
      totalTokensOut,
      duration: Date.now() - runStart,
      learnings: allLearnings.length,
      learningSummary,
      notifications: this.notifications,
    };
  }
}
