// Parses claude CLI stream-json lines into typed events for UI rendering.
// See `claude --output-format stream-json --verbose` for message shape.

export type StreamEvent =
  | { kind: "system_init"; seq: number; model: string; cwd: string; sessionId: string }
  | { kind: "thinking"; seq: number; text: string }
  | { kind: "assistant_text"; seq: number; text: string }
  | { kind: "tool_use"; seq: number; id: string; name: string; input: unknown }
  | { kind: "tool_result"; seq: number; toolUseId: string; content: string; isError: boolean }
  | { kind: "result"; seq: number; text: string; cost: number; durationMs: number }
  | { kind: "raw"; seq: number; line: string };

interface AssistantContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: unknown;
}

interface UserContentBlock {
  type: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface StreamJsonMessage {
  type?: string;
  subtype?: string;
  model?: string;
  cwd?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  message?: {
    content?: AssistantContentBlock[] | UserContentBlock[];
  };
}

// Stable per-session sequence. Each parsed event gets a unique `seq` so React
// keys are stable even when the same content appears twice.
let nextSeq = 0;

export function resetStreamSeq(): void {
  nextSeq = 0;
}

function coerceToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
          return (block as { text: string }).text;
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

// Parse one stream-json line into zero-or-more events.
// A single assistant message may contain multiple content blocks → multiple events.
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];

  let msg: StreamJsonMessage;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [{ kind: "raw", seq: nextSeq++, line: trimmed }];
  }

  if (msg.type === "system" && msg.subtype === "init") {
    return [
      {
        kind: "system_init",
        seq: nextSeq++,
        model: msg.model ?? "",
        cwd: msg.cwd ?? "",
        sessionId: msg.session_id ?? "",
      },
    ];
  }

  if (msg.type === "assistant" && msg.message?.content) {
    const events: StreamEvent[] = [];
    for (const block of msg.message.content as AssistantContentBlock[]) {
      if (block.type === "thinking" && typeof block.thinking === "string") {
        events.push({ kind: "thinking", seq: nextSeq++, text: block.thinking });
      } else if (block.type === "text" && typeof block.text === "string") {
        events.push({ kind: "assistant_text", seq: nextSeq++, text: block.text });
      } else if (block.type === "tool_use") {
        events.push({
          kind: "tool_use",
          seq: nextSeq++,
          id: block.id ?? "",
          name: block.name ?? "?",
          input: block.input ?? {},
        });
      }
    }
    return events;
  }

  if (msg.type === "user" && msg.message?.content) {
    const events: StreamEvent[] = [];
    for (const block of msg.message.content as UserContentBlock[]) {
      if (block.type === "tool_result") {
        events.push({
          kind: "tool_result",
          seq: nextSeq++,
          toolUseId: block.tool_use_id ?? "",
          content: coerceToolResultContent(block.content),
          isError: block.is_error === true,
        });
      }
    }
    return events;
  }

  if (msg.type === "result") {
    return [
      {
        kind: "result",
        seq: nextSeq++,
        text: msg.result ?? "",
        cost: msg.total_cost_usd ?? 0,
        durationMs: msg.duration_ms ?? 0,
      },
    ];
  }

  // Unknown type — drop silently; the raw line is still in logs[] for debugging.
  return [];
}
