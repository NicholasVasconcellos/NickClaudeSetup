import { fileURLToPath } from "node:url";
import path from "node:path";
import chalk from "chalk";

import { Runner } from "./runner.js";
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

// ── CLI Argument Parsing ──────────────────────────────────────

function parseArgs(argv: string[]): Partial<OrchestratorConfig> & { noPush?: boolean } {
  const args = argv.slice(2);
  const result: Partial<OrchestratorConfig> & { noPush?: boolean } = {};

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = args[i + 1];

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
      case "--main-branch":
        result.mainBranch = next;
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

if (isMain) {
  (async () => {
    const cliArgs = parseArgs(process.argv);

    const config: OrchestratorConfig = {
      ...DEFAULT_CONFIG,
      ...cliArgs,
    };

    printBanner(config);

    const runner = new Runner(config);

    // Graceful shutdown
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
