#!/usr/bin/env tsx
/**
 * demo-timer.ts -- Simulate building a Timer Page with the orchestrator.
 *
 * Usage:
 *   npx tsx packages/orchestrator/src/demo-timer.ts
 */

import chalk from "chalk";
import { Database } from "./db.js";
import { buildBlockedByMap, getDependents } from "./dag.js";
import { EventBus } from "./ws-server.js";
import type { Task, TaskPhase, TaskEffort, RunSummary } from "./types.js";

// ── Helpers ─────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randDelay(): number { return randInt(600, 1400); }
function shortDelay(): number { return randInt(200, 500); }

function fakeCost(tokensIn: number, tokensOut: number) {
  return parseFloat(((tokensIn * 3 + tokensOut * 15) / 1_000_000).toFixed(4));
}

// ── Task definitions for Timer Page ─────────────────────────────

interface TimerTaskDef {
  title: string;
  description: string;
  dependsOn: number[]; // 1-based positions
  milestone: string;
  effort?: TaskEffort;
  specLogs: string[];
  executeLogs: string[];
  reviewLogs: string[];
  edge?: "normal" | "execute_fail_retry" | "review_rejection";
}

const TIMER_TASKS: TimerTaskDef[] = [
  // Layer 0: Foundation
  {
    title: "Set up React project with Vite + TypeScript",
    description: [
      "Initialize a new React project using Vite with TypeScript template.",
      "Configure ESLint, Prettier, and Tailwind CSS.",
      "",
      "Acceptance criteria:",
      "- `npm run dev` serves app on localhost:5173",
      "- TypeScript strict mode enabled",
      "- Tailwind utility classes work in components",
    ].join("\n"),
    dependsOn: [],
    milestone: "Foundation",
    effort: "low",
    specLogs: [
      "Analyzing project scaffold requirements...",
      "Writing build system validation tests...",
      "Writing Tailwind config tests...",
      "4 test cases generated.",
    ],
    executeLogs: [
      "Running npm create vite@latest -- --template react-ts...",
      "Installing dependencies: react, react-dom, tailwindcss...",
      "Configuring tsconfig.json with strict mode...",
      "Setting up tailwind.config.ts and postcss.config.ts...",
      "Creating base layout component...",
      "Build succeeded with zero errors.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking TypeScript strict mode... enabled. OK.",
      "Verifying Tailwind integration... OK.",
      "Review passed. Approving for merge.",
    ],
  },

  // Layer 1: Core timer logic
  {
    title: "Implement useTimer hook with start/pause/reset",
    description: [
      "Create a custom React hook `useTimer` that manages countdown state.",
      "Support start, pause, resume, reset, and lap tracking.",
      "",
      "Acceptance criteria:",
      "- `useTimer(initialSeconds)` returns time, isRunning, controls",
      "- Timer counts down accurately using requestAnimationFrame",
      "- Pause preserves remaining time, reset returns to initial",
      "- Lap array captures split times",
    ].join("\n"),
    dependsOn: [1],
    milestone: "Core Logic",
    effort: "high",
    specLogs: [
      "Analyzing useTimer hook requirements...",
      "Writing countdown accuracy tests...",
      "Writing pause/resume state transition tests...",
      "Writing lap tracking tests...",
      "Writing edge case tests (0 seconds, negative input)...",
      "12 test cases generated.",
    ],
    executeLogs: [
      "Creating src/hooks/useTimer.ts...",
      "Implementing countdown with requestAnimationFrame for precision...",
      "Adding start/pause/resume state machine...",
      "Implementing reset to initial value...",
      "Adding lap tracking with split times...",
      "Handling edge cases: zero time, overflow protection...",
      "Running tests... all 12 passing.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking for timer drift compensation... OK.",
      "Verifying cleanup of animation frame on unmount... OK.",
      "Checking TypeScript types for hook return value... sound.",
      "Review passed. Approving for merge.",
    ],
    edge: "execute_fail_retry",
  },

  // Layer 1: Sound/notification system (parallel with timer hook)
  {
    title: "Build alarm sound and notification system",
    description: [
      "Create a notification service that plays alarm sounds and shows",
      "browser notifications when the timer reaches zero.",
      "",
      "Acceptance criteria:",
      "- Plays audio alert using Web Audio API",
      "- Shows browser Notification if permitted",
      "- Supports custom sound selection",
      "- Volume control between 0-100%",
    ].join("\n"),
    dependsOn: [1],
    milestone: "Core Logic",
    effort: "medium",
    specLogs: [
      "Analyzing notification requirements...",
      "Writing Web Audio API playback tests...",
      "Writing browser notification permission tests...",
      "Writing volume control tests...",
      "8 test cases generated.",
    ],
    executeLogs: [
      "Creating src/services/alarm.ts...",
      "Implementing AudioContext-based sound playback...",
      "Adding default alarm tones (chime, bell, buzzer)...",
      "Implementing Notification API wrapper with permission request...",
      "Adding volume slider state management...",
      "All 8 notification tests passing.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking AudioContext lifecycle (no leaked contexts)... OK.",
      "Verifying notification permission handling... OK.",
      "Review passed. Approving for merge.",
    ],
  },

  // Layer 1: Persistence (parallel)
  {
    title: "Implement localStorage persistence for presets",
    description: [
      "Build a persistence layer using localStorage to save and load",
      "user-created timer presets (name, duration, color).",
      "",
      "Acceptance criteria:",
      "- Presets saved as JSON in localStorage",
      "- CRUD operations for presets",
      "- Handles storage quota errors gracefully",
      "- Syncs across tabs via storage event",
    ].join("\n"),
    dependsOn: [1],
    milestone: "Core Logic",
    effort: "low",
    specLogs: [
      "Analyzing persistence requirements...",
      "Writing CRUD tests for preset storage...",
      "Writing cross-tab sync tests...",
      "Writing storage quota error handling tests...",
      "7 test cases generated.",
    ],
    executeLogs: [
      "Creating src/services/presets.ts...",
      "Implementing typed preset interface { name, duration, color, id }...",
      "Adding create, read, update, delete operations...",
      "Implementing cross-tab sync via 'storage' event listener...",
      "Adding graceful quota error handling with user notification...",
      "All 7 persistence tests passing.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking for XSS via JSON.parse on storage data... sanitized. OK.",
      "Review passed. Approving for merge.",
    ],
  },

  // Layer 2: UI components
  {
    title: "Build circular countdown display component",
    description: [
      "Create a visually appealing circular countdown timer display",
      "using SVG with animated progress ring and digital time readout.",
      "",
      "Acceptance criteria:",
      "- SVG circle arc depletes as time decreases",
      "- Digital readout shows MM:SS.ms format",
      "- Smooth CSS transitions for arc movement",
      "- Color changes: green > yellow > red as time runs out",
      "- Responsive: works from 200px to 600px width",
    ].join("\n"),
    dependsOn: [2],
    milestone: "UI Components",
    effort: "high",
    specLogs: [
      "Analyzing countdown display requirements...",
      "Writing SVG arc calculation tests...",
      "Writing color transition threshold tests...",
      "Writing responsive sizing tests...",
      "Writing time format display tests...",
      "10 test cases generated.",
    ],
    executeLogs: [
      "Creating src/components/CountdownRing.tsx...",
      "Implementing SVG circle with stroke-dasharray animation...",
      "Adding MM:SS.ms digital readout with monospace font...",
      "Implementing color gradient: green (#22c55e) at 100% → yellow (#eab308) at 30% → red (#ef4444) at 10%...",
      "Adding responsive viewBox scaling...",
      "Polishing with drop-shadow and glow effect on ring...",
      "All 10 display tests passing.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking SVG accessibility attributes... OK.",
      "Checking for re-render optimization with useMemo... OK.",
      "Verifying color contrast for readability... OK.",
      "Review passed. Approving for merge.",
    ],
    edge: "review_rejection",
  },

  // Layer 2: Control buttons (parallel)
  {
    title: "Build timer control buttons and preset selector",
    description: [
      "Create the control panel with start/pause/reset buttons,",
      "preset quick-select chips, and custom duration input.",
      "",
      "Acceptance criteria:",
      "- Start/Pause toggles with appropriate icons",
      "- Reset button returns to selected preset duration",
      "- Preset chips show saved timers (5min, 15min, 25min, etc)",
      "- Custom input accepts HH:MM:SS format",
      "- Keyboard shortcuts: Space=toggle, R=reset, L=lap",
    ].join("\n"),
    dependsOn: [2, 4],
    milestone: "UI Components",
    effort: "medium",
    specLogs: [
      "Analyzing control panel requirements...",
      "Writing button state toggle tests...",
      "Writing keyboard shortcut tests...",
      "Writing preset chip interaction tests...",
      "Writing custom input validation tests...",
      "9 test cases generated.",
    ],
    executeLogs: [
      "Creating src/components/TimerControls.tsx...",
      "Implementing Start/Pause button with play/pause SVG icons...",
      "Adding Reset button with confirmation on running timer...",
      "Building preset chip row from localStorage presets...",
      "Adding custom duration input with HH:MM:SS mask...",
      "Implementing keyboard shortcuts via useEffect listener...",
      "All 9 control tests passing.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking keyboard event cleanup on unmount... OK.",
      "Verifying button aria-labels for accessibility... OK.",
      "Review passed. Approving for merge.",
    ],
  },

  // Layer 3: Main page composition
  {
    title: "Compose Timer Page with all components",
    description: [
      "Assemble the main Timer Page combining the countdown display,",
      "controls, alarm settings, and lap history into a cohesive layout.",
      "",
      "Acceptance criteria:",
      "- Full-page responsive layout with centered timer",
      "- Lap history table below timer (sortable by time)",
      "- Settings drawer for alarm/sound preferences",
      "- Dark/light theme toggle in header",
      "- Smooth page transitions and micro-animations",
    ].join("\n"),
    dependsOn: [3, 5, 6],
    milestone: "Integration",
    effort: "high",
    specLogs: [
      "Analyzing page composition requirements...",
      "Writing layout responsive breakpoint tests...",
      "Writing theme toggle tests...",
      "Writing lap table sorting tests...",
      "Writing integration tests for full flow...",
      "11 test cases generated.",
    ],
    executeLogs: [
      "Creating src/pages/TimerPage.tsx...",
      "Building responsive grid layout with CSS Grid...",
      "Integrating CountdownRing with useTimer hook...",
      "Connecting TimerControls to hook state...",
      "Building LapHistory table with sort controls...",
      "Adding settings drawer with alarm configuration...",
      "Implementing dark/light theme with CSS variables...",
      "Adding page entry animation with Framer Motion...",
      "All 11 integration tests passing.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking component prop drilling (should use context)... refactored. OK.",
      "Verifying theme persistence in localStorage... OK.",
      "Checking for layout shift on theme toggle... none. OK.",
      "Review passed. Approving for merge.",
    ],
  },

  // Layer 4: Polish
  {
    title: "Add PWA support and final polish",
    description: [
      "Make the timer installable as a PWA with offline support,",
      "add meta tags, favicon, and performance optimizations.",
      "",
      "Acceptance criteria:",
      "- Service worker caches assets for offline use",
      "- manifest.json enables install prompt",
      "- Lighthouse PWA score >= 90",
      "- Bundle size < 150KB gzipped",
    ].join("\n"),
    dependsOn: [7],
    milestone: "Polish",
    effort: "medium",
    specLogs: [
      "Analyzing PWA requirements...",
      "Writing service worker registration tests...",
      "Writing offline capability tests...",
      "Writing bundle size threshold tests...",
      "6 test cases generated.",
    ],
    executeLogs: [
      "Creating public/manifest.json with icons...",
      "Implementing service worker with Workbox...",
      "Adding offline fallback page...",
      "Optimizing bundle: code-splitting countdown ring...",
      "Adding meta tags and Open Graph data...",
      "Generating favicon set from timer icon...",
      "Running Lighthouse audit... PWA score: 94.",
      "Bundle size: 127KB gzipped. Under threshold.",
    ],
    reviewLogs: [
      "Running automated code review...",
      "Checking service worker update strategy... OK.",
      "Verifying cache invalidation on deploy... OK.",
      "Review passed. Approving for merge.",
    ],
  },
];

// ── Counters ────────────────────────────────────────────────────

let totalTokensIn = 0;
let totalTokensOut = 0;
let totalCost = 0;
let completedCount = 0;
let failedCount = 0;
const notifications: string[] = [];
const finalStates = new Map<number, string>();

// ── Simulate helpers ────────────────────────────────────────────

function emitAgent(bus: EventBus, taskId: number, phase: TaskPhase): void {
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
}

async function emitLogs(bus: EventBus, taskId: number, lines: string[]): Promise<void> {
  for (const line of lines) {
    bus.taskLogAppend(taskId, line);
    await sleep(shortDelay());
  }
}

const MODELS: Record<TaskPhase, string> = {
  spec: "claude-sonnet-4-6",
  execute: "claude-sonnet-4-6",
  review: "claude-sonnet-4-6",
  merge: "claude-sonnet-4-6",
};

// ── Phase simulations ───────────────────────────────────────────

async function runSpec(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  bus.taskStateChanged(task.id, "pending", "spec", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "spec", MODELS.spec);
  await emitLogs(bus, task.id, def.specLogs);
  emitAgent(bus, task.id, "spec");
  await sleep(randDelay());
}

async function runExecute(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  bus.taskStateChanged(task.id, "spec", "executing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  await emitLogs(bus, task.id, def.executeLogs);
  emitAgent(bus, task.id, "execute");
  await sleep(randDelay());
}

async function runReview(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  bus.taskStateChanged(task.id, "executing", "reviewing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "review", MODELS.review);
  await emitLogs(bus, task.id, def.reviewLogs);
  emitAgent(bus, task.id, "review");
  await sleep(randDelay());
}

async function finishTask(bus: EventBus, task: Task): Promise<void> {
  bus.taskStateChanged(task.id, "reviewing", "done", task.title);
  await sleep(randInt(300, 600));
  bus.taskStateChanged(task.id, "done", "merged", task.title);
  completedCount++;
  finalStates.set(task.id, "merged");
}

// ── Edge case simulations ───────────────────────────────────────

async function simulateNormal(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  await runSpec(bus, task, def);
  await runExecute(bus, task, def);
  await runReview(bus, task, def);
  await finishTask(bus, task);
}

async function simulateExecuteFailRetry(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  await runSpec(bus, task, def);

  // First execute fails
  bus.taskStateChanged(task.id, "spec", "executing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  await emitLogs(bus, task.id, def.executeLogs.slice(0, 3));
  bus.taskLogAppend(task.id, "FAIL: requestAnimationFrame drift exceeds 16ms tolerance");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "  x expected elapsed ~1000ms but got 1047ms (drift: 47ms)");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "execute");

  bus.taskStateChanged(task.id, "executing", "failed", task.title);
  await sleep(randInt(500, 1000));
  bus.taskLogAppend(task.id, "Retry 1/2 -- switching to performance.now() for drift compensation...");
  await sleep(randDelay());
  bus.taskStateChanged(task.id, "failed", "spec", task.title);
  await sleep(randInt(200, 400));

  // Retry succeeds
  bus.taskStateChanged(task.id, "spec", "executing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  await emitLogs(bus, task.id, def.executeLogs);
  bus.taskLogAppend(task.id, "All tests passing after drift compensation fix.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "execute");
  await sleep(randDelay());

  await runReview(bus, task, def);
  await finishTask(bus, task);
}

async function simulateReviewRejection(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  await runSpec(bus, task, def);
  await runExecute(bus, task, def);

  // First review rejects
  bus.taskStateChanged(task.id, "executing", "reviewing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "review", MODELS.review);
  bus.taskLogAppend(task.id, "Running automated code review...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Checking SVG arc calculation...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "WARNING: Arc animation causes layout thrash — missing will-change: transform");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "WARNING: Color transition not smooth — missing CSS transition on stroke");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "REVIEW FAILED -- 2 performance issues. Returning to execute.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "review");

  // Back to execute
  bus.taskStateChanged(task.id, "reviewing", "executing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "execute", MODELS.execute);
  bus.taskLogAppend(task.id, "Fixing review feedback...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Adding will-change: transform to SVG ring container...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Adding CSS transition: stroke 300ms ease on circle element...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Running Lighthouse performance audit... score 97.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "execute");
  await sleep(randDelay());

  // Second review passes
  bus.taskStateChanged(task.id, "executing", "reviewing", task.title);
  await sleep(randDelay());
  bus.agentStarted(task.id, "review", MODELS.review);
  bus.taskLogAppend(task.id, "Running automated code review (attempt 2)...");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "SVG performance... will-change applied. OK.");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Color transitions... smooth. OK.");
  await sleep(shortDelay());
  bus.taskLogAppend(task.id, "Review passed. Approving for merge.");
  await sleep(shortDelay());
  emitAgent(bus, task.id, "review");
  await sleep(randDelay());

  await finishTask(bus, task);
}

// ── Task dispatcher ─────────────────────────────────────────────

async function simulateTask(bus: EventBus, task: Task, def: TimerTaskDef): Promise<void> {
  const edge = def.edge ?? "normal";

  console.log(
    chalk.white(`    #${task.id} ${task.title}`) +
    (edge !== "normal" ? chalk.yellow(` [${edge}]`) : "")
  );

  switch (edge) {
    case "normal":
      return simulateNormal(bus, task, def);
    case "execute_fail_retry":
      return simulateExecuteFailRetry(bus, task, def);
    case "review_rejection":
      return simulateReviewRejection(bus, task, def);
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const dbPath = ".orchestrator/demo-timer.db";
  const wsPort = 3100;

  console.log(chalk.bold.magenta("\n  Timer Page Demo"));
  console.log(chalk.gray(`  DB:   ${dbPath}`));
  console.log(chalk.gray(`  WS:   ws://localhost:${wsPort}\n`));

  // Seed DB with timer tasks
  const db = new Database(dbPath);
  db.init();

  const tasks: Task[] = [];
  for (const def of TIMER_TASKS) {
    const resolvedDeps = def.dependsOn.map((pos) => {
      const depTask = tasks[pos - 1];
      if (!depTask) throw new Error(`Dep references pos ${pos} not yet inserted`);
      return depTask.id;
    });
    const task = db.createTask(def.title, def.description, resolvedDeps, def.milestone, def.effort);
    tasks.push(task);
  }

  const sessionId = db.createSession();
  console.log(chalk.green(`  Seeded ${tasks.length} tasks, session #${sessionId}`));

  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const defMap = new Map(tasks.map((t, i) => [t.id, TIMER_TASKS[i]]));
  const blockedBy = buildBlockedByMap(tasks);
  const maxConcurrency = 3;

  const bus = new EventBus(wsPort);
  bus.start();

  console.log(chalk.yellow("\n  Waiting 4s for dashboard to connect...\n"));
  await sleep(4000);

  const startTime = Date.now();

  let activeTasks = 0;
  const readyQueue: number[] = [];

  for (const task of tasks) {
    const blocked = blockedBy.get(task.id);
    if (task.state === "pending" && blocked && blocked.size === 0) {
      readyQueue.push(task.id);
    }
  }

  console.log(chalk.cyan(`  ${readyQueue.length} initially ready, ${tasks.length} total\n`));

  await new Promise<void>((runResolve) => {
    function onTaskSettled(taskId: number): void {
      activeTasks--;
      const state = finalStates.get(taskId);

      if (state === "merged" || state === "done") {
        const dependents = getDependents(taskId, tasks);
        for (const dep of dependents) {
          const blocked = blockedBy.get(dep.id);
          if (!blocked) continue;
          blocked.delete(taskId);

          if (blocked.size === 0) {
            bus.taskUnblocked(dep.id);
            readyQueue.push(dep.id);
            console.log(chalk.blue(`  -> task ${dep.id} unblocked by task ${taskId}`));
          }
        }
      }

      drainQueue();

      if (activeTasks === 0 && readyQueue.length === 0) {
        runResolve();
      }
    }

    function drainQueue(): void {
      while (readyQueue.length > 0 && activeTasks < maxConcurrency) {
        const taskId = readyQueue.shift()!;
        const task = taskMap.get(taskId);
        const def = defMap.get(taskId);
        if (!task || !def) continue;
        activeTasks++;
        simulateTask(bus, task, def).finally(() => onTaskSettled(taskId));
      }
    }

    drainQueue();
  });

  const duration = Date.now() - startTime;

  const summary: RunSummary = {
    sessionId,
    totalTasks: tasks.length,
    completed: completedCount,
    failed: failedCount,
    skipped: 0,
    totalCost: parseFloat(totalCost.toFixed(4)),
    totalTokensIn,
    totalTokensOut,
    duration,
    learnings: 3,
    learningSummary:
      "Timer implementation insights:\n\n" +
      "- requestAnimationFrame alone is insufficient for precise countdown — combine with performance.now() drift compensation\n" +
      "- SVG stroke-dasharray animations require will-change hint to avoid layout thrash\n" +
      "- Cross-tab localStorage sync via 'storage' event is reliable but has ~50ms latency",
    notifications,
  };

  bus.runCompleted(summary);

  console.log(chalk.bold("\n  -- Run Summary ------"));
  console.log(chalk.green(`  Completed : ${completedCount}/${tasks.length}`));
  console.log(chalk.gray(`  Duration  : ${(duration / 1000).toFixed(1)}s`));
  console.log(chalk.gray(`  Tokens    : ${totalTokensIn.toLocaleString()} in / ${totalTokensOut.toLocaleString()} out`));
  console.log(chalk.gray(`  Cost      : $${totalCost.toFixed(4)}`));
  console.log(chalk.bold.cyan("\n  Dashboard at http://localhost:3200\n"));

  db.close();

  // Keep alive for dashboard
  console.log(chalk.gray("  Press Ctrl+C to exit.\n"));
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
