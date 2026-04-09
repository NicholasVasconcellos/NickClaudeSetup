import path from "node:path";

import { Database } from "./db.js";
import { GitManager } from "./git.js";
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
} from "./types.js";

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
  }

  // ── init ──────────────────────────────────────────────────

  async init(): Promise<void> {
    // Create database tables
    this.db.init();

    // Crash recovery: clean up any orphaned worktrees from a previous run
    const orphanCount = await this.git.cleanupOrphanedWorktrees();
    if (orphanCount > 0) {
      console.log(`[runner] cleaned up ${orphanCount} orphaned worktree(s)`);
    }

    // Start the WebSocket server
    this.events.start();

    // Register event handlers for dashboard commands
    this.events.onCommand((event) => {
      this.handleCommand(event).catch((err) => {
        console.error("[runner] handleCommand error:", err);
      });
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

    while (
      this.readyQueue.length > 0 &&
      this.activeTasks < this.config.maxConcurrency
    ) {
      const taskId = this.readyQueue.shift()!;
      const task = this.db.getTask(taskId);
      if (!task || task.state !== "pending") continue;

      this.activeTasks++;
      console.log(
        `[runner] starting task ${taskId} (active: ${this.activeTasks}/${this.config.maxConcurrency})`
      );

      this.executeTask(task).finally(() => {
        this.onTaskSettled(taskId);
      });
    }
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
    } else if (task && task.state === "pending" && !this.abortController.signal.aborted) {
      // Rewound for retry — re-enqueue (guard abort so a concurrent failure doesn't
      // sneak a retry into the queue after the workflow has been stopped)
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

  private static readonly PHASE_STATE: Record<string, TaskState> = {
    spec: "spec",
    execute: "executing",
    review: "reviewing",
  };

  private async runPhase(
    taskId: number,
    phase: TaskPhase,
    worktreePath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const targetState = Runner.PHASE_STATE[phase];
    const model = this.config.models[phase];

    const oldState = this.stateMachine.transition(taskId, targetState);
    this.events.taskStateChanged(taskId, oldState, targetState);
    this.events.agentStarted(taskId, phase, model);

    const task = this.db.getTask(taskId)!;
    const effort = task.effort ?? this.config.phaseEffortDefaults[phase];
    const runId = this.db.startAgentRun(taskId, phase, model);
    const prompt = this.buildPrompt(task, phase);

    const result = await this.claude.runTask({
      prompt,
      cwd: worktreePath,
      model,
      effort,
      timeout: this.config.taskTimeout,
      signal,
      onOutput: (line) => {
        this.db.appendLog(taskId, phase, line);
        this.events.taskLogAppend(taskId, line);
      },
    });

    this.db.finishAgentRun(runId, result.tokensIn, result.tokensOut, result.cost, result.duration);
    this.events.agentFinished(taskId, phase, result.tokensIn + result.tokensOut, result.cost);

    if (result.exitCode !== 0 && !signal.aborted) {
      throw new Error(`${phase} phase failed (exit ${result.exitCode}): ${result.stderr}`);
    }

    console.log(`[task:${taskId}] ${phase} phase done`);
  }

  // ── executeTask ───────────────────────────────────────────

  private async executeTask(task: Task): Promise<void> {
    const { id: taskId } = task;
    const signal = this.abortController.signal;

    let worktreePath: string | null = null;

    try {
      const wt = await this.git.createWorktree(taskId);
      worktreePath = wt.worktreePath;
      this.db.updateTaskWorktree(taskId, wt.worktreePath, wt.branch);
      console.log(`[task:${taskId}] worktree created at ${wt.worktreePath}`);

      for (const phase of ["spec", "execute", "review"] as TaskPhase[]) {
        await this.runPhase(taskId, phase, wt.worktreePath, signal);
        if (signal.aborted) return;
      }

      // ── Transition to done, then enqueue merge ─────────────
      {
        const oldState = this.stateMachine.transition(taskId, "done");
        this.events.taskStateChanged(taskId, oldState, "done");
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
        this.events.taskStateChanged(taskId, freshTask?.state ?? "executing", newState);
        console.log(
          `[task:${taskId}] state after failure: ${newState} ` +
            `(retry ${updatedTask?.retryCount ?? "?"}/${updatedTask?.maxRetries ?? "?"})`
        );
      } catch (smErr) {
        console.error(`[task:${taskId}] state machine fail() threw:`, smErr);
      }
    } finally {
      if (worktreePath !== null) {
        const finalTask = this.db.getTask(taskId);
        if (finalTask && finalTask.state !== "merged" && finalTask.state !== "done") {
          await this.git.removeWorktree(taskId).catch((e) => {
            console.warn(`[task:${taskId}] worktree cleanup failed (non-fatal):`, e);
          });
          this.db.updateTaskWorktree(taskId, null, null);
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
      this.events.taskStateChanged(taskId, oldState, "merged");
      console.log(`[task:${taskId}] merged successfully`);
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
        this.events.taskStateChanged(taskId, oldState, "merged");
        console.log(`[task:${taskId}] merge conflict resolved and merged`);
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
        this.events.taskStateChanged(taskId, "done", newState);
      }
    }

    // Clean up worktree now that merge is settled
    await this.git.removeWorktree(taskId).catch((e) => {
      console.warn(`[task:${taskId}] post-merge worktree cleanup failed:`, e);
    });
    this.db.updateTaskWorktree(taskId, null, null);
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

    const result = await this.claude.runTask({
      prompt,
      cwd: this.config.projectDir,
      model,
      timeout: this.config.taskTimeout,
      signal: this.abortController.signal,
      onOutput: (line) => {
        this.db.appendLog(taskId, phase, line);
        this.events.taskLogAppend(taskId, line);
      },
    });

    this.db.finishAgentRun(
      runId,
      result.tokensIn,
      result.tokensOut,
      result.cost,
      result.duration
    );
    this.events.agentFinished(
      taskId,
      phase,
      result.tokensIn + result.tokensOut,
      result.cost
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

    const depFileRefs = files.length > 0
      ? `\n\n## Dependency files\n${files.map(f => `@${f}`).join(" ")}`
      : "";

    // Invoke the corresponding skill for spec/execute/review; merge has no skill
    const skillInvocation = phase !== "merge" ? `/${phase}\n\n` : "";

    return `${skillInvocation}${taskSection}${depTitleSection}${depFileRefs}`;
  }

  // ── handleCommand ─────────────────────────────────────────

  async handleCommand(event: WSEventFromClient): Promise<void> {
    switch (event.type) {
      case "task:pause": {
        const { taskId } = event;
        try {
          this.stateMachine.pause(taskId);
          const t = this.db.getTask(taskId);
          this.events.taskStateChanged(taskId, t?.state ?? "paused", "paused");
          console.log(`[runner] task ${taskId} paused`);
        } catch (err) {
          console.error(`[runner] pause task ${taskId} failed:`, err);
        }
        break;
      }

      case "task:resume": {
        const { taskId } = event;
        try {
          this.stateMachine.resume(taskId);
          const t = this.db.getTask(taskId);
          this.events.taskStateChanged(taskId, "paused", t?.state ?? "executing");
          console.log(`[runner] task ${taskId} resumed`);
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
          this.events.taskStateChanged(taskId, prevState, "pending");
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
          this.events.taskStateChanged(taskId, prevState, "skipped");
          console.log(`[runner] task ${taskId} skipped`);
        } catch (err) {
          console.error(`[runner] skip task ${taskId} failed:`, err);
        }
        break;
      }

      case "run:pause_all":
        this.paused = true;
        console.log("[runner] run paused");
        break;

      case "run:resume_all":
        this.paused = false;
        console.log("[runner] run resumed");
        this.drainReadyQueue();
        break;

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
