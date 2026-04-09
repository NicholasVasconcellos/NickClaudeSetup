import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { OrchestratorConfig } from "./types.js";

interface ExecResult {
  stdout: string;
  stderr: string;
}

export class GitManager {
  private projectDir: string;
  private mainBranch: string;

  constructor(config: OrchestratorConfig) {
    this.projectDir = config.projectDir;
    this.mainBranch = config.mainBranch;
  }

  // ── Private Helpers ──────────────────────────────────────────

  private exec(args: string[]): Promise<ExecResult> {
    return new Promise((resolve_fn, reject) => {
      execFile("git", args, { cwd: this.projectDir, timeout: 30_000 }, (err, stdout, stderr) => {
        if (err) {
          const error = new Error(`git ${args.join(" ")} failed: ${err.message}`);
          (error as NodeJS.ErrnoException & { stdout: string; stderr: string }).stdout = stdout;
          (error as NodeJS.ErrnoException & { stdout: string; stderr: string }).stderr = stderr;
          reject(error);
        } else {
          resolve_fn({ stdout: stdout.trim(), stderr: stderr.trim() });
        }
      });
    });
  }

  private worktreePath(taskId: number): string {
    return resolve(this.projectDir, `.orchestrator/worktrees/task-${taskId}`);
  }

  private branchName(taskId: number): string {
    return `task/${taskId}`;
  }

  // ── Public Methods ───────────────────────────────────────────

  async createWorktree(taskId: number): Promise<{ worktreePath: string; branch: string }> {
    const branch = this.branchName(taskId);
    const worktreePath = this.worktreePath(taskId);

    await this.exec([
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      this.mainBranch,
    ]);

    return { worktreePath, branch };
  }

  async removeWorktree(taskId: number): Promise<void> {
    const worktreePath = this.worktreePath(taskId);
    const branch = this.branchName(taskId);

    try {
      await this.exec(["worktree", "remove", "--force", worktreePath]);
    } catch {
      // silently ignore — cleanup should not fail the run
    }

    try {
      await this.exec(["branch", "-D", branch]);
    } catch {
      // silently ignore
    }
  }

  async mergeTask(taskId: number): Promise<{ success: boolean; conflicts: string[] }> {
    const branch = this.branchName(taskId);

    await this.exec(["checkout", this.mainBranch]);

    try {
      await this.exec([
        "merge",
        "--no-ff",
        "-m",
        `Merge task ${taskId}`,
        branch,
      ]);
      return { success: true, conflicts: [] };
    } catch {
      // Collect conflicting files
      let conflicts: string[] = [];
      try {
        const { stdout } = await this.exec(["diff", "--name-only", "--diff-filter=U"]);
        conflicts = stdout.length > 0 ? stdout.split("\n").filter(Boolean) : [];
      } catch {
        // best-effort — return empty list if we can't determine conflicts
      }
      return { success: false, conflicts };
    }
  }

  async push(): Promise<void> {
    await this.exec(["push", "origin", this.mainBranch]);
  }

  async abortMerge(): Promise<void> {
    await this.exec(["merge", "--abort"]);
  }

  async getCurrentBranch(): Promise<string> {
    const { stdout } = await this.exec(["rev-parse", "--abbrev-ref", "HEAD"]);
    return stdout;
  }

  async ensureClean(): Promise<boolean> {
    const { stdout } = await this.exec(["status", "--porcelain"]);
    return stdout.length === 0;
  }

  async cleanupOrphanedWorktrees(): Promise<number> {
    const { stdout } = await this.exec(["worktree", "list", "--porcelain"]);

    // Parse porcelain output — each worktree block is separated by a blank line
    const blocks = stdout.split("\n\n").filter(Boolean);
    const worktreePrefix = resolve(this.projectDir, ".orchestrator/worktrees/");

    let orphanCount = 0;
    for (const block of blocks) {
      const pathLine = block.split("\n").find((l) => l.startsWith("worktree "));
      if (!pathLine) continue;
      const worktreeFsPath = pathLine.slice("worktree ".length).trim();
      if (worktreeFsPath.startsWith(worktreePrefix)) {
        orphanCount++;
      }
    }

    // Prune stale worktree administrative files
    try {
      await this.exec(["worktree", "prune"]);
    } catch {
      // best-effort
    }

    return orphanCount;
  }
}
