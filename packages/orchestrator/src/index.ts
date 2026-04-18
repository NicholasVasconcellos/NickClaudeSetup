import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import chalk from "chalk";

import { Runner } from "./runner.js";
import { Database } from "./db.js";
import { scaffoldProject, parsePlanToTasks, listProjects, agentParsePlan } from "./project.js";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "./types.js";

// ── Re-exports ────────────────────────────────────────────────

export { Runner } from "./runner.js";
export { Database } from "./db.js";
export { GitManager } from "./git.js";
export { ClaudeRunner } from "./claude.js";
export { StateMachine } from "./state-machine.js";
export { EventBus } from "./ws-server.js";
export { LearningPipeline } from "./learning.js";
export * from "./types.js";
export { buildBlockedByMap, getDependents, validateDAG } from "./dag.js";
export { scaffoldProject, parsePlanToTasks, listProjects, agentParsePlan } from "./project.js";

// ── CLI Argument Parsing ──────────────────────────────────────

interface ParsedArgs extends Partial<OrchestratorConfig> {
  noPush?: boolean;
  subcommand?: string;
  positional: string[];
  baseDir?: string;
  testCommand?: string;
  planFile?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const result: ParsedArgs = { positional: [] };

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];

    if (!flag.startsWith("--")) {
      if (!result.subcommand) result.subcommand = flag;
      else result.positional.push(flag);
      continue;
    }

    switch (flag) {
      case "--project-dir":
        result.projectDir = path.resolve(next);
        i++;
        break;
      case "--db-path":
        result.dbPath = next;
        i++;
        break;
      case "--concurrency":
        result.maxConcurrency = parseInt(next, 10);
        i++;
        break;
      case "--timeout":
        result.taskTimeout = parseInt(next, 10);
        i++;
        break;
      case "--overall-timeout":
        result.overallTimeout = parseInt(next, 10);
        i++;
        break;
      case "--ws-port":
        result.wsPort = parseInt(next, 10);
        i++;
        break;
      case "--no-push":
        result.pushAfterMerge = false;
        break;
      case "--milestones":
        result.useMilestones = true;
        break;
      case "--main-branch":
        result.mainBranch = next;
        i++;
        break;
      case "--base-dir":
        result.baseDir = next;
        i++;
        break;
      case "--test-command":
        result.testCommand = next;
        i++;
        break;
      case "--plan-file":
        result.planFile = next;
        i++;
        break;
    }
  }

  return result;
}

// ── Startup Banner ────────────────────────────────────────────

function printBanner(config: OrchestratorConfig): void {
  console.log(chalk.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.cyan("  Claude Orchestrator v3.0.0"));
  console.log(chalk.cyan(`  Project:     ${config.projectDir}`));
  console.log(chalk.cyan(`  Dashboard:   ws://localhost:${config.wsPort}`));
  console.log(chalk.cyan(`  Concurrency: ${config.maxConcurrency}`));
  console.log(chalk.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
}

// ── Main ──────────────────────────────────────────────────────

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

// ── Helpers ────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ── Subcommand: execute ──────────────────────────────────────

async function cmdExecute(args: ParsedArgs): Promise<void> {
  // Resolve plan file — first positional arg or --plan-file
  const planFile = args.positional[0]
    ? path.resolve(args.positional[0])
    : args.planFile
      ? path.resolve(args.planFile)
      : null;

  if (!planFile) {
    console.error(chalk.red("Usage: orchestrator execute <plan.md> [--project-dir <path>] [--test-command <cmd>]"));
    process.exit(1);
  }

  if (!fs.existsSync(planFile)) {
    console.error(chalk.red(`Plan file not found: ${planFile}`));
    process.exit(1);
  }

  const planContent = fs.readFileSync(planFile, "utf-8");

  // Derive project name from plan filename (e.g. my-app.md → my-app)
  const projectName = path.basename(planFile, path.extname(planFile)).replace(/[^a-zA-Z0-9._-]/g, "-");
  const projectDir = args.projectDir ?? path.resolve(projectName);

  // Step 1: Scaffold project (deterministic)
  const needsScaffold = !fs.existsSync(path.join(projectDir, ".orchestrator", "orchestrator.db"));

  if (needsScaffold) {
    console.log(chalk.cyan("Scaffolding project..."));
    const baseDir = path.dirname(projectDir);
    const dirName = path.basename(projectDir);
    const result = scaffoldProject({
      projectName: dirName,
      baseDir,
      testCommand: args.testCommand,
    });
    console.log(chalk.green(`  Project: ${result.projectDir}`));
    console.log(chalk.green(`  DB:      ${result.dbPath}`));

    // Copy plan into project dir
    fs.copyFileSync(planFile, path.join(result.projectDir, "plan.md"));
  } else {
    console.log(chalk.cyan(`Using existing project at ${projectDir}`));
  }

  // Step 2: Create runner and initialize
  const config: OrchestratorConfig = {
    ...DEFAULT_CONFIG,
    ...args,
    projectDir,
    dbPath: path.join(projectDir, ".orchestrator", "orchestrator.db"),
  };

  printBanner(config);

  const runner = new Runner(config);

  const shutdown = async (signal: string) => {
    console.log(chalk.yellow(`\nReceived ${signal}, shutting down…`));
    await runner.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await runner.init();

    // Step 3: Agent-based plan parsing (ultrathink)
    console.log(chalk.cyan("\nParsing plan with agent (ultrathink)..."));
    const taskCount = await runner.loadPlanWithAgent(planContent);
    console.log(chalk.green(`  ${taskCount} tasks created\n`));

    // Step 4: Wait for user to review + start via dashboard
    console.log(chalk.yellow("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
    console.log(chalk.yellow("  Tasks loaded. Open the dashboard to review."));
    console.log(chalk.yellow(`  Dashboard: http://localhost:3200`));
    console.log(chalk.yellow("  Press Start in the UI to begin execution."));
    console.log(chalk.yellow("  Ctrl+C to quit."));
    console.log(chalk.yellow("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));

    // Keep alive — WS server keeps the event loop running.
    // The dashboard sends run:start which triggers runner.run().
    await new Promise<void>(() => {});
  } catch (err) {
    console.error(chalk.red("Execute error:"), err);
    process.exit(1);
  }
}

// ── Subcommand: status ────────────────────────────────────────

function cmdStatus(args: ParsedArgs): void {
  const projectDir = args.projectDir ?? process.cwd();
  const dbPath = path.join(projectDir, ".orchestrator", "orchestrator.db");

  if (!fs.existsSync(dbPath)) {
    console.error(chalk.red(`No orchestrator DB found at ${dbPath}`));
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.init();

  try {
    const tasks = db.getAllTasks();

    if (tasks.length === 0) {
      console.log(chalk.yellow("No tasks found. Run parse-plan first."));
      return;
    }

    // Table header
    const hId = pad("ID", 5);
    const hTitle = pad("Title", 36);
    const hState = pad("State", 12);
    const hPhase = pad("Phase", 10);
    const hDeps = "Dependencies";
    console.log(chalk.bold(`${hId} ${hTitle} ${hState} ${hPhase} ${hDeps}`));
    console.log("─".repeat(80));

    for (const t of tasks) {
      const id = pad(String(t.id), 5);
      const title = pad(t.title.slice(0, 34), 36);
      const stateColor =
        t.state === "done" || t.state === "merged" ? chalk.green
        : t.state === "failed" ? chalk.red
        : t.state === "pending" ? chalk.gray
        : chalk.yellow;
      const state = pad(stateColor(t.state), 12 + (stateColor(t.state).length - t.state.length));
      const phase = pad(t.phase ?? "—", 10);
      const deps = t.dependsOn.length ? t.dependsOn.map((d) => `#${d}`).join(", ") : "—";
      console.log(`${id} ${title} ${state} ${phase} ${deps}`);
    }

    // Summary
    const counts = { pending: 0, active: 0, done: 0, merged: 0, failed: 0 };
    for (const t of tasks) {
      if (t.state === "pending" || t.state === "paused") counts.pending++;
      else if (t.state === "spec" || t.state === "executing" || t.state === "reviewing" || t.state === "documenting") counts.active++;
      else if (t.state === "done") counts.done++;
      else if (t.state === "merged") counts.merged++;
      else if (t.state === "failed") counts.failed++;
    }

    console.log();
    console.log(
      chalk.gray(`Pending: ${counts.pending}`) + "  " +
      chalk.yellow(`Active: ${counts.active}`) + "  " +
      chalk.green(`Done: ${counts.done}`) + "  " +
      chalk.cyan(`Merged: ${counts.merged}`) + "  " +
      chalk.red(`Failed: ${counts.failed}`)
    );
  } finally {
    db.close();
  }
}

// ── Dispatch ──────────────────────────────────────────────────

if (isMain) {
  const cliArgs = parseArgs(process.argv);

  switch (cliArgs.subcommand) {
    case "execute":
      cmdExecute(cliArgs);
      break;

    case "status":
      cmdStatus(cliArgs);
      break;

    default: {
      // Default: run the orchestrator (direct execution, tasks already in DB)
      (async () => {
        const config: OrchestratorConfig = {
          ...DEFAULT_CONFIG,
          ...cliArgs,
        };

        printBanner(config);

        const runner = new Runner(config);

        const shutdown = async (signal: string) => {
          console.log(chalk.yellow(`\nReceived ${signal}, shutting down…`));
          await runner.shutdown();
        };

        process.on("SIGINT", () => shutdown("SIGINT"));
        process.on("SIGTERM", () => shutdown("SIGTERM"));

        try {
          await runner.init();
          const summary = await runner.run();

          console.log(chalk.green("\n── Run Complete ──────────────────────────────"));
          console.log(chalk.green(`  Tasks completed: ${summary.completed}/${summary.totalTasks}`));
          if (summary.failed > 0) {
            console.log(chalk.red(`  Tasks failed:    ${summary.failed}`));
          }
          if (summary.skipped > 0) {
            console.log(chalk.yellow(`  Tasks skipped:   ${summary.skipped}`));
          }
          console.log(chalk.green(`  Total cost:      $${summary.totalCost.toFixed(4)}`));
          console.log(chalk.green(`  Learnings:       ${summary.learnings}`));
          console.log(
            chalk.green(`  Duration:        ${(summary.duration / 1000).toFixed(1)}s`)
          );
          console.log(chalk.green("──────────────────────────────────────────────"));
        } catch (err) {
          console.error(chalk.red("Orchestrator error:"), err);
          process.exit(1);
        }
      })();
    }
  }
}
