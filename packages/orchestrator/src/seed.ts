#!/usr/bin/env tsx
/**
 * seed.ts -- Seed a SQLite database with sample tasks for demo/testing.
 *
 * Usage:
 *   npx tsx packages/orchestrator/src/seed.ts [--db-path <path>]
 */

import chalk from "chalk";
import { Database } from "./db.js";
import { computeLayers } from "./dag.js";
import type { Task, DAGLayer } from "./types.js";

// ── CLI args ────────────────────────────────────────────────────

function parseArgs(): { dbPath: string } {
  const args = process.argv.slice(2);
  let dbPath = ".orchestrator/orchestrator.db";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db-path" && args[i + 1]) {
      dbPath = args[i + 1];
      i++;
    }
  }

  return { dbPath };
}

// ── Task definitions ────────────────────────────────────────────

interface TaskDef {
  title: string;
  description: string;
  dependsOn: number[]; // references to 1-based positions in this array
  milestone: string;
}

const TASK_DEFS: TaskDef[] = [
  // ── Foundation (Layer 0-1) ─────────────────────────────────
  {
    title: "Set up project structure and dependencies",
    description: [
      "Initialize the monorepo with the chosen package manager, configure TypeScript,",
      "ESLint, and Prettier, and establish the folder layout for packages.",
      "",
      "Acceptance criteria:",
      "- Repository compiles with zero errors on `npm run build`",
      "- Linting and formatting configs are enforced in CI",
      "- A root README documents the project layout and setup steps",
    ].join("\n"),
    dependsOn: [],
    milestone: "Foundation",
  },
  {
    title: "Create database schema and models",
    description: [
      "Design and implement the core database schema using migrations.",
      "Create typed model helpers for all tables.",
      "",
      "Acceptance criteria:",
      "- All tables have up/down migrations that run idempotently",
      "- Model layer exposes CRUD helpers with full TypeScript types",
      "- Seed script can populate the DB with test fixtures",
    ].join("\n"),
    dependsOn: [1],
    milestone: "Foundation",
  },

  // ── API Layer (Layer 2) ────────────────────────────────────
  {
    title: "Build authentication API",
    description: [
      "Implement JWT-based authentication with signup, login, and token refresh",
      "endpoints. Include password hashing and rate limiting.",
      "",
      "Acceptance criteria:",
      "- POST /auth/signup creates a user and returns a JWT pair",
      "- POST /auth/login validates credentials and returns tokens",
      "- Middleware rejects requests with invalid or expired tokens",
    ].join("\n"),
    dependsOn: [2],
    milestone: "API Layer",
  },
  {
    title: "Build user profile API",
    description: [
      "Create REST endpoints for reading and updating user profiles,",
      "including avatar upload and email change with verification.",
      "",
      "Acceptance criteria:",
      "- GET /users/:id returns the public profile",
      "- PATCH /users/me updates the authenticated user's profile",
      "- Avatar upload accepts PNG/JPEG up to 2 MB and stores to S3",
    ].join("\n"),
    dependsOn: [2],
    milestone: "API Layer",
  },
  {
    title: "Build notification service",
    description: [
      "Create a notification microservice that handles email, push, and in-app",
      "notifications with template rendering and delivery tracking.",
      "",
      "Acceptance criteria:",
      "- Supports email, push, and in-app notification channels",
      "- Templates are rendered server-side with user context",
      "- Delivery status tracked per notification per channel",
    ].join("\n"),
    dependsOn: [2],
    milestone: "API Layer",
  },

  // ── Frontend (Layer 3) ─────────────────────────────────────
  {
    title: "Create login page",
    description: [
      "Build a responsive login page that calls the auth API,",
      "stores tokens, and redirects to the dashboard on success.",
      "",
      "Acceptance criteria:",
      "- Form validates email format and password length client-side",
      "- Displays server-side errors (wrong password, rate limit) inline",
      "- Persists JWT in httpOnly cookie or secure storage",
    ].join("\n"),
    dependsOn: [3],
    milestone: "Frontend",
  },
  {
    title: "Create profile page",
    description: [
      "Build a profile settings page that displays the current user's",
      "data and allows editing name, bio, and avatar.",
      "",
      "Acceptance criteria:",
      "- Profile fields pre-populate from the API on mount",
      "- Avatar preview shows before upload is confirmed",
      "- Success and error toasts appear after save",
    ].join("\n"),
    dependsOn: [4],
    milestone: "Frontend",
  },
  {
    title: "Create notification center",
    description: [
      "Build the in-app notification center UI with real-time updates,",
      "mark-as-read, and notification preferences panel.",
      "",
      "Acceptance criteria:",
      "- Bell icon shows unread count badge",
      "- Dropdown lists recent notifications with timestamps",
      "- Mark-as-read updates instantly via optimistic UI",
    ].join("\n"),
    dependsOn: [5],
    milestone: "Frontend",
  },

  // ── Integration (Layer 4) ──────────────────────────────────
  {
    title: "Build admin dashboard",
    description: [
      "Create an admin panel with user management, system metrics,",
      "and moderation tools. Requires auth + profile APIs.",
      "",
      "Acceptance criteria:",
      "- Admin role gate: non-admins see 403 page",
      "- User table with search, filter, and bulk actions",
      "- System health metrics displayed in real-time charts",
    ].join("\n"),
    dependsOn: [3, 4],
    milestone: "Integration",
  },
  {
    title: "Integrate payment processing",
    description: [
      "Add Stripe integration for subscription billing,",
      "including checkout, webhooks, and invoice generation.",
      "",
      "Acceptance criteria:",
      "- Checkout session creates a Stripe subscription",
      "- Webhooks handle payment_succeeded and payment_failed events",
      "- Users can view invoices and update payment method",
    ].join("\n"),
    dependsOn: [3, 4],
    milestone: "Integration",
  },
  {
    title: "Add WebSocket real-time updates",
    description: [
      "Implement WebSocket server for real-time notification delivery",
      "and live dashboard metric updates.",
      "",
      "Acceptance criteria:",
      "- WS connection authenticates via JWT token in handshake",
      "- Notifications delivered to connected clients within 500ms",
      "- Graceful reconnection with exponential backoff on client",
    ].join("\n"),
    dependsOn: [5, 8],
    milestone: "Integration",
  },

  // ── Quality & Deployment (Layer 5-6) ───────────────────────
  {
    title: "Add end-to-end tests",
    description: [
      "Write E2E tests covering the critical user flows: signup, login,",
      "profile update, payments, and notifications using Playwright.",
      "",
      "Acceptance criteria:",
      "- Tests run headless in CI and produce an HTML report",
      "- Coverage includes happy path and at least two error scenarios per flow",
      "- Test suite completes in under 90 seconds",
    ].join("\n"),
    dependsOn: [6, 7, 8, 9, 10, 11],
    milestone: "Quality & Deployment",
  },
  {
    title: "Set up CI/CD pipeline",
    description: [
      "Configure GitHub Actions to lint, test, and deploy the application",
      "on every push to main. Include staging and production environments.",
      "",
      "Acceptance criteria:",
      "- CI runs typecheck, lint, unit tests, and E2E tests in parallel jobs",
      "- Deployment to staging triggers automatically on merge to main",
      "- Production deploy requires manual approval via environment protection",
    ].join("\n"),
    dependsOn: [12],
    milestone: "Quality & Deployment",
  },
  {
    title: "Configure monitoring and alerts",
    description: [
      "Set up application monitoring with error tracking, performance metrics,",
      "and alerting rules for critical thresholds.",
      "",
      "Acceptance criteria:",
      "- Error tracking captures unhandled exceptions with stack traces",
      "- Response time P95 alerts if > 500ms for 5 minutes",
      "- Dashboard shows request rate, error rate, and latency percentiles",
    ].join("\n"),
    dependsOn: [12],
    milestone: "Quality & Deployment",
  },
];

// ── Seed logic (exported for reuse by demo.ts) ──────────────────

export function seedDatabase(dbPath: string): { db: Database; tasks: Task[]; layers: DAGLayer[]; sessionId: number } {
  const db = new Database(dbPath);
  db.init();

  const tasks: Task[] = [];

  for (const def of TASK_DEFS) {
    const resolvedDeps = def.dependsOn.map((pos) => {
      const depTask = tasks[pos - 1];
      if (!depTask) {
        throw new Error(`Task dep references position ${pos} but it hasn't been inserted yet`);
      }
      return depTask.id;
    });

    const task = db.createTask(def.title, def.description, resolvedDeps, def.milestone);
    tasks.push(task);
  }

  const sessionId = db.createSession();
  const layers = computeLayers(tasks);

  return { db, tasks, layers, sessionId };
}

// ── Pretty-print helpers ────────────────────────────────────────

function printTasks(tasks: Task[]): void {
  console.log(chalk.bold.cyan("\n  Tasks"));
  console.log(chalk.gray("  " + "─".repeat(60)));

  let currentMilestone = "";

  for (const task of tasks) {
    if (task.milestone && task.milestone !== currentMilestone) {
      currentMilestone = task.milestone;
      console.log(chalk.yellow(`\n  [${currentMilestone}]`));
    }

    const deps =
      task.dependsOn.length > 0
        ? chalk.gray(` (depends on: ${task.dependsOn.map((d) => `#${d}`).join(", ")})`)
        : "";

    console.log(`  ${chalk.white.bold(`#${task.id}`)} ${task.title}${deps}`);
  }
}

function printLayers(layers: DAGLayer[], tasks: Task[]): void {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  console.log(chalk.bold.cyan("\n  DAG Layers (execution order)"));
  console.log(chalk.gray("  " + "─".repeat(60)));

  for (const layer of layers) {
    const names = layer.taskIds.map((id) => {
      const t = taskMap.get(id);
      return t ? `#${t.id} ${t.title}` : `#${id}`;
    });

    console.log(chalk.green(`\n  Layer ${layer.index}`) + chalk.gray(` (${names.length} task${names.length > 1 ? "s" : ""}, parallel)`));
    for (const name of names) {
      console.log(chalk.white(`    ${name}`));
    }
  }
}

// ── Main ────────────────────────────────────────────────────────

function main(): void {
  const { dbPath } = parseArgs();

  console.log(chalk.bold.magenta("\n  Orchestrator Seed"));
  console.log(chalk.gray(`  DB path: ${dbPath}`));

  const { db, tasks, layers, sessionId } = seedDatabase(dbPath);

  printTasks(tasks);
  printLayers(layers, tasks);

  console.log(chalk.bold.green(`\n  Seeded ${tasks.length} tasks across ${layers.length} layers.`));
  console.log(chalk.gray(`  Session ID: ${sessionId}\n`));

  db.close();
}

// Run when executed directly
const isDirectRun =
  process.argv[1]?.endsWith("seed.ts") ||
  process.argv[1]?.endsWith("seed.js");

if (isDirectRun) {
  main();
}
