import fs from "fs";
import path from "path";

import type { Learning, OrchestratorConfig, TaskPhase } from "./types.js";
import type { Database } from "./db.js";
import type { ClaudeRunner } from "./claude.js";

// ── Helpers ───────────────────────────────────────────────────

const BATCH_SIZE = 10;

const VALID_SKILL_TARGETS = new Set([
  "get-tasks",
  "spec",
  "execute",
  "review",
  "general",
]);

function normaliseSkillTarget(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  return VALID_SKILL_TARGETS.has(trimmed) ? trimmed : "general";
}

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

/**
 * Chunk an array into groups of at most `size` elements.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
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

  // ── Stage 2: Translate ──────────────────────────────────────

  /**
   * Convert unprocessed raw notes into actionable rules via Claude.
   * Returns the count of successfully translated learnings.
   */
  async translate(): Promise<number> {
    try {
      const all = this.db.getUnprocessedLearnings();
      // Only translate rows that have not yet been through translate
      // (actionableStep is null means they haven't been translated yet)
      const untranslated = all.filter((l) => l.actionableStep === null);
      if (untranslated.length === 0) return 0;

      let translated = 0;

      for (const batch of chunk(untranslated, BATCH_SIZE)) {
        const count = await this._translateBatch(batch);
        translated += count;
      }

      return translated;
    } catch (err) {
      console.error("[learning] translate failed:", err);
      return 0;
    }
  }

  private async _translateBatch(learnings: Learning[]): Promise<number> {
    const prompt = `You are analyzing learnings from an automated task execution system. For each raw note below, produce:
1. An actionable rule or tip (1-2 sentences, imperative mood)
2. Which skill file this should be added to: get-tasks, spec, execute, review, or general

Raw learnings:
${learnings.map((l) => `- [Task ${l.taskId}, ${l.phase}]: ${l.rawNote}`).join("\n")}

Respond as JSON array: [{ "id": number, "actionableStep": string, "skillTarget": string }]`;

    let result;
    try {
      result = await this.claude.runTask({
        prompt,
        cwd: this.config.projectDir,
        model: this.config.models.learning,
      });
    } catch (err) {
      console.error("[learning] translate Claude invocation failed:", err);
      return 0;
    }

    if (result.exitCode !== 0) {
      console.error(
        "[learning] translate: Claude exited with code",
        result.exitCode,
        result.stderr
      );
      return 0;
    }

    const text = extractText(result.stdout);

    let parsed: Array<{ id: number; actionableStep: string; skillTarget: string }>;
    try {
      // Extract JSON array from the response (may be wrapped in markdown code fences)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found in response");
      parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
    } catch (err) {
      console.error("[learning] translate: failed to parse Claude response:", err);
      return 0;
    }

    let count = 0;
    for (const item of parsed) {
      if (
        typeof item.id !== "number" ||
        typeof item.actionableStep !== "string" ||
        typeof item.skillTarget !== "string"
      ) {
        continue;
      }
      try {
        // Mark as translated but not yet validated
        this.db.updateLearning(
          item.id,
          item.actionableStep.trim(),
          false,
          normaliseSkillTarget(item.skillTarget)
        );
        count++;
      } catch (err) {
        console.error(`[learning] translate: updateLearning(${item.id}) failed:`, err);
      }
    }

    return count;
  }

  // ── Stage 3: Validate ───────────────────────────────────────

  /**
   * Validate translated-but-not-yet-validated learnings.
   * Returns the count of learnings marked as validated.
   */
  async validate(): Promise<number> {
    try {
      const all = this.db.getUnprocessedLearnings();
      // Translated but not yet validated: actionableStep is set, validated is false
      const toValidate = all.filter((l) => l.actionableStep !== null);
      if (toValidate.length === 0) return 0;

      let validated = 0;

      for (const batch of chunk(toValidate, BATCH_SIZE)) {
        const count = await this._validateBatch(batch);
        validated += count;
      }

      return validated;
    } catch (err) {
      console.error("[learning] validate failed:", err);
      return 0;
    }
  }

  private async _validateBatch(learnings: Learning[]): Promise<number> {
    const prompt = `You are validating actionable learnings captured from an automated task execution system.

For each learning below, decide:
1. Is this actually useful? (not noise or too generic)
2. Does it contradict known best practices?
3. Is it specific enough to act on?

Mark "keep": true only if the learning passes all three criteria.

Learnings:
${learnings
  .map(
    (l) =>
      `- id: ${l.id}, skill: ${l.skillTarget ?? "general"}\n  Rule: ${l.actionableStep}`
  )
  .join("\n")}

Respond as JSON array: [{ "id": number, "keep": boolean, "reason": string }]`;

    let result;
    try {
      result = await this.claude.runTask({
        prompt,
        cwd: this.config.projectDir,
        model: this.config.models.learning,
      });
    } catch (err) {
      console.error("[learning] validate Claude invocation failed:", err);
      return 0;
    }

    if (result.exitCode !== 0) {
      console.error(
        "[learning] validate: Claude exited with code",
        result.exitCode,
        result.stderr
      );
      return 0;
    }

    const text = extractText(result.stdout);

    let parsed: Array<{ id: number; keep: boolean; reason: string }>;
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) throw new Error("No JSON array found in response");
      parsed = JSON.parse(jsonMatch[0]) as typeof parsed;
    } catch (err) {
      console.error("[learning] validate: failed to parse Claude response:", err);
      return 0;
    }

    let count = 0;
    for (const item of parsed) {
      if (typeof item.id !== "number" || typeof item.keep !== "boolean") {
        continue;
      }
      const learning = learnings.find((l) => l.id === item.id);
      if (!learning || learning.actionableStep === null) continue;

      if (item.keep) {
        try {
          this.db.updateLearning(
            item.id,
            learning.actionableStep,
            true,
            learning.skillTarget ?? "general"
          );
          count++;
        } catch (err) {
          console.error(`[learning] validate: updateLearning(${item.id}) failed:`, err);
        }
      } else {
        // Discard: mark as validated=true with a note that it was discarded,
        // but drop it so it doesn't re-enter the queue.  We reuse the same
        // update path; callers of getAllLearnings will see validated=true.
        try {
          this.db.updateLearning(
            item.id,
            learning.actionableStep,
            true,          // consume it so it leaves the unprocessed queue
            "__discarded"  // special sentinel — applyToSkills will skip it
          );
        } catch {
          // best-effort discard
        }
      }
    }

    return count;
  }

  // ── Apply to skills ─────────────────────────────────────────

  /**
   * Append validated learnings to the matching skill files under `skillsDir`.
   * Creates a "## Learnings" section if one doesn't already exist.
   * Returns the count of learnings written to disk.
   */
  async applyToSkills(skillsDir: string): Promise<number> {
    try {
      const all = this.db.getAllLearnings();
      const validated = all.filter(
        (l) =>
          l.validated &&
          l.actionableStep !== null &&
          l.skillTarget !== null &&
          l.skillTarget !== "__discarded"
      );

      if (validated.length === 0) return 0;

      // Group by skillTarget
      const byTarget = new Map<string, Learning[]>();
      for (const l of validated) {
        const target = l.skillTarget!;
        const existing = byTarget.get(target) ?? [];
        existing.push(l);
        byTarget.set(target, existing);
      }

      let applied = 0;

      for (const [target, learnings] of byTarget) {
        const filePath = path.join(skillsDir, `${target}.md`);
        const newLines = learnings
          .map((l) => `- ${l.actionableStep!.trim()}`)
          .join("\n");

        try {
          let content: string;

          if (fs.existsSync(filePath)) {
            content = fs.readFileSync(filePath, "utf8");
          } else {
            // Create a minimal stub if the file doesn't exist
            content = `# ${target}\n`;
          }

          if (content.includes("## Learnings")) {
            // Append after the last line of the existing Learnings section
            content = content.trimEnd() + "\n" + newLines + "\n";
          } else {
            // Add the section at the end
            content = content.trimEnd() + "\n\n## Learnings\n" + newLines + "\n";
          }

          fs.writeFileSync(filePath, content, "utf8");
          applied += learnings.length;
        } catch (err) {
          console.error(`[learning] applyToSkills: failed to write ${filePath}:`, err);
        }
      }

      return applied;
    } catch (err) {
      console.error("[learning] applyToSkills failed:", err);
      return 0;
    }
  }

  // ── Full pipeline ───────────────────────────────────────────

  /**
   * Run the full Capture → Translate → Validate → Apply pipeline.
   * Called at end-of-run.  Never throws.
   */
  async runPipeline(
    skillsDir: string
  ): Promise<{ translated: number; validated: number; applied: number }> {
    let translated = 0;
    let validated = 0;
    let applied = 0;

    try {
      translated = await this.translate();
    } catch (err) {
      console.error("[learning] runPipeline: translate stage failed:", err);
    }

    try {
      validated = await this.validate();
    } catch (err) {
      console.error("[learning] runPipeline: validate stage failed:", err);
    }

    try {
      applied = await this.applyToSkills(skillsDir);
    } catch (err) {
      console.error("[learning] runPipeline: applyToSkills stage failed:", err);
    }

    return { translated, validated, applied };
  }
}
