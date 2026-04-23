import { spawn } from "node:child_process";
import { ClaudeResult, OrchestratorConfig, TaskEffort } from "./types.js";

// ── RunTaskOptions ────────────────────────────────────────────

export interface RunTaskOptions {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: TaskEffort;
  timeout?: number;
  onOutput?: (line: string) => void;
  signal?: AbortSignal;
  resumeSessionId?: string;
}

// ── Cost parsing helpers ──────────────────────────────────────

interface CostData {
  cost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheCreation: number;
}

// Shape of the JSON stream messages emitted by `claude --output-format stream-json`
// and also the final result object from `--output-format json`.
interface ClaudeJsonMessage {
  type?: string;
  // Top-level result envelope (--output-format json / stream-json terminal event)
  result?: string;
  cost_usd?: number;
  total_cost_usd?: number;
  // Usage block sometimes nested under a "usage" key
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  // Direct fields on some message types
  input_tokens?: number;
  output_tokens?: number;
  // Alternate camelCase keys seen in older CLI versions
  costUSD?: number;
}

// ── ClaudeRunner ──────────────────────────────────────────────

export class ClaudeRunner {
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  // ── checkAvailable ──────────────────────────────────────────

  async checkAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const proc = spawn("claude", ["--version"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
  }

  // ── parseCostFromOutput ─────────────────────────────────────

  parseCostFromOutput(output: string): CostData {
    const zero: CostData = { cost: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0 };

    if (!output.trim()) return zero;

    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheCreation = 0;

    // The CLI may emit one JSON object per line (streaming) or a single blob.
    // Try line-by-line first, then fall back to whole-string parse.
    const lines = output.split("\n").filter((l) => l.trim().startsWith("{"));
    const candidates: string[] = lines.length > 0 ? lines : [output.trim()];

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as ClaudeJsonMessage;

        // Cost: prefer costUSD, then cost_usd, then total_cost_usd (stream-json terminal)
        const parsedCost = parsed.costUSD ?? parsed.cost_usd ?? parsed.total_cost_usd;
        if (typeof parsedCost === "number" && parsedCost > 0) {
          cost = parsedCost;
        }

        // Tokens from nested usage block — keep cache fields separate from fresh input.
        // The terminal usage payload is cumulative, so take the max seen so far.
        if (parsed.usage) {
          const u = parsed.usage;
          if ((u.input_tokens ?? 0) > tokensIn) tokensIn = u.input_tokens!;
          if ((u.output_tokens ?? 0) > tokensOut) tokensOut = u.output_tokens!;
          if ((u.cache_read_input_tokens ?? 0) > cacheRead) cacheRead = u.cache_read_input_tokens!;
          if ((u.cache_creation_input_tokens ?? 0) > cacheCreation) cacheCreation = u.cache_creation_input_tokens!;
        }

        // Tokens as direct fields (some CLI versions)
        if (
          typeof parsed.input_tokens === "number" &&
          parsed.input_tokens > tokensIn
        ) {
          tokensIn = parsed.input_tokens;
        }
        if (
          typeof parsed.output_tokens === "number" &&
          parsed.output_tokens > tokensOut
        ) {
          tokensOut = parsed.output_tokens;
        }
      } catch {
        // Not valid JSON — skip this line
      }
    }

    // Last-resort regex sweeps for resilience against unexpected output shapes
    if (cost === 0) {
      const costMatch = output.match(/"(?:total_cost_usd|cost_usd|costUSD)"\s*:\s*([\d.]+)/);
      if (costMatch) cost = parseFloat(costMatch[1]);
    }
    if (tokensIn === 0) {
      const match = output.match(/"input_tokens"\s*:\s*(\d+)/);
      if (match) tokensIn = parseInt(match[1], 10);
    }
    if (tokensOut === 0) {
      const match = output.match(/"output_tokens"\s*:\s*(\d+)/);
      if (match) tokensOut = parseInt(match[1], 10);
    }

    return { cost, tokensIn, tokensOut, cacheRead, cacheCreation };
  }

  // ── runTask ─────────────────────────────────────────────────

  async runTask(options: RunTaskOptions): Promise<ClaudeResult> {
    const {
      prompt,
      cwd,
      model,
      effort,
      onOutput,
      signal: externalSignal,
      resumeSessionId,
    } = options;

    const timeout = options.timeout ?? this.config.taskTimeout;
    const resolvedModel =
      model ?? this.config.models.execute ?? "claude-sonnet-4-6";

    const startTime = Date.now();

    // Internal AbortController used for timeout; we listen to the external
    // signal separately so both can trigger a kill without one consuming the
    // other's event listener.
    const timeoutController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    // Tracks whether we initiated the kill so we can set exitCode = -1
    let killedByUs = false;
    // Set when the timeout handler fires — distinguishes timeout from external aborts.
    let timedOut = false;

    return new Promise<ClaudeResult>((resolve) => {
      const args = [
        ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
        "-p",
        prompt,
        "--model",
        resolvedModel,
        ...(effort ? ["--effort", effort] : []),
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ];

      let proc: ReturnType<typeof spawn> | undefined;

      try {
        proc = spawn("claude", args, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (spawnError) {
        // CLI binary not found or other spawn-time error
        resolve({
          exitCode: -1,
          stdout: "",
          stderr: String(spawnError),
          cost: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheCreation: 0,
          duration: Date.now() - startTime,
          timedOut: false,
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      // ── stdout: line-buffered streaming ──────────────────────
      let lineBuffer = "";

      proc.stdout!.on("data", (chunk: Buffer) => {
        stdoutChunks.push(chunk);

        lineBuffer += chunk.toString("utf8");
        const parts = lineBuffer.split("\n");
        // All but the last element are complete lines
        lineBuffer = parts.pop() ?? "";
        for (const line of parts) {
          onOutput?.(line);
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrChunks.push(chunk);
      });

      // ── kill helper ───────────────────────────────────────────
      const killProc = () => {
        if (!proc || proc.exitCode !== null || proc.killed) return;
        killedByUs = true;
        try {
          // Kill the process group to take down any children as well
          process.kill(-proc.pid!, "SIGTERM");
        } catch {
          try {
            proc.kill("SIGTERM");
          } catch {
            // Process already gone — ignore
          }
        }
      };

      // ── timeout ───────────────────────────────────────────────
      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          timeoutController.abort();
          killProc();
        }, timeout);
      }

      // ── external AbortSignal ──────────────────────────────────
      const onExternalAbort = () => killProc();
      if (externalSignal) {
        if (externalSignal.aborted) {
          killProc();
        } else {
          externalSignal.addEventListener("abort", onExternalAbort, {
            once: true,
          });
        }
      }

      // ── process exit ──────────────────────────────────────────
      proc.on("close", (code, signalName) => {
        // Cleanup
        clearTimeout(timeoutHandle);
        externalSignal?.removeEventListener("abort", onExternalAbort);

        // Flush any remaining incomplete line in buffer
        if (lineBuffer) {
          onOutput?.(lineBuffer);
          lineBuffer = "";
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const duration = Date.now() - startTime;

        const exitCode =
          killedByUs || signalName
            ? -1
            : (code ?? -1);

        const { cost, tokensIn, tokensOut, cacheRead, cacheCreation } = this.parseCostFromOutput(stdout);

        resolve({
          exitCode,
          stdout,
          stderr,
          cost,
          tokensIn,
          tokensOut,
          cacheRead,
          cacheCreation,
          duration,
          timedOut,
        });
      });

      // ── spawn error (e.g. ENOENT after spawn ─────────────────
      proc.on("error", (err) => {
        clearTimeout(timeoutHandle);
        externalSignal?.removeEventListener("abort", onExternalAbort);

        resolve({
          exitCode: -1,
          stdout: "",
          stderr: err.message,
          cost: 0,
          tokensIn: 0,
          tokensOut: 0,
          cacheRead: 0,
          cacheCreation: 0,
          duration: Date.now() - startTime,
          timedOut: false,
        });
      });
    });
  }
}
