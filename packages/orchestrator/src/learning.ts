import fs from "fs";
import path from "path";

import type { Learning, OrchestratorConfig, TaskPhase } from "./types.js";
import type { Database } from "./db.js";
import type { ClaudeRunner } from "./claude.js";

// ── Helpers ───────────────────────────────────────────────────

/**
 * Extract the text content from a Claude CLI JSON result.
 * The `--output-format json` envelope wraps the assistant reply in a `result`
 * field.  Fall back to the raw stdout string if parsing fails.
 */
function extractText(stdout: string): string {
  if (!stdout.trim()) return "";
  const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { result?: string };
      if (typeof parsed.result === "string") return parsed.result;
    } catch {
      // skip non-JSON lines
    }
  }
  // Whole-blob fallback
  try {
    const parsed = JSON.parse(stdout.trim()) as { result?: string };
    if (typeof parsed.result === "string") return parsed.result;
  } catch {
    // ignore
  }
  return stdout;
}

// ── LearningPipeline ──────────────────────────────────────────

export class LearningPipeline {
  private db: Database;
  private claude: ClaudeRunner;
  private config: OrchestratorConfig;

  constructor(db: Database, claude: ClaudeRunner, config: OrchestratorConfig) {
    this.db = db;
    this.claude = claude;
    this.config = config;
  }

  // ── Stage 1: Capture ────────────────────────────────────────

  /**
   * Store a raw learning note captured during execution.
   * Returns the new learning ID.
   */
  capture(taskId: number, phase: TaskPhase, rawNote: string): number {
    try {
      return this.db.captureLearning(taskId, phase, rawNote);
    } catch (err) {
      console.error("[learning] capture failed:", err);
      return -1;
    }
  }

  /**
   * Format a learning from an error + its fix, then store it.
   * Returns the new learning ID.
   */
  captureFromError(
    taskId: number,
    phase: TaskPhase,
    error: string,
    fix: string
  ): number {
    const rawNote = `Error: ${error} | Fix applied: ${fix}`;
    return this.capture(taskId, phase, rawNote);
  }

  // ── Stage 2: Compile ────────────────────────────────────────

  /**
   * Compile all raw learnings into a single markdown file.
   * Returns the file path written, or null if no learnings exist.
   */
  compileLearnings(outputDir: string): string | null {
    const all = this.db.getAllLearnings();
    if (all.length === 0) return null;

    fs.mkdirSync(outputDir, { recursive: true });

    const lines = [
      "# Raw Learnings",
      "",
      `> ${all.length} learning(s) captured during this run.`,
      "",
    ];

    // Group by task for readability
    const byTask = new Map<number, Learning[]>();
    for (const l of all) {
      const list = byTask.get(l.taskId) ?? [];
      list.push(l);
      byTask.set(l.taskId, list);
    }

    for (const [taskId, learnings] of byTask) {
      lines.push(`## Task #${taskId}`);
      lines.push("");
      for (const l of learnings) {
        lines.push(`- **[${l.phase}]** ${l.rawNote}`);
      }
      lines.push("");
    }

    const filePath = path.join(outputDir, "learnings-raw.md");
    fs.writeFileSync(filePath, lines.join("\n"), "utf8");
    return filePath;
  }

  // ── Stage 3: Summarize ──────────────────────────────────────

  /**
   * Send the raw learnings to Claude for a condensed summary.
   * Writes the summary to `learnings-summary.md` and returns the content.
   */
  async summarizeLearnings(outputDir: string): Promise<string | null> {
    const rawPath = path.join(outputDir, "learnings-raw.md");
    if (!fs.existsSync(rawPath)) return null;

    const rawContent = fs.readFileSync(rawPath, "utf8");
    if (!rawContent.trim()) return null;

    const prompt = `You are reviewing learnings captured from an automated task execution system. Below are raw error notes and observations from a run.

Produce a concise, actionable summary in plain text (no markdown formatting — no #, *, **, or - list prefixes):
1. A short overview paragraph (2-3 sentences) of what went wrong and any patterns
2. A few key takeaways as plain numbered sentences — each should be a specific, actionable insight
3. If any learnings are noise or too generic to act on, omit them silently

Keep it concise and useful. No preamble, no sign-off — just the summary.

---

${rawContent}`;

    let result;
    try {
      result = await this.claude.runTask({
        prompt,
        cwd: this.config.projectDir,
        model: this.config.models.learning,
      });
    } catch (err) {
      console.error("[learning] summarize: Claude invocation failed:", err);
      return null;
    }

    if (result.exitCode !== 0) {
      console.error(
        "[learning] summarize: Claude exited with code",
        result.exitCode,
        result.stderr
      );
      return null;
    }

    const summaryText = extractText(result.stdout).trim();
    if (!summaryText) return null;

    fs.mkdirSync(outputDir, { recursive: true });
    const summaryPath = path.join(outputDir, "learnings-summary.md");
    fs.writeFileSync(summaryPath, summaryText, "utf8");

    return summaryText;
  }

  // ── Full pipeline ───────────────────────────────────────────

  /**
   * Run the full Capture → Compile → Summarize pipeline.
   * Called at end-of-run.  Never throws.
   * Returns the summary text (or null if nothing to summarize).
   */
  async runPipeline(
    outputDir: string
  ): Promise<{ count: number; summary: string | null }> {
    const all = this.db.getAllLearnings();
    const count = all.length;

    if (count === 0) {
      return { count: 0, summary: null };
    }

    let summary: string | null = null;

    try {
      this.compileLearnings(outputDir);
    } catch (err) {
      console.error("[learning] runPipeline: compile stage failed:", err);
      return { count, summary: null };
    }

    try {
      summary = await this.summarizeLearnings(outputDir);
    } catch (err) {
      console.error("[learning] runPipeline: summarize stage failed:", err);
    }

    return { count, summary };
  }
}
