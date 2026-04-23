import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Database } from "./db.js";
import { validateDAG } from "./dag.js";
import type { AgentTaskDef, ParsePlanMeta, ParsePlanStatus, Task, TaskEffort } from "./types.js";
import { ClaudeRunner } from "./claude.js";

// ── Parse-plan persistence paths ─────────────────────────────

const PARSE_PLAN_LOG_RELATIVE = path.join(".orchestrator", "parse-plan.log");
const PARSE_PLAN_META_RELATIVE = path.join(".orchestrator", "parse-plan-meta.json");
export const TASKS_FILE_RELATIVE = path.join("tasks", "tasks.json");

export function parsePlanLogPath(projectDir: string): string {
  return path.join(projectDir, PARSE_PLAN_LOG_RELATIVE);
}

export function parsePlanMetaPath(projectDir: string): string {
  return path.join(projectDir, PARSE_PLAN_META_RELATIVE);
}

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
  /** True if the agent subprocess was killed by the timeout (parse-plan specific). */
  timedOut?: boolean;
}

// ── Template Resolution ──────────────────────────────────────

function getRepoRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/project.ts (tsx) or dist/project.js → packages/orchestrator → repo root
  return path.resolve(path.dirname(thisFile), "../../..");
}

function getTemplatesDir(): string {
  return path.join(getRepoRoot(), "templates");
}

function getSkillsDir(): string {
  return path.join(getRepoRoot(), ".claude", "skills");
}

/**
 * Reads the project-local SKILL.md body for a given skill, stripping YAML
 * frontmatter. Claude Code CLI mode (`-p`) doesn't work with slash cmd
 * Returns empty string if the skill file is missing.
 */
export function loadSkillBody(projectDir: string, skillName: string): string {
  const skillPath = path.join(projectDir, ".claude", "skills", skillName, "SKILL.md");
  if (!fs.existsSync(skillPath)) return "";
  const raw = fs.readFileSync(skillPath, "utf-8");
  // Strip leading YAML frontmatter delimited by --- ... ---
  const match = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return (match ? raw.slice(match[0].length) : raw).trimStart();
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

  // Seed project-local skills from this repo so each project is pinned to the
  // orchestrator's expected skill versions (not ~/.claude/skills which can drift).
  const skillsSource = getSkillsDir();
  if (fs.existsSync(skillsSource)) {
    const skillsDest = path.join(projectDir, ".claude", "skills");
    fs.cpSync(skillsSource, skillsDest, { recursive: true });
  }

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
  parseStatus: ParsePlanStatus;
  hasTasksJson: boolean;
  canResumeParse: boolean;
}

export function listProjects(baseDir: string): ProjectInfo[] {
  const expanded = baseDir.startsWith("~")
    ? path.join(os.homedir(), baseDir.slice(1))
    : baseDir;
  const resolved = path.resolve(expanded);
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
      const projectPath = path.join(resolved, entry.name);
      const meta = readParsePlanMeta(projectPath);
      projects.push({
        name: entry.name,
        path: projectPath,
        taskCount: tasks.length,
        lastModified: stat.mtime.toISOString(),
        parseStatus: metaToStatus(meta),
        hasTasksJson: fs.existsSync(path.join(projectPath, TASKS_FILE_RELATIVE)),
        canResumeParse:
          !!meta?.sessionId &&
          (meta.errorKind === "plan_parse" || meta.errorKind === "plan_parse_timeout"),
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
  projectName?: string;
  model?: string;
  effort?: TaskEffort;
  timeout?: number;
  onOutput?: (line: string) => void;
  /** Fires whenever a stream-json line carries cumulative usage/cost info. */
  onUsage?: (usage: ParsePlanUsage) => void;
  signal?: AbortSignal;
  resumeSessionId?: string;
}

// Running totals extracted from a single stream-json line.
interface StreamUsageTick {
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  isSubagentStart?: boolean;
}

export function parseSessionIdFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const msg = JSON.parse(trimmed);
    if (msg?.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
      return msg.session_id;
    }
  } catch {
    return null;
  }
  return null;
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
    projectName = path.basename(projectDir),
    model = "claude-opus-4-6",
    effort = "max",
    timeout = 10 * 60 * 1000,
    onOutput,
    onUsage,
    signal,
    resumeSessionId,
  } = options;

  let prompt: string;
  if (resumeSessionId) {
    prompt =
      "Continue the prior /get-tasks run. The plan and skill instructions are " +
      "already in context. If tasks/tasks.json is already written, confirm and " +
      "stop. Otherwise finish producing it.";
  } else {
    const skillBody = loadSkillBody(projectDir, "get-tasks");
    if (!skillBody) {
      throw new Error(
        `get-tasks skill not found at ${projectDir}/.claude/skills/get-tasks/SKILL.md — ` +
        `scaffold did not copy skills correctly.`,
      );
    }
    prompt = `${skillBody}\n\n---\n\n## Plan\n\n${planContent}`;
  }

  const running: ParsePlanUsage = { tokensIn: 0, tokensOut: 0, cost: 0, subagentCount: 0 };
  let sessionId: string | null = resumeSessionId ?? null;

  // Persist the raw stream-json output so the dashboard can replay the run
  // after a disconnect/reload/server-restart. Truncates any prior log so retry
  // overwrites rather than appends.
  const logPath = parsePlanLogPath(projectDir);
  const metaPath = parsePlanMetaPath(projectDir);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: "w" });
  const startedAt = new Date().toISOString();
  logStream.write(
    JSON.stringify({ type: "header", startedAt, model, effort, timeout, projectName }) + "\n",
  );

  const result = await claude.runTask({
    prompt,
    cwd: projectDir,
    model,
    effort,
    timeout,
    signal,
    resumeSessionId,
    onOutput: (line) => {
      logStream.write(line + "\n");
      onOutput?.(line);
      if (!sessionId) {
        const sid = parseSessionIdFromLine(line);
        if (sid) sessionId = sid;
      }
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

  await new Promise<void>((resolve) => logStream.end(resolve));

  // Peak per-turn pressure for both in and out (matches task-dashboard semantics).
  // result.{tokensIn,tokensOut} are last-turn values from parseCostFromOutput.
  const finalUsage: ParsePlanUsage = {
    tokensIn: Math.max(result.tokensIn, running.tokensIn),
    tokensOut: Math.max(result.tokensOut, running.tokensOut),
    cost: result.cost || running.cost,
    subagentCount: running.subagentCount,
  };

  const writeMeta = (overrides: { taskCount?: number; errorKind?: ParsePlanMeta["errorKind"] } = {}) => {
    const stderrTail = result.stderr.length > 4096 ? result.stderr.slice(-4096) : result.stderr;
    const meta: ParsePlanMeta = {
      projectName,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      errorKind: overrides.errorKind ?? null,
      stderrTail,
      model,
      effort,
      taskCount: overrides.taskCount ?? 0,
      sessionId,
      usage: { ...finalUsage },
    };
    try {
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // Disk write is best-effort; don't fail the whole parse if it breaks.
    }
  };

  if (result.exitCode !== 0) {
    const kind: ParsePlanMeta["errorKind"] = result.timedOut ? "plan_parse_timeout" : "plan_parse";
    const msg = result.timedOut
      ? `Agent timed out after ${Math.round(result.duration / 60000)} min (common causes: system sleep, network hang).`
      : `Agent failed (exit ${result.exitCode}): ${result.stderr}`;
    writeMeta({ errorKind: kind });
    return {
      taskCount: 0,
      tasks: [],
      errors: [msg],
      usage: finalUsage,
      model,
      timedOut: result.timedOut,
    };
  }

  // The get-tasks skill instructs the agent to write tasks/tasks.json to
  // projectDir. That file is the contract — agent stdout is not parsed.
  let taskDefs: AgentTaskDef[];
  try {
    taskDefs = await loadTaskDefs(projectDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeMeta({ errorKind: "plan_parse" });
    return {
      taskCount: 0,
      tasks: [],
      errors: [msg],
      usage: finalUsage,
      model,
    };
  }

  const { created: createdTasks, errors } = insertTaskDefs(db, taskDefs);

  writeMeta({
    taskCount: createdTasks.length,
    errorKind: errors.length > 0 ? "plan_parse" : null,
  });

  return { taskCount: createdTasks.length, tasks: createdTasks, errors, usage: finalUsage, model };
}

export function insertTaskDefs(
  db: Database,
  taskDefs: AgentTaskDef[],
): { created: Task[]; errors: string[] } {
  const created: Task[] = [];
  const titleToId = new Map<string, number>();

  for (const def of taskDefs) {
    const task = db.createTask(def.title, def.description, [], undefined, undefined, def.contextFiles);
    created.push(task);
    titleToId.set(def.title, task.id);
  }

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
        db.updateTaskDependencies(created[i].id, realDeps);
        created[i].dependsOn = realDeps;
      }
    }
  }

  const dagResult = validateDAG(created);
  if (!dagResult.valid) {
    errors.push(...dagResult.errors.map((e) => `DAG error: ${e}`));
  }

  return { created, errors };
}

// ── readParsePlanState ───────────────────────────────────────

export interface ParsePlanState {
  logExists: boolean;
  meta: ParsePlanMeta | null;
  logLines: string[];
}

/**
 * Reads the persisted parse-plan log + meta for a project. Safe to call on
 * projects that never ran a parse — returns empty state rather than throwing.
 */
export function readParsePlanState(projectDir: string): ParsePlanState {
  const logPath = parsePlanLogPath(projectDir);
  const meta = readParsePlanMeta(projectDir);

  let logLines: string[] = [];
  let logExists = false;
  try {
    const raw = fs.readFileSync(logPath, "utf-8");
    logExists = true;
    // Preserve line order; drop the trailing empty string from split.
    logLines = raw.split("\n");
    if (logLines.length > 0 && logLines[logLines.length - 1] === "") logLines.pop();
  } catch {
    // Missing or unreadable
  }

  return { logExists, meta, logLines };
}

/** Reads parse-plan-meta.json or returns null if missing/unreadable. */
export function readParsePlanMeta(projectDir: string): ParsePlanMeta | null {
  try {
    const raw = fs.readFileSync(parsePlanMetaPath(projectDir), "utf-8");
    return JSON.parse(raw) as ParsePlanMeta;
  } catch {
    return null;
  }
}

/** Derives the badge status from a meta object (or lack thereof). */
export function metaToStatus(meta: ParsePlanMeta | null): ParsePlanStatus {
  if (!meta) return "unknown";
  return meta.exitCode === 0 && meta.errorKind === null ? "ok" : "failed";
}

/** Best-effort status for the "Open Existing" project list. */
export function readParsePlanStatus(projectDir: string): ParsePlanStatus {
  return metaToStatus(readParsePlanMeta(projectDir));
}

// ── tasks.json loader ────────────────────────────────────────

export async function loadTaskDefs(projectDir: string): Promise<AgentTaskDef[]> {
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
