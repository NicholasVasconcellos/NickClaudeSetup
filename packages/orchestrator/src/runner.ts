import path from "node:path";

import { Database } from "./db.js";
import { GitManager } from "./git.js";
import { ClaudeRunner } from "./claude.js";
import { StateMachine } from "./state-machine.js";
import { EventBus } from "./ws-server.js";
import { LearningPipeline } from "./learning.js";
import { computeLayers } from "./dag.js";

import type {
  OrchestratorConfig,
  Task,
  TaskPhase,
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

    // Create a new session record
    this.sessionId = this.db.createSession();
    console.log(`[runner] session ${this.sessionId} started`);

    // Set overall timeout
    const timeoutHandle = setTimeout(() => {
      console.warn("[runner] overall timeout reached — aborting");
      this.abortController.abort();
    }, this.config.overallTimeout);

    try {
      // Compute DAG layers from all tasks
      const allTasks = this.db.getAllTasks();
      const layers = computeLayers(allTasks);

      console.log(
        `[runner] ${allTasks.length} task(s) across ${layers.length} layer(s)`
      );

      for (const layer of layers) {
        if (this.abortController.signal.aborted) break;

        // Filter out tasks that are already terminal (merged, skipped) — allows resuming
        const pendingTaskIds = layer.taskIds.filter((id) => {
          const t = this.db.getTask(id);
          return t && t.state !== "merged" && t.state !== "skipped" && t.state !== "failed";
        });

        if (pendingTaskIds.length === 0) {
          console.log(`[runner] layer ${layer.index} — all tasks already complete, skipping`);
          continue;
        }

        this.events.layerStarted(layer.index, pendingTaskIds);
        console.log(
          `[runner] layer ${layer.index} started — tasks: [${pendingTaskIds.join(", ")}]`
        );

        // Resolve Task objects
        const layerTasks = pendingTaskIds
          .map((id) => this.db.getTask(id))
          .filter((t): t is Task => t !== null);

        // Execute all tasks in the layer with concurrency control
        await this.withConcurrency(
          layerTasks.map((task) => () => this.executeTask(task)),
          this.config.maxConcurrency
        );

        this.events.layerCompleted(layer.index);
        console.log(`[runner] layer ${layer.index} completed`);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }

    // Run the learning pipeline now that all tasks are done
    console.log("[runner] running learning pipeline...");
    const skillsDir = path.join(this.config.projectDir, ".claude/skills");
    try {
      const { translated, validated, applied } =
        await this.learning.runPipeline(skillsDir);
      console.log(
        `[runner] learning pipeline — translated=${translated} validated=${validated} applied=${applied}`
      );
    } catch (err) {
      console.error("[runner] learning pipeline failed (non-fatal):", err);
    }

    // Generate summary
    const summary = this._buildSummary(runStart);

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

  // ── executeTask ───────────────────────────────────────────

  private async executeTask(task: Task): Promise<void> {
    const { id: taskId } = task;
    const signal = this.abortController.signal;

    let worktreePath: string | null = null;

    try {
      // ── Worktree setup ──────────────────────────────────────
      const wt = await this.git.createWorktree(taskId);
      worktreePath = wt.worktreePath;
      this.db.updateTaskWorktree(taskId, wt.worktreePath, wt.branch);
      console.log(`[task:${taskId}] worktree created at ${wt.worktreePath}`);

      // ── Spec phase ─────────────────────────────────────────
      {
        const phase: TaskPhase = "spec";
        const model = this.config.models.spec;
        const oldState = this.stateMachine.transition(taskId, "spec");
        this.events.taskStateChanged(taskId, oldState, "spec");
        this.events.agentStarted(taskId, phase, model);

        const runId = this.db.startAgentRun(taskId, phase, model);
        const prompt = this.buildPrompt(task, phase);

        const result = await this.claude.runTask({
          prompt,
          cwd: wt.worktreePath,
          model,
          timeout: this.config.taskTimeout,
          signal,
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

        if (result.exitCode !== 0 && !signal.aborted) {
          throw new Error(
            `spec phase failed (exit ${result.exitCode}): ${result.stderr}`
          );
        }

        console.log(`[task:${taskId}] spec phase done`);
      }

      if (signal.aborted) return;

      // ── Execute phase ──────────────────────────────────────
      {
        const phase: TaskPhase = "execute";
        const model = this.config.models.execute;
        const oldState = this.stateMachine.transition(taskId, "executing");
        this.events.taskStateChanged(taskId, oldState, "executing");
        this.events.agentStarted(taskId, phase, model);

        // Re-fetch task so the prompt builder can see any worktree updates
        const freshTask = this.db.getTask(taskId) ?? task;
        const runId = this.db.startAgentRun(taskId, phase, model);
        const prompt = this.buildPrompt(freshTask, phase);

        const result = await this.claude.runTask({
          prompt,
          cwd: wt.worktreePath,
          model,
          timeout: this.config.taskTimeout,
          signal,
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

        if (result.exitCode !== 0 && !signal.aborted) {
          throw new Error(
            `execute phase failed (exit ${result.exitCode}): ${result.stderr}`
          );
        }

        console.log(`[task:${taskId}] execute phase done`);
      }

      if (signal.aborted) return;

      // ── Review phase ───────────────────────────────────────
      {
        const phase: TaskPhase = "review";
        const model = this.config.models.review;
        const oldState = this.stateMachine.transition(taskId, "reviewing");
        this.events.taskStateChanged(taskId, oldState, "reviewing");
        this.events.agentStarted(taskId, phase, model);

        const freshTask = this.db.getTask(taskId) ?? task;
        const runId = this.db.startAgentRun(taskId, phase, model);
        const prompt = this.buildPrompt(freshTask, phase);

        const result = await this.claude.runTask({
          prompt,
          cwd: wt.worktreePath,
          model,
          timeout: this.config.taskTimeout,
          signal,
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

        if (result.exitCode !== 0 && !signal.aborted) {
          throw new Error(
            `review phase failed (exit ${result.exitCode}): ${result.stderr}`
          );
        }

        console.log(`[task:${taskId}] review phase done`);
      }

      if (signal.aborted) return;

      // ── Transition to done, then enqueue merge ─────────────
      {
        const oldState = this.stateMachine.transition(taskId, "done");
        this.events.taskStateChanged(taskId, oldState, "done");
      }

      await this.enqueueMerge(taskId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[task:${taskId}] error: ${errorMsg}`);

      // Capture a learning from the error
      const freshTask = this.db.getTask(taskId);
      const currentPhase = freshTask?.phase ?? "execute";
      this.learning.capture(taskId, currentPhase, `Execution error: ${errorMsg}`);

      // Handle retry logic via state machine
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
        console.error(
          `[task:${taskId}] state machine fail() threw:`,
          smErr
        );
      }
    } finally {
      // Always attempt worktree cleanup, but only after merge is no longer needed.
      // The merge step removes the worktree itself on success; this guard handles
      // the failure path where enqueueMerge was never reached.
      if (worktreePath !== null) {
        const finalTask = this.db.getTask(taskId);
        if (
          finalTask &&
          finalTask.state !== "merged" &&
          finalTask.state !== "done"
        ) {
          // On failure / skip paths, clean up the worktree immediately
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
      // Merge conflict — attempt to abort and mark as failed
      console.error(
        `[task:${taskId}] merge conflict in: ${conflicts.join(", ") || "(unknown files)"}`
      );

      try {
        await this.git.abortMerge();
      } catch (abortErr) {
        console.warn(`[task:${taskId}] merge abort failed:`, abortErr);
      }

      this.db.recordMerge(taskId, "conflict", false);

      this.learning.capture(
        taskId,
        "review",
        `Merge conflict in files: ${conflicts.join(", ")}`
      );

      this.stateMachine.fail(taskId);
      const updatedTask = this.db.getTask(taskId);
      const newState = updatedTask?.state ?? "failed";
      this.events.taskStateChanged(taskId, "done", newState);
    }

    // Clean up worktree now that merge is settled
    await this.git.removeWorktree(taskId).catch((e) => {
      console.warn(`[task:${taskId}] post-merge worktree cleanup failed:`, e);
    });
    this.db.updateTaskWorktree(taskId, null, null);
  }

  // ── buildPrompt ───────────────────────────────────────────

  private buildPrompt(task: Task, phase: TaskPhase): string {
    const depContext = this.db.getCompletedTaskContext(task.dependsOn);

    const depSection =
      depContext.length > 0
        ? `\n\n## Completed dependency tasks\n${depContext}`
        : "";

    const baseSection =
      `## Task #${task.id}: ${task.title}\n\n` +
      `${task.description}` +
      depSection;

    switch (phase) {
      case "spec":
        return (
          `${baseSection}\n\n` +
          `## Instructions\n` +
          `Write tests based on these acceptance criteria. Do not implement yet.\n` +
          `Create comprehensive test files in the worktree. ` +
          `Tests should be runnable and initially failing (red). ` +
          `Focus on behaviour, not implementation details.`
        );

      case "execute":
        return (
          `${baseSection}\n\n` +
          `## Instructions\n` +
          `Implement the code to pass these tests. Use subagents for parallel work.\n` +
          `The tests are already written in the worktree — make them pass. ` +
          `Do not modify the test files unless they contain bugs. ` +
          `Run the tests frequently to verify progress.`
        );

      case "review":
        return (
          `${baseSection}\n\n` +
          `## Instructions\n` +
          `Review and clean up the code. Run all tests. Fix any issues.\n` +
          `Ensure: all tests pass, code is clean and idiomatic, no debug artifacts remain, ` +
          `TypeScript types are sound, and linting passes. ` +
          `Do not add new features — only clean up and fix.`
        );
    }
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
          // Reset state back to pending so it can be picked up again
          const t = this.db.getTask(taskId);
          if (!t) {
            console.warn(`[runner] retry: task ${taskId} not found`);
            break;
          }
          const prevState = t.state;
          this.db.updateTaskState(taskId, "pending", null);
          this.events.taskStateChanged(taskId, prevState, "pending");
          console.log(`[runner] task ${taskId} reset to pending for retry`);

          // Re-execute the task in the background
          const fresh = this.db.getTask(taskId);
          if (fresh) {
            this.executeTask(fresh).catch((err) => {
              console.error(`[runner] retry executeTask(${taskId}) failed:`, err);
            });
          }
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
    const skillsDir = path.join(this.config.projectDir, ".claude/skills");
    try {
      await this.learning.runPipeline(skillsDir);
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

  // ── withConcurrency ───────────────────────────────────────

  private async withConcurrency<T>(
    tasks: (() => Promise<T>)[],
    max: number
  ): Promise<T[]> {
    const results: T[] = [];
    const executing: Set<Promise<void>> = new Set();

    for (const task of tasks) {
      const p = task()
        .then((r) => {
          results.push(r);
        })
        .finally(() => executing.delete(p));
      executing.add(p);
      if (executing.size >= max) await Promise.race(executing);
    }

    await Promise.all(executing);
    return results;
  }

  // ── _buildSummary ────────────────────────────────────────

  private _buildSummary(runStart: number): RunSummary {
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
    };
  }
}
