import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Database } from "./db.js";
import { validateDAG } from "./dag.js";
import type { AgentTaskDef, Task, TaskEffort } from "./types.js";
import { ClaudeRunner } from "./claude.js";

// ── Types ────────────────────────────────────────────────────

export interface ScaffoldOptions {
  projectName: string;
  baseDir: string;
  testCommand?: string;
  architectureNotes?: string;
  dependencyNotes?: string;
  /** If provided, written verbatim to plan.md. Otherwise a stub plan is written. */
  planMarkdown?: string;
}

export interface ProjectScaffoldResult {
  projectDir: string;
  dbPath: string;
  planPath: string;
}

export interface ParsePlanUsage {
  tokensIn: number;
  tokensOut: number;
  cost: number;
  /** Number of distinct sub-agent Task tool invocations observed in the stream. */
  subagentCount: number;
}

export interface ParsePlanResult {
  taskCount: number;
  tasks: Task[];
  errors: string[];
  /** Usage metrics from agent-based parsing; omitted by the deterministic parsePlanToTasks path. */
  usage?: ParsePlanUsage;
  model?: string;
}

// ── Template Resolution ──────────────────────────────────────

function getTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/project.ts → packages/orchestrator → repo root → templates/
  const repoRoot = path.resolve(path.dirname(thisFile), "../../..");
  return path.join(repoRoot, "templates");
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// ── scaffoldProject ──────────────────────────────────────────

export function scaffoldProject(options: ScaffoldOptions): ProjectScaffoldResult {
  const { projectName, baseDir } = options;

  // Validate project name
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectName)) {
    throw new Error(`Invalid project name "${projectName}". Use alphanumeric, hyphens, dots, underscores.`);
  }

  const expandedBase = baseDir.startsWith("~")
    ? path.join(os.homedir(), baseDir.slice(1))
    : baseDir;
  const projectDir = path.resolve(expandedBase);

  // Check for collisions
  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir);
    const nonGit = entries.filter(e => e !== ".git");
    if (nonGit.length > 0) {
      throw new Error(`Directory "${projectDir}" already exists and is not empty.`);
    }
  }

  // Create project directory
  fs.mkdirSync(projectDir, { recursive: true });

  // Git init + initial commit (worktrees require at least one commit)
  execFileSync("git", ["init"], { cwd: projectDir, stdio: "pipe" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: projectDir, stdio: "pipe" });

  // .gitignore
  fs.writeFileSync(
    path.join(projectDir, ".gitignore"),
    [
      ".orchestrator/*.db",
      ".orchestrator/*.db-wal",
      ".orchestrator/*.db-shm",
      ".orchestrator/worktrees/",
      ".orchestrator/learnings/",
      "node_modules/",
      ".env",
      ".env.local",
      "",
    ].join("\n"),
  );

  // CLAUDE.md from template
  const templatesDir = getTemplatesDir();
  const claudeTemplate = fs.readFileSync(path.join(templatesDir, "CLAUDE.md.template"), "utf-8");
  const claudeMd = interpolateTemplate(claudeTemplate, {
    PROJECT_NAME: projectName,
    TEST_COMMAND: options.testCommand ?? "npm test",
    ARCHITECTURE_NOTES: options.architectureNotes ?? "_To be filled in after codebase map generation._",
    DEPENDENCY_NOTES: options.dependencyNotes ?? "_To be filled in after dependency analysis._",
  });
  fs.writeFileSync(path.join(projectDir, "CLAUDE.md"), claudeMd);

  // plan.md: pasted/provided content verbatim, or stub skeleton
  const planBody = options.planMarkdown?.trim()
    ? (options.planMarkdown.endsWith("\n") ? options.planMarkdown : options.planMarkdown + "\n")
    : [
        "# Project Plan",
        "",
        "<!-- Format: h2 = milestone (optional), h3 = task title -->",
        "<!-- Dependencies: add 'depends on: #1, #3' in the task description -->",
        "<!-- where #N refers to the Nth task in this plan (1-indexed) -->",
        "",
        "## Milestone 1",
        "",
        "### Task 1: Example task",
        "",
        "Description of what this task should accomplish.",
        "",
        "### Task 2: Another task",
        "",
        "Description here. Depends on: #1",
        "",
      ].join("\n");
  fs.writeFileSync(path.join(projectDir, "plan.md"), planBody);

  // Initialize SQLite DB
  const dbPath = path.join(projectDir, ".orchestrator/orchestrator.db");
  const db = new Database(dbPath);
  db.init();
  db.close();

  // Initial commit
  execFileSync("git", ["add", "-A"], { cwd: projectDir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "Initial project scaffold"], { cwd: projectDir, stdio: "pipe" });

  return {
    projectDir,
    dbPath,
    planPath: path.join(projectDir, "plan.md"),
  };
}

// ── parsePlanToTasks ─────────────────────────────────────────

export function parsePlanToTasks(
  db: Database,
  markdown: string,
  useMilestones: boolean = false,
): ParsePlanResult {
  const lines = markdown.split("\n");
  const taskDefs: Array<{
    title: string;
    description: string;
    dependsOn: number[];
    milestone?: string;
    effort?: TaskEffort;
  }> = [];
  let currentTitle = "";
  let currentLines: string[] = [];
  let currentMilestone: string | undefined;

  const flush = () => {
    if (currentTitle) {
      const desc = currentLines.join("\n").trim();
      const depMatch = desc.match(/depends?\s*on:?\s*(#\d+(?:\s*,\s*#\d+)*)/i);
      const deps = depMatch
        ? depMatch[1].match(/#(\d+)/g)?.map((d) => parseInt(d.slice(1))) ?? []
        : [];
      taskDefs.push({
        title: currentTitle,
        description: desc,
        dependsOn: deps,
        milestone: currentMilestone,
      });
    }
    currentTitle = "";
    currentLines = [];
  };

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    const h3Match = line.match(/^###\s+(.+)/);

    if (h2Match && !h3Match) {
      flush();
      if (useMilestones) {
        currentMilestone = h2Match[1].trim();
      }
      continue;
    }

    if (h3Match) {
      flush();
      currentTitle = h3Match[1].trim();
      continue;
    }

    if (currentTitle) {
      currentLines.push(line);
    }
  }
  flush();

  // Validate DAG — #N references are 1-indexed positions in this plan
  const errors: string[] = [];
  for (let i = 0; i < taskDefs.length; i++) {
    for (const dep of taskDefs[i].dependsOn) {
      if (dep < 1 || dep > taskDefs.length) {
        errors.push(`Task "${taskDefs[i].title}": depends on #${dep} but only ${taskDefs.length} tasks exist`);
      }
    }
  }

  if (errors.length > 0) {
    return { taskCount: 0, tasks: [], errors };
  }

  // Create tasks in DB — first pass creates all, second pass updates deps with real IDs
  const createdTasks: Task[] = [];
  const positionToId: Map<number, number> = new Map();

  for (let i = 0; i < taskDefs.length; i++) {
    const def = taskDefs[i];
    // Create with empty deps first
    const task = db.createTask(def.title, def.description, [], def.milestone, def.effort);
    createdTasks.push(task);
    positionToId.set(i + 1, task.id);
  }

  // Update deps with real IDs
  for (let i = 0; i < taskDefs.length; i++) {
    const def = taskDefs[i];
    if (def.dependsOn.length > 0) {
      const realDeps = def.dependsOn.map((pos) => positionToId.get(pos)!);
      db.updateTaskDependencies(createdTasks[i].id, realDeps);
      createdTasks[i].dependsOn = realDeps;
    }
  }

  // Validate the DAG
  const dagResult = validateDAG(createdTasks);
  if (!dagResult.valid) {
    errors.push(...dagResult.errors.map((e) => `DAG error: ${e}`));
  }

  return { taskCount: createdTasks.length, tasks: createdTasks, errors };
}

// ── listProjects ─────────────────────────────────────────────

export interface ProjectInfo {
  name: string;
  path: string;
  taskCount: number;
  lastModified: string;
}

export function listProjects(baseDir: string): ProjectInfo[] {
  const resolved = path.resolve(baseDir);
  if (!fs.existsSync(resolved)) return [];

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dbPath = path.join(resolved, entry.name, ".orchestrator/orchestrator.db");
    if (!fs.existsSync(dbPath)) continue;

    try {
      const db = new Database(dbPath);
      db.init();
      const tasks = db.getAllTasks();
      const stat = fs.statSync(dbPath);
      projects.push({
        name: entry.name,
        path: path.join(resolved, entry.name),
        taskCount: tasks.length,
        lastModified: stat.mtime.toISOString(),
      });
      db.close();
    } catch {
      // Skip corrupted DBs
    }
  }

  return projects.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

// ── agentParsePlan ────────────────────────────────────────────

export interface AgentParsePlanOptions {
  claude: ClaudeRunner;
  db: Database;
  planContent: string;
  projectDir: string;
  model?: string;
  effort?: TaskEffort;
  timeout?: number;
  onOutput?: (line: string) => void;
  /** Fires whenever a stream-json line carries cumulative usage/cost info. */
  onUsage?: (usage: ParsePlanUsage) => void;
  signal?: AbortSignal;
}

// Running totals extracted from a single stream-json line.
interface StreamUsageTick {
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  isSubagentStart?: boolean;
}

function parseUsageFromLine(line: string): StreamUsageTick | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const tick: StreamUsageTick = {};
  let hit = false;

  // Subagent spawn: assistant tool_use with name="Task"
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block?.type === "tool_use" && block.name === "Task") {
        tick.isSubagentStart = true;
        hit = true;
      }
    }
  }

  // Per-message usage (assistant messages include a `usage` block)
  const u = msg.message?.usage ?? msg.usage;
  if (u && typeof u === "object") {
    const input =
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    if (input > 0) {
      tick.tokensIn = input;
      hit = true;
    }
    if (typeof u.output_tokens === "number" && u.output_tokens > 0) {
      tick.tokensOut = u.output_tokens;
      hit = true;
    }
  }

  // Terminal result envelope
  const finalCost = msg.total_cost_usd ?? msg.cost_usd ?? msg.costUSD;
  if (typeof finalCost === "number" && finalCost > 0) {
    tick.cost = finalCost;
    hit = true;
  }

  return hit ? tick : null;
}

/**
 * Spawns a Claude agent with the /get-tasks skill to decompose a plan
 * into structured tasks. Uses ultrathink (effort=max) by default.
 * Returns tasks inserted into the DB with title-based dependency resolution.
 */
export async function agentParsePlan(options: AgentParsePlanOptions): Promise<ParsePlanResult> {
  const {
    claude,
    db,
    planContent,
    projectDir,
    model = "claude-opus-4-6",
    effort = "max",
    timeout = 10 * 60 * 1000,
    onOutput,
    onUsage,
    signal,
  } = options;

  // Build prompt: /get-tasks skill invocation + full plan content
  const prompt = `/get-tasks\n\n${planContent}`;

  const running: ParsePlanUsage = { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 };

  const result = await claude.runTask({
    prompt,
    cwd: projectDir,
    model,
    effort,
    timeout,
    signal,
    onOutput: (line) => {
      onOutput?.(line);
      if (!onUsage) return;
      const tick = parseUsageFromLine(line);
      if (!tick) return;
      // Per-message usage reflects that turn's context pressure (input = full re-sent
      // transcript; output = just that assistant reply). Track max for both to match how
      // the task dashboard computes the gauge (last-turn in + last-turn out).
      if (tick.tokensIn !== undefined && tick.tokensIn > running.tokensIn) running.tokensIn = tick.tokensIn;
      if (tick.tokensOut !== undefined && tick.tokensOut > running.tokensOut) running.tokensOut = tick.tokensOut;
      if (tick.cost !== undefined && tick.cost > running.cost) running.cost = tick.cost;
      if (tick.isSubagentStart) running.subagentCount += 1;
      onUsage({ ...running });
    },
  });

  // Peak per-turn pressure for both in and out (matches task-dashboard semantics).
  // result.{tokensIn,tokensOut} are last-turn values from parseCostFromOutput.
  const finalUsage: ParsePlanUsage = {
    tokensIn: Math.max(result.tokensIn, running.tokensIn),
    tokensOut: Math.max(result.tokensOut, running.tokensOut),
    cost: result.cost || running.cost,
    subagentCount: running.subagentCount,
  };

  if (result.exitCode !== 0) {
    return {
      taskCount: 0,
      tasks: [],
      errors: [`Agent failed (exit ${result.exitCode}): ${result.stderr}`],
      usage: finalUsage,
      model,
    };
  }

  // The /get-tasks skill writes tasks/tasks.json to projectDir. That file is
  // the contract — agent stdout is no longer parsed for task data.
  let taskDefs: AgentTaskDef[];
  try {
    taskDefs = await loadTaskDefs(projectDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      taskCount: 0,
      tasks: [],
      errors: [msg],
      usage: finalUsage,
      model,
    };
  }

  // Two-pass creation: first create all tasks, then resolve title-based deps
  const createdTasks: Task[] = [];
  const titleToId = new Map<string, number>();

  for (const def of taskDefs) {
    const task = db.createTask(def.title, def.description, [], undefined, undefined, def.contextFiles);
    createdTasks.push(task);
    titleToId.set(def.title, task.id);
  }

  // Resolve title-based dependencies to real DB IDs
  const errors: string[] = [];
  for (let i = 0; i < taskDefs.length; i++) {
    const def = taskDefs[i];
    if (def.dependsOn.length > 0) {
      const realDeps: number[] = [];
      for (const depTitle of def.dependsOn) {
        const depId = titleToId.get(depTitle);
        if (depId === undefined) {
          errors.push(`Task "${def.title}": depends on "${depTitle}" which doesn't exist in the plan`);
        } else {
          realDeps.push(depId);
        }
      }
      if (realDeps.length > 0) {
        db.updateTaskDependencies(createdTasks[i].id, realDeps);
        createdTasks[i].dependsOn = realDeps;
      }
    }
  }

  // Validate the DAG
  const dagResult = validateDAG(createdTasks);
  if (!dagResult.valid) {
    errors.push(...dagResult.errors.map((e) => `DAG error: ${e}`));
  }

  return { taskCount: createdTasks.length, tasks: createdTasks, errors, usage: finalUsage, model };
}

// ── tasks.json loader ────────────────────────────────────────

const TASKS_FILE_RELATIVE = path.join("tasks", "tasks.json");

async function loadTaskDefs(projectDir: string): Promise<AgentTaskDef[]> {
  const tasksPath = path.join(projectDir, TASKS_FILE_RELATIVE);

  let raw: string;
  try {
    raw = await fs.promises.readFile(tasksPath, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(
        `Plan parser did not produce ${TASKS_FILE_RELATIVE}. Expected at: ${tasksPath}`,
      );
    }
    throw new Error(`Failed to read ${tasksPath}: ${err?.message ?? err}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`${tasksPath} is not valid JSON: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).tasks)) {
    throw new Error(`${tasksPath} must be { "tasks": [...] } — got ${typeof parsed}`);
  }

  const out: AgentTaskDef[] = [];
  const rawTasks = (parsed as { tasks: unknown[] }).tasks;
  for (let i = 0; i < rawTasks.length; i++) {
    const t = rawTasks[i] as any;
    const where = `tasks[${i}]`;
    if (!t || typeof t !== "object") {
      throw new Error(`${where} is not an object`);
    }
    if (typeof t.title !== "string" || t.title.length === 0) {
      throw new Error(`${where}.title must be a non-empty string`);
    }
    if (typeof t.description !== "string") {
      throw new Error(`${where}.description must be a string`);
    }
    if (!Array.isArray(t.dependsOn) || !t.dependsOn.every((d: unknown) => typeof d === "string")) {
      throw new Error(`${where}.dependsOn must be string[]`);
    }
    let contextFiles: string[] | undefined;
    if (t.contextFiles !== undefined) {
      if (!Array.isArray(t.contextFiles) || !t.contextFiles.every((f: unknown) => typeof f === "string")) {
        throw new Error(`${where}.contextFiles must be string[] when present`);
      }
      contextFiles = t.contextFiles;
    }
    out.push({
      title: t.title,
      description: t.description,
      dependsOn: t.dependsOn,
      ...(contextFiles ? { contextFiles } : {}),
    });
  }
  return out;
}
