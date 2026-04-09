#!/usr/bin/env tsx
/**
 * demo.ts -- Simulate an orchestrator run with realistic edge cases.
 *
 * Showcases: normal flow, test failures + retries, timeouts,
 * review rejections, merge conflicts, and permanent failures (workflow abort).
 *
 * Usage:
 *   npx tsx packages/orchestrator/src/demo.ts
 */

import chalk from "chalk";
import { seedDatabase } from "./seed.js";
import { buildBlockedByMap, getDependents } from "./dag.js";
import { EventBus } from "./ws-server.js";
import type { Task, TaskPhase, RunSummary } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randDelay(): number { return randInt(800, 2000); }
function shortDelay(): number { return randInt(300, 700); }

function fakeCost(tokensIn: number, tokensOut: number) {
  return parseFloat(((tokensIn * 3 + tokensOut * 15) / 1_000_000).toFixed(4));
}

// ── Edge case definitions ──────────────────────────────────────

type EdgeCase =
  | { type: "normal" }
  | { type: "execute_fail_retry"; failCount: number }       // fails N times in execute, then succeeds
  | { type: "spec_timeout_retry" }                           // spec times out, retry succeeds
  | { type: "review_rejection" }                             // review finds issue, back to execute, re-review passes
  | { type: "merge_conflict" }                               // merge conflict, auto-resolved
  | { type: "permanent_failure"; failCount: number };        // fails maxRetries times, workflow aborts

// Map task IDs to their edge case behavior
const EDGE_CASES: Record<number, EdgeCase> = {
  1:  { type: "normal" },
  2:  { type: "normal" },
  3:  { type: "execute_fail_retry", failCount: 1 },
  4:  { type: "normal" },
  5:  { type: "spec_timeout_retry" },
  6:  { type: "normal" },
  7:  { type: "normal" },
  8:  { type: "normal" },
  9:  { type: "review_rejection" },
  10: { type: "permanent_failure", failCount: 3 },
  11: { type: "merge_conflict" },
  12: { type: "normal" },
  13: { type: "normal" },
  14: { type: "normal" },
};

// ── Phase log lines ────────────────────────────────────────────

const SPEC_LOGS: Record<number, string[]> = {
  1:  ["Analyzing project requirements...", "Generating test scaffold for build system...", "Writing 6 unit tests for project setup validation..."],
  2:  ["Reading schema requirements...", "Generating migration test fixtures...", "Writing 9 tests for model CRUD operations..."],
  3:  ["Parsing auth endpoint specs...", "Writing tests for signup, login, refresh flows...", "Adding rate limiter edge case tests...", "14 test cases generated."],
  4:  ["Analyzing profile API requirements...", "Writing tests for CRUD and avatar upload...", "8 test cases generated."],
  5:  ["Analyzing notification channels...", "Writing delivery tracking tests...", "Writing template rendering tests...", "11 test cases generated."],
  6:  ["Analyzing login page requirements...", "Writing form validation tests...", "Writing auth flow integration tests...", "7 test cases generated."],
  7:  ["Analyzing profile page requirements...", "Writing component render tests...", "Writing save/error flow tests...", "9 test cases generated."],
  8:  ["Analyzing notification center UI...", "Writing badge count tests...", "Writing mark-as-read flow tests...", "6 test cases generated."],
  9:  ["Analyzing admin dashboard requirements...", "Writing role gate tests...", "Writing user table interaction tests...", "12 test cases generated."],
  10: ["Analyzing Stripe integration requirements...", "Writing checkout flow tests...", "Writing webhook handler tests...", "Writing invoice generation tests...", "15 test cases generated."],
  11: ["Analyzing WebSocket requirements...", "Writing connection auth tests...", "Writing real-time delivery tests...", "Writing reconnection tests...", "10 test cases generated."],
  12: ["Analyzing E2E flow requirements...", "Configuring Playwright test matrix...", "Writing 8 E2E scenarios across 4 flows..."],
  13: ["Analyzing CI/CD pipeline requirements...", "Writing workflow validation tests...", "5 test cases generated."],
  14: ["Analyzing monitoring requirements...", "Writing alert threshold tests...", "Writing metric collection tests..."],
};

const EXECUTE_LOGS: Record<number, string[]> = {
  1:  ["Initializing package.json and tsconfig.json...", "Installing dependencies: typescript, eslint, prettier...", "Creating folder structure: src/, tests/, docs/...", "Configuring ESLint with recommended rules...", "Build succeeded with zero errors."],
  2:  ["Creating migration 001_create_users.sql...", "Creating migration 002_create_sessions.sql...", "Creating migration 003_create_notifications.sql...", "Generating typed model helpers for all tables...", "Running migrations against test database...", "All migrations applied successfully."],
  3:  ["Scaffolding auth routes: /auth/signup, /auth/login, /auth/refresh...", "Implementing bcrypt password hashing...", "Adding JWT token generation and validation middleware...", "Configuring rate limiter: 10 req/min/IP...", "Writing unit tests for auth endpoints...", "All 14 auth tests passing."],
  4:  ["Creating user profile routes: GET /users/:id, PATCH /users/me...", "Implementing avatar upload with S3 presigned URLs...", "Adding email change flow with verification token...", "Writing validation middleware for profile updates...", "All 8 profile tests passing."],
  5:  ["Setting up notification queue processor...", "Implementing email channel via SendGrid...", "Implementing push channel via Firebase...", "Building template rendering engine...", "Adding delivery status tracking...", "All 11 notification tests passing."],
  6:  ["Scaffolding login page component...", "Adding form validation: email format, password length...", "Connecting to auth API with error handling...", "Implementing token storage in httpOnly cookies...", "Login page renders correctly on mobile and desktop."],
  7:  ["Scaffolding profile settings page...", "Pre-populating fields from GET /users/me...", "Adding avatar preview with client-side crop...", "Implementing save with success/error toasts...", "Profile page passes accessibility audit."],
  8:  ["Building notification bell component...", "Implementing unread count badge with polling...", "Creating notification dropdown list...", "Adding mark-as-read with optimistic UI...", "Notification center renders and updates correctly."],
  9:  ["Scaffolding admin layout with role gate...", "Building user management table with DataGrid...", "Adding search, filter, and bulk action toolbar...", "Implementing system metrics charts with Recharts...", "Admin dashboard fully interactive."],
  10: ["Configuring Stripe SDK and test keys...", "Building checkout session creation endpoint...", "Implementing webhook signature verification...", "Adding subscription lifecycle handlers...", "Building invoice list and PDF generation..."],
  11: ["Setting up WebSocket server with ws library...", "Implementing JWT auth in WS handshake...", "Building notification broadcast pipeline...", "Adding connection heartbeat and timeout...", "Implementing client reconnection with backoff...", "All 10 WebSocket tests passing."],
  12: ["Configuring Playwright with chromium...", "Writing E2E: signup → login → dashboard flow...", "Writing E2E: profile update and avatar upload...", "Writing E2E: notification delivery and mark-as-read...", "Writing E2E: admin user management...", "Running full suite headless...", "All 8 E2E tests passing in 67s."],
  13: ["Creating .github/workflows/ci.yml...", "Adding parallel jobs: typecheck, lint, unit, e2e...", "Configuring staging deployment on merge to main...", "Adding production environment with manual approval gate...", "CI pipeline runs green on initial commit."],
  14: ["Setting up Sentry error tracking...", "Configuring Prometheus metrics exporter...", "Building Grafana dashboard templates...", "Adding PagerDuty alert rules for P95 latency..."],
};

const REVIEW_LOGS: Record<number, string[]> = {
  1:  ["Running automated code review...", "Checking for lint violations... none found.", "Review passed. Approving for merge."],
  2:  ["Running automated code review...", "Verifying migration idempotency... OK.", "Checking for SQL injection vectors... clean.", "Review passed. Approving for merge."],
  3:  ["Running automated code review...", "Checking auth for timing attacks... OK.", "Verifying token expiry handling... OK.", "Review passed. Approving for merge."],
  4:  ["Running automated code review...", "Checking file upload size limits... OK.", "Review passed. Approving for merge."],
  5:  ["Running automated code review...", "Checking for unhandled promise rejections... none.", "Verifying retry logic in delivery pipeline... OK.", "Review passed. Approving for merge."],
  6:  ["Running automated code review...", "Checking for XSS in form rendering... clean.", "Review passed. Approving for merge."],
  7:  ["Running automated code review...", "Checking image handling for SSRF... clean.", "Review passed. Approving for merge."],
  8:  ["Running automated code review...", "Checking for memory leaks in polling...", "Review passed. Approving for merge."],
  9:  ["Running automated code review...", "Checking admin role gate implementation...", "Verifying CSRF protection on bulk actions...", "Review passed. Approving for merge."],
  10: ["Running automated code review...", "Checking webhook signature verification...", "Verifying idempotency of payment handlers...", "Review passed. Approving for merge."],
  11: ["Running automated code review...", "Checking WS connection cleanup on disconnect...", "Review passed. Approving for merge."],
  12: ["Running automated code review...", "Checking test isolation between E2E scenarios...", "Review passed. Approving for merge."],
  13: ["Running automated code review...", "Verifying secrets are not hardcoded in CI...", "Review passed. Approving for merge."],
  14: ["Running automated code review...", "Checking alert thresholds are reasonable...", "Review passed. Approving for merge."],
};

const MODELS: Record<TaskPhase, string> = {
  spec: "claude-sonnet-4-6",
  execute: "claude-sonnet-4-6",
  review: "claude-sonnet-4-6",
  merge: "claude-sonnet-4-6",
};

// ── Counters ────────────────────────────────────────────────────

let totalTokensIn = 0;
let totalTokensOut = 0;
let totalCost = 0;
let completedCount = 0;
let failedCount = 0;
const notifications: string[] = [];
const failedTaskIds = new Set<number>();
const finalStates = new Map<number, string>();

// ── Simulate helpers ────────────────────────────────────────────

function emitAgent(bus: EventBus, taskId: number, phase: TaskPhase): { tokensIn: number; tokensOut: number; cost: number } {
  const tokensIn = randInt(1200, 6000);
  const tokensOut = randInt(800, 4000);
  const cost = fakeCost(tokensIn, tokensOut);
  const model = "claude-sonnet-4-6";
  const contextLimit = 200_000;
  const contextPercentage = Math.min(100, ((tokensIn + tokensOut) / contextLimit) * 100);
  bus.agentFinished(taskId, phase, tokensIn + tokensOut, cost, tokensIn, tokensOut, model, contextLimit, contextPercentage);
  totalTokensIn += tokensIn;
  totalTokensOut += tokensOut;
  totalCost += cost;
  return { tokensIn, tokensOut, cost };
}

async function emitLogs(bus: EventBus, taskId: number, lines: string[]): Promise<void> {
  for (const line of lines) {
    bus.taskLogAppend(taskId, line);
    await sleep(shortDelay());
  }
}

// ── Normal phase simulation ─────────────────────────────────────

async function runSpec(bus: EventBus, task: Task): Promise<void> {
  bus.taskStateChanged(task.id, "pending", "spec");
  await sleep(randDelay());
  bus.agentStarted(task.id, "spec", MODELS.spec);
  await emitLogs(bus, task.id, SPEC_LOGS[task.id] ?? ["Generating spec..."]);
  emitAgent(bus, task.id, "spec");
  await sleep(randDelay());
}

async function runExecute(bus: EventBus, task: Task): Promise<void> {
  bus.taskStateChanged(task.id, "spec", "executing");
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  await emitLogs(bus, task.id, EXECUTE_LOGS[task.id] ?? ["Implementing..."]);
  emitAgent(bus, task.id, "execute");
  await sleep(randDelay());
}

async function runReview(bus: EventBus, task: Task): Promise<void> {
  bus.taskStateChanged(task.id, "executing", "reviewing");
  await sleep(randDelay());
  bus.agentStarted(task.id, "review", MODELS.review);
  await emitLogs(bus, task.id, REVIEW_LOGS[task.id] ?? ["Reviewing..."]);
  emitAgent(bus, task.id, "review");
  await sleep(randDelay());
}

async function finishTask(bus: EventBus, task: Task): Promise<void> {
  bus.taskStateChanged(task.id, "reviewing", "done");
  await sleep(randInt(400, 800));
  bus.taskStateChanged(task.id, "done", "merged");
  completedCount++;
  finalStates.set(task.id, "merged");
}

// ── Edge case simulations ──────────────────────────────────────

async function simulateNormal(bus: EventBus, task: Task): Promise<void> {
  await runSpec(bus, task);
  await runExecute(bus, task);
  await runReview(bus, task);
  await finishTask(bus, task);
}

async function simulateExecuteFailRetry(bus: EventBus, task: Task, failCount: number): Promise<void> {
  await runSpec(bus, task);

  for (let attempt = 1; attempt <= failCount; attempt++) {
    // Execute fails
    bus.taskStateChanged(task.id, attempt === 1 ? "spec" : "spec", "executing");
    await sleep(randDelay());
    bus.agentStarted(task.id, "execute", MODELS.execute);

    const logs = EXECUTE_LOGS[task.id] ?? ["Implementing..."];
    // Show partial logs then failure
    await emitLogs(bus, task.id, logs.slice(0, -1));
    bus.taskLogAppend(task.id, `FAIL: ${randInt(2, 5)} of ${randInt(8, 15)} tests failed`);
    await sleep(shortDelay());
    bus.taskLogAppend(task.id, `  ✗ expected 200 but got 401 (missing auth header)`);
    await sleep(shortDelay());
    bus.taskLogAppend(task.id, `  ✗ token refresh returns expired token`);
    await sleep(shortDelay());
    emitAgent(bus, task.id, "execute");

    // Transition to failed, then back to retry
    bus.taskStateChanged(task.id, "executing", "failed");
    await sleep(randInt(500, 1000));
    bus.taskLogAppend(task.id, `⟳ Retry ${attempt}/${failCount + 1} — analyzing failures...`);
    await sleep(randDelay());
    bus.taskStateChanged(task.id, "failed", "spec");
    await sleep(randInt(300, 600));
  }

  // Final attempt succeeds
  bus.taskStateChanged(task.id, "spec", "executing");
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  await emitLogs(bus, task.id, EXECUTE_LOGS[task.id] ?? ["Implementing..."]);
  bus.taskLogAppend(task.id, "✓ All tests passing after fix.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "execute");
  await sleep(randDelay());

  await runReview(bus, task);
  await finishTask(bus, task);
}

async function simulateSpecTimeout(bus: EventBus, task: Task): Promise<void> {
  // First attempt: spec times out
  bus.taskStateChanged(task.id, "pending", "spec");
  await sleep(randDelay());
  bus.agentStarted(task.id, "spec", MODELS.spec);

  const logs = SPEC_LOGS[task.id] ?? ["Generating spec..."];
  await emitLogs(bus, task.id, logs.slice(0, 2));
  bus.taskLogAppend(task.id, "⏱ Agent timed out after 120s — no response from Claude CLI");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Killing process tree...");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "spec");

  bus.taskStateChanged(task.id, "spec", "failed");
  await sleep(randInt(800, 1500));
  bus.taskLogAppend(task.id, "⟳ Retry 1/2 — restarting spec phase with fresh context...");
  await sleep(randDelay());

  // Retry succeeds
  bus.taskStateChanged(task.id, "failed", "pending");
  await sleep(randInt(300, 600));
  await runSpec(bus, task);
  bus.taskLogAppend(task.id, "✓ Spec completed on retry.");
  await sleep(shortDelay());

  await runExecute(bus, task);
  await runReview(bus, task);
  await finishTask(bus, task);
}

async function simulateReviewRejection(bus: EventBus, task: Task): Promise<void> {
  await runSpec(bus, task);
  await runExecute(bus, task);

  // First review fails
  bus.taskStateChanged(task.id, "executing", "reviewing");
  await sleep(randDelay());
  bus.agentStarted(task.id, "review", MODELS.review);
  bus.taskLogAppend(task.id, "Running automated code review...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Checking admin role gate implementation...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "⚠ SECURITY: Role check uses client-side header, not JWT claim");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "⚠ SECURITY: Bulk delete endpoint missing CSRF token validation");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "REVIEW FAILED — 2 security issues found. Returning to execute.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "review");

  // Back to execute to fix
  bus.taskStateChanged(task.id, "reviewing", "executing");
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  bus.taskLogAppend(task.id, "Fixing security issues from review...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Replacing header-based role check with JWT claim verification...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Adding CSRF token validation to all mutation endpoints...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Running tests to verify fixes...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "All 12 admin tests passing.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "execute");
  await sleep(randDelay());

  // Second review passes
  bus.taskStateChanged(task.id, "executing", "reviewing");
  await sleep(randDelay());
  bus.agentStarted(task.id, "review", MODELS.review);
  bus.taskLogAppend(task.id, "Running automated code review (attempt 2)...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Checking admin role gate... JWT claim verified. ✓");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Checking CSRF protection... all mutation endpoints covered. ✓");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Review passed. Approving for merge.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "review");
  await sleep(randDelay());

  await finishTask(bus, task);
}

async function simulateMergeConflict(bus: EventBus, task: Task): Promise<void> {
  await runSpec(bus, task);
  await runExecute(bus, task);
  await runReview(bus, task);

  // Done, but merge has conflict
  bus.taskStateChanged(task.id, "reviewing", "done");
  await sleep(randInt(400, 800));

  bus.taskLogAppend(task.id, "Merging branch task/11 into main...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "CONFLICT: merge conflict in src/lib/websocket.ts");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "CONFLICT: merge conflict in src/config/server.ts");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Auto-resolving conflicts...");
  await sleep(randInt(1000, 2000));
  bus.taskLogAppend(task.id, "  ✓ src/lib/websocket.ts — accepted both changes (additive)");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "  ✓ src/config/server.ts — accepted incoming (newer port config)");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Running tests after conflict resolution...");
  await sleep(randInt(1000, 2000));
  bus.taskLogAppend(task.id, "All tests passing after merge. ✓");
  await sleep(shortDelay());

  bus.taskStateChanged(task.id, "done", "merged");
  completedCount++;
  finalStates.set(task.id, "merged");
}

async function simulatePermanentFailure(bus: EventBus, task: Task, maxRetries: number): Promise<void> {
  await runSpec(bus, task);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    bus.taskStateChanged(task.id, attempt === 1 ? "spec" : "spec", "executing");
    await sleep(randDelay());
    bus.agentStarted(task.id, "execute", MODELS.execute);

    if (attempt === 1) {
      await emitLogs(bus, task.id, [
        "Configuring Stripe SDK and test keys...",
        "Building checkout session creation endpoint...",
        "Implementing webhook signature verification...",
        "ERROR: Stripe test key rejected — account not in test mode",
      ]);
    } else if (attempt === 2) {
      await emitLogs(bus, task.id, [
        "Retrying with mock Stripe adapter...",
        "Building checkout session creation endpoint...",
        "ERROR: Mock adapter missing subscription lifecycle hooks",
        "Cannot proceed without Stripe test environment",
      ]);
    } else {
      await emitLogs(bus, task.id, [
        "Attempting alternative: in-memory payment stub...",
        "Building checkout flow against stub...",
        "ERROR: Webhook handler fails — stub doesn't generate signed events",
        "FATAL: Cannot implement payment processing without valid Stripe test keys",
      ]);
    }
    emitAgent(bus, task.id, "execute");

    if (attempt < maxRetries) {
      bus.taskStateChanged(task.id, "executing", "failed");
      await sleep(randInt(500, 1000));
      bus.taskLogAppend(task.id, `⟳ Retry ${attempt}/${maxRetries} — attempting different approach...`);
      await sleep(randDelay());
      bus.taskStateChanged(task.id, "failed", "spec");
      await sleep(randInt(300, 600));
    }
  }

  // Final failure
  bus.taskStateChanged(task.id, "executing", "failed");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, `✗ Task failed after ${maxRetries} attempts. Requires manual intervention.`);
  bus.taskLogAppend(task.id, `  Action needed: Configure Stripe test mode and add STRIPE_TEST_KEY to .env`);
  failedCount++;
  failedTaskIds.add(task.id);
  finalStates.set(task.id, "failed");
}

// ── Main task dispatcher ────────────────────────────────────────

async function simulateTask(bus: EventBus, task: Task): Promise<void> {
  const edge = EDGE_CASES[task.id] ?? { type: "normal" };

  console.log(
    chalk.white(`    #${task.id} ${task.title}`) +
    (edge.type !== "normal" ? chalk.yellow(` [${edge.type}]`) : "")
  );

  switch (edge.type) {
    case "normal":
      return simulateNormal(bus, task);
    case "execute_fail_retry":
      return simulateExecuteFailRetry(bus, task, edge.failCount);
    case "spec_timeout_retry":
      return simulateSpecTimeout(bus, task);
    case "review_rejection":
      return simulateReviewRejection(bus, task);
    case "merge_conflict":
      return simulateMergeConflict(bus, task);
    case "permanent_failure":
      return simulatePermanentFailure(bus, task, edge.failCount);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbPath = ".orchestrator/demo.db";
  const wsPort = 3100;

  console.log(chalk.bold.magenta("\n  Orchestrator Demo Mode"));
  console.log(chalk.gray(`  DB:   ${dbPath}`));
  console.log(chalk.gray(`  WS:   ws://localhost:${wsPort}`));
  console.log(chalk.gray("  Edge cases: retry, timeout, review rejection, merge conflict, permanent failure\n"));

  const { db, tasks, sessionId } = seedDatabase(dbPath);
  console.log(chalk.green(`  Seeded ${tasks.length} tasks, session #${sessionId}`));

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const blockedBy = buildBlockedByMap(tasks);
  const maxConcurrency = 4;

  const bus = new EventBus(wsPort);
  bus.start();

  console.log(chalk.yellow("\n  Waiting 3s for dashboard to connect...\n"));
  await sleep(3000);

  const startTime = Date.now();

  // Event-driven task execution: tasks start as soon as deps are satisfied
  let activeTasks = 0;
  const readyQueue: number[] = [];

  // Seed initially-ready tasks
  for (const task of tasks) {
    const blocked = blockedBy.get(task.id);
    if (task.state === "pending" && blocked && blocked.size === 0) {
      readyQueue.push(task.id);
    }
  }

  console.log(chalk.cyan(`  ${readyQueue.length} initially ready, ${tasks.length} total\n`));

  let aborted = false;

  await new Promise<void>((runResolve) => {
    function onTaskSettled(taskId: number): void {
      activeTasks--;
      const state = finalStates.get(taskId);

      if (state === "failed") {
        // Permanent failure — stop the entire workflow
        const msg = `Workflow stopped: task #${taskId} failed after exhausting retries`;
        notifications.push(msg);
        bus.notify(msg, "error");
        console.log(chalk.red(`\n  ✗ ${msg}`));
        aborted = true;
      } else if (state === "merged" || state === "done") {
        const dependents = getDependents(taskId, tasks);
        for (const dep of dependents) {
          const blocked = blockedBy.get(dep.id);
          if (!blocked) continue;
          blocked.delete(taskId);

          if (blocked.size === 0) {
            bus.taskUnblocked(dep.id);
            readyQueue.push(dep.id);
            console.log(
              chalk.blue(`  → task ${dep.id} unblocked by task ${taskId}`)
            );
          }
        }
      }

      if (!aborted) drainQueue();

      if (activeTasks === 0 && (readyQueue.length === 0 || aborted)) {
        runResolve();
      }
    }

    function drainQueue(): void {
      while (readyQueue.length > 0 && activeTasks < maxConcurrency) {
        const taskId = readyQueue.shift()!;
        const task = taskMap.get(taskId);
        if (!task) continue;
        activeTasks++;
        simulateTask(bus, task).finally(() => onTaskSettled(taskId));
      }
    }

    drainQueue();
  });

  const duration = Date.now() - startTime;

  const skipped = 0; // Tasks are never auto-skipped; workflow aborts on failure

  const summary: RunSummary = {
    sessionId,
    totalTasks: tasks.length,
    completed: completedCount,
    failed: failedCount,
    skipped,
    totalCost: parseFloat(totalCost.toFixed(4)),
    totalTokensIn,
    totalTokensOut,
    duration,
    learnings: failedCount * 2 + 1,
    learningSummary: failedCount > 0
      ? "Several tasks failed during execution, primarily due to timeout and dependency resolution issues.\n\n- Check task timeout configuration for long-running operations\n- Ensure all dependencies are installed before execution phase\n- Review merge conflict resolution for tasks modifying shared files"
      : null,
    notifications,
  };

  bus.runCompleted(summary);

  console.log(chalk.bold("  ── Run Summary ──────────────────────────────"));
  console.log(chalk.green(`  ✓ Completed : ${completedCount}`));
  if (failedCount > 0) console.log(chalk.red(`  ✗ Failed    : ${failedCount} (tasks: ${[...failedTaskIds].map(id => `#${id}`).join(", ")})`));
  if (aborted) console.log(chalk.yellow(`  ⊘ Aborted   : workflow stopped due to permanent failure`));
  if (notifications.length > 0) {
    console.log(chalk.red(`  Notifications:`));
    for (const n of notifications) console.log(chalk.red(`    - ${n}`));
  }
  console.log(chalk.gray(`  Duration    : ${(duration / 1000).toFixed(1)}s`));
  console.log(chalk.gray(`  Tokens      : ${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`));
  console.log(chalk.gray(`  Cost        : $${totalCost.toFixed(4)}`));
  console.log(chalk.gray(`  Learnings   : ${summary.learnings} captured`));

  console.log(
    chalk.bold.cyan("\n  Dashboard running at http://localhost:3200\n")
  );

  db.close();
  process.on("SIGINT", async () => {
    console.log(chalk.gray("\n  Shutting down..."));
    await bus.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(chalk.red("  Fatal error:"), err);
  process.exit(1);
});
