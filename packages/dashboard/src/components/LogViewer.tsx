"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

export type LogEntry = { line: string; taskId?: number };

interface LogViewerProps {
  logs: LogEntry[];
  maxHeight?: number;
}

type FilterMode = "all" | "agent" | "tools";

type EventBase = { taskId?: number };

type ParsedEvent = EventBase & (
  | { kind: "system"; raw: string; summary: string; data: any }
  | { kind: "result"; raw: string; summary: string; data: any }
  | { kind: "usage"; raw: string; summary: string; data: any }
  | { kind: "agent-text"; raw: string; text: string }
  | {
      kind: "tool-pair";
      raw: string;
      name: string;
      input: any;
      toolUseId: string;
      result?: any;
      isError?: boolean;
      resultRaw?: string;
    }
  | { kind: "tool-result-orphan"; raw: string; toolUseId: string; content: any; isError: boolean }
  | { kind: "unknown-json"; raw: string; data: any }
  | { kind: "text"; raw: string }
);

function classify(logs: LogEntry[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const pairIndex = new Map<string, number>();

  for (const entry of logs) {
    const raw = entry.line;
    const taskId = entry.taskId;
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      events.push({ kind: "text", raw, taskId });
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      events.push({ kind: "unknown-json", raw, data: parsed, taskId });
      continue;
    }

    const t = parsed.type;

    if (t === "system") {
      const sub = parsed.subtype ?? "event";
      const model = parsed.model ? ` (${parsed.model})` : "";
      events.push({ kind: "system", raw, summary: `system: ${sub}${model}`, data: parsed, taskId });
      continue;
    }

    if (t === "result" || parsed.result !== undefined) {
      const txt = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? parsed);
      const trunc = txt.length > 140 ? txt.slice(0, 140) + "…" : txt;
      events.push({ kind: "result", raw, summary: `result: ${trunc}`, data: parsed, taskId });
      continue;
    }

    if (t === "assistant" && parsed.message?.content) {
      const content = parsed.message.content as any[];
      for (const item of content) {
        if (item?.type === "text" && typeof item.text === "string") {
          events.push({ kind: "agent-text", raw, text: item.text, taskId });
        } else if (item?.type === "tool_use") {
          const id = item.id ?? `${events.length}`;
          const ev: ParsedEvent = {
            kind: "tool-pair",
            raw,
            name: item.name ?? "tool",
            input: item.input ?? {},
            toolUseId: id,
            taskId,
          };
          pairIndex.set(id, events.length);
          events.push(ev);
        }
      }
      if (parsed.message?.usage) {
        const u = parsed.message.usage;
        events.push({
          kind: "usage",
          raw,
          summary: `tokens: ${u.input_tokens ?? 0}in / ${u.output_tokens ?? 0}out (cached: ${u.cache_read_input_tokens ?? 0})`,
          data: u,
          taskId,
        });
      }
      continue;
    }

    if (t === "user" && parsed.message?.content) {
      const content = parsed.message.content as any[];
      for (const item of content) {
        if (item?.type === "tool_result") {
          const id = item.tool_use_id ?? "";
          const isError = !!item.is_error;
          const existing = pairIndex.get(id);
          if (existing !== undefined && events[existing].kind === "tool-pair") {
            const pair = events[existing] as Extract<ParsedEvent, { kind: "tool-pair" }>;
            pair.result = item.content;
            pair.isError = isError;
            pair.resultRaw = raw;
          } else {
            events.push({
              kind: "tool-result-orphan",
              raw,
              toolUseId: id,
              content: item.content,
              isError,
              taskId,
            });
          }
        }
      }
      continue;
    }

    if (parsed.usage) {
      const u = parsed.usage;
      events.push({
        kind: "usage",
        raw,
        summary: `tokens: ${u.input_tokens ?? 0}in / ${u.output_tokens ?? 0}out (cached: ${u.cache_read_input_tokens ?? 0})`,
        data: u,
        taskId,
      });
      continue;
    }

    events.push({ kind: "unknown-json", raw, data: parsed, taskId });
  }

  return events;
}

function fmtJson(v: any): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function fmtNum(n: number): string {
  if (!n) return "0";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

function truncate(s: string, n: number): string {
  return s && s.length > n ? s.slice(0, n) + "…" : s || "";
}

function renderToolResultContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : fmtJson(c)))
      .join("\n");
  }
  return fmtJson(content);
}

const SVG = (d: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);

const Icon = {
  Wrench: () => SVG(<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.4 2.4-2.8-2.8Z" />),
  Message: () => SVG(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />),
  Terminal: () => SVG(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>),
  File: () => SVG(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>),
  FileEdit: () => SVG(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9" /><path d="M18 2l4 4-8 8h-4v-4z" /></>),
  Search: () => SVG(<><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.6" y2="16.6" /></>),
  Globe: () => SVG(<><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20Z" /></>),
  List: () => SVG(<><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></>),
  Folder: () => SVG(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />),
  Chev: () => SVG(<polyline points="9 18 15 12 9 6" />),
  Settings: () => SVG(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>),
  Alert: () => SVG(<><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>),
};

const toolIcon = (name: string) => {
  const n = (name || "").toLowerCase();
  if (n.includes("read")) return <Icon.File />;
  if (n.includes("write") || n.includes("edit")) return <Icon.FileEdit />;
  if (n.includes("bash") || n.includes("shell")) return <Icon.Terminal />;
  if (n.includes("glob")) return <Icon.Folder />;
  if (n.includes("grep") || n.includes("search")) return <Icon.Search />;
  if (n.includes("web") || n.includes("fetch")) return <Icon.Globe />;
  if (n.includes("todo") || n.includes("list")) return <Icon.List />;
  return <Icon.Wrench />;
};

function ToolInput({ name, input }: { name: string; input: any }) {
  if (!input || typeof input !== "object") return null;
  const n = (name || "").toLowerCase();

  if (n === "bash") {
    return (
      <div className="lv-kv">
        <div className="k">$</div>
        <div className="v cmd">{input.command}</div>
        {input.description && (
          <>
            <div className="k">desc</div>
            <div className="v">{input.description}</div>
          </>
        )}
      </div>
    );
  }
  if (n === "read") {
    return (
      <div className="lv-kv">
        <div className="k">file</div>
        <div className="v path">{input.file_path}</div>
        {input.offset != null && (<><div className="k">offset</div><div className="v">{input.offset}</div></>)}
        {input.limit != null && (<><div className="k">limit</div><div className="v">{input.limit}</div></>)}
      </div>
    );
  }
  if (n === "glob") {
    return (
      <div className="lv-kv">
        <div className="k">pattern</div>
        <div className="v pattern">{input.pattern}</div>
        {input.path && (<><div className="k">path</div><div className="v path">{input.path}</div></>)}
      </div>
    );
  }
  if (n === "grep") {
    return (
      <div className="lv-kv">
        <div className="k">pattern</div>
        <div className="v pattern">{input.pattern}</div>
        {input.path && (<><div className="k">path</div><div className="v path">{input.path}</div></>)}
        {input.output_mode && (<><div className="k">mode</div><div className="v">{input.output_mode}</div></>)}
      </div>
    );
  }
  if (n === "write") {
    return (
      <div className="lv-kv">
        <div className="k">file</div>
        <div className="v path">{input.file_path}</div>
        <div className="k">content</div>
        <div className="v">
          <pre className="lv-code wrap" style={{ margin: 0, padding: "8px 10px", maxHeight: 220 }}>{input.content}</pre>
        </div>
      </div>
    );
  }
  if (n === "edit") {
    return (
      <div className="lv-kv">
        <div className="k">file</div>
        <div className="v path">{input.file_path}</div>
        {input.old_string != null && (
          <>
            <div className="k">old</div>
            <div className="v"><pre className="lv-code wrap" style={{ margin: 0, padding: "8px 10px", maxHeight: 180 }}>{input.old_string}</pre></div>
          </>
        )}
        {input.new_string != null && (
          <>
            <div className="k">new</div>
            <div className="v"><pre className="lv-code wrap" style={{ margin: 0, padding: "8px 10px", maxHeight: 180 }}>{input.new_string}</pre></div>
          </>
        )}
      </div>
    );
  }
  return <pre className="lv-code wrap">{fmtJson(input)}</pre>;
}

function LongText({ content, max = 800 }: { content: string; max?: number }) {
  const [open, setOpen] = useState(false);
  if (!content) return null;
  const long = content.length > max;
  const shown = open || !long ? content : content.slice(0, max) + "…";
  return (
    <pre className="lv-code wrap">
      {shown}
      {long && (
        <button
          className="lv-trunc-btn"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "show less" : `show all (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </pre>
  );
}

function ToolResult({ name, result, isError }: { name: string; result: any; isError: boolean }) {
  if (result === undefined) {
    return <div className="lv-detail-body" style={{ color: "var(--lv-text-faint)", fontStyle: "italic" }}>awaiting result…</div>;
  }
  const text = renderToolResultContent(result);
  if (isError) return <div className="lv-err-body">{text}</div>;

  const n = (name || "").toLowerCase();
  if (n === "glob" || n === "ls") {
    const lines = text.split("\n").filter(Boolean);
    if (lines.length === 0 || text === "No files found") {
      return <div className="lv-filetree"><div className="empty">No files found</div></div>;
    }
    return (
      <div className="lv-filetree">
        {lines.slice(0, 30).map((l, i) => {
          const isDir = l.endsWith("/");
          return (
            <div key={i} className={"line " + (isDir ? "dir" : "")}>
              {isDir ? <Icon.Folder /> : <Icon.File />}
              <span className="name">{l}</span>
            </div>
          );
        })}
        {lines.length > 30 && (
          <div style={{ color: "var(--lv-text-faint)", marginTop: 6, fontStyle: "italic" }}>{lines.length - 30} more…</div>
        )}
      </div>
    );
  }
  if (n === "grep") {
    const lines = text.split("\n").filter(Boolean);
    return (
      <div className="lv-filetree">
        {lines.slice(0, 30).map((l, i) => (
          <div key={i} className="line">
            <Icon.File />
            <span className="name" style={{ color: "var(--lv-text-dim)" }}>{l}</span>
          </div>
        ))}
        {lines.length > 30 && <div style={{ color: "var(--lv-text-faint)", marginTop: 6 }}>{lines.length - 30} more matches…</div>}
      </div>
    );
  }
  if (n === "write" || n === "edit") {
    return <div className="lv-detail-body" style={{ color: "var(--lv-green)" }}>✓ {text}</div>;
  }
  return <LongText content={text} />;
}

function summaryFor(e: ParsedEvent): React.ReactNode {
  if (e.kind === "agent-text") return truncate(e.text, 160);
  if (e.kind === "tool-pair") {
    const input = e.input || {};
    const n = (e.name || "").toLowerCase();
    let hint: any = "";
    if (n === "bash") hint = input.command;
    else if (n === "read" || n === "write" || n === "edit") hint = input.file_path;
    else if (n === "glob" || n === "grep") hint = input.pattern;
    else hint = Object.values(input)[0];
    return (
      <>
        <strong>{e.name}</strong>
        {hint && (
          <>
            {" · "}
            <code>{truncate(String(hint), 80)}</code>
          </>
        )}
        {e.isError && (
          <>
            {" · "}
            <span style={{ color: "var(--lv-red)" }}>error</span>
          </>
        )}
        {e.result === undefined && (
          <>
            {" · "}
            <span style={{ color: "var(--lv-text-faint)" }}>pending</span>
          </>
        )}
      </>
    );
  }
  if (e.kind === "tool-result-orphan") {
    return (
      <>
        <strong>tool_result</strong>
        {e.isError && (<>{" · "}<span style={{ color: "var(--lv-red)" }}>error</span></>)}
      </>
    );
  }
  if (e.kind === "system") return e.summary;
  if (e.kind === "result") return e.summary;
  if (e.kind === "usage") return e.summary;
  if (e.kind === "text") return truncate(e.raw, 160);
  if (e.kind === "unknown-json") return "{ … }";
  return "";
}

function iconFor(e: ParsedEvent): React.ReactNode {
  if (e.kind === "agent-text") return <Icon.Message />;
  if (e.kind === "tool-pair") return toolIcon(e.name);
  if (e.kind === "tool-result-orphan") return <Icon.Wrench />;
  if (e.kind === "system") return <Icon.Settings />;
  if (e.kind === "result") return <Icon.Message />;
  if (e.kind === "usage") return <Icon.Settings />;
  return <Icon.Alert />;
}

function kindClass(e: ParsedEvent): string {
  if (e.kind === "agent-text") return "k-text";
  if (e.kind === "tool-pair") return "k-tool" + (e.isError ? " err" : "");
  if (e.kind === "tool-result-orphan") return "k-tool" + (e.isError ? " err" : "");
  if (e.kind === "system") return "k-system";
  if (e.kind === "result") return "k-text";
  if (e.kind === "usage") return "k-system";
  if (e.kind === "text") return "k-plain";
  if (e.kind === "unknown-json") return "k-unknown";
  return "k-system";
}

function labelFor(e: ParsedEvent): string {
  if (e.kind === "agent-text") return "Response";
  if (e.kind === "tool-pair") return "Tool";
  if (e.kind === "tool-result-orphan") return "Tool result";
  if (e.kind === "system") return "System";
  if (e.kind === "result") return "Result";
  if (e.kind === "usage") return "Usage";
  if (e.kind === "text") return "Log";
  return "JSON";
}

function tokenBits(data: any): string[] {
  const out: string[] = [];
  if (!data) return out;
  if (data.output_tokens) out.push(`${fmtNum(data.output_tokens)} out`);
  if (data.cache_read_input_tokens) out.push(`${fmtNum(data.cache_read_input_tokens)} cache`);
  if (data.cache_creation_input_tokens) out.push(`${fmtNum(data.cache_creation_input_tokens)} ✎`);
  return out;
}

function RowDetail({ event }: { event: ParsedEvent }) {
  if (event.kind === "agent-text") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className="lv-detail-header"><span className="label">assistant · response</span></div>
          <div className="lv-detail-body">{event.text}</div>
        </div>
      </div>
    );
  }
  if (event.kind === "tool-pair") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className="lv-detail-header">
            <span className="label">{event.name} · input</span>
            <span style={{ color: "var(--lv-text-faint)" }}>{event.toolUseId}</span>
          </div>
          <ToolInput name={event.name} input={event.input} />
        </div>
        <div className="lv-detail-section">
          <div className={"lv-detail-header " + (event.isError ? "err" : "")}>
            <span className="label">{event.isError ? "error" : "result"}</span>
            {typeof event.result === "string" && !event.isError && (
              <span style={{ color: "var(--lv-text-faint)" }}>{event.result.length.toLocaleString()} chars</span>
            )}
          </div>
          <ToolResult name={event.name} result={event.result} isError={!!event.isError} />
        </div>
      </div>
    );
  }
  if (event.kind === "tool-result-orphan") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className={"lv-detail-header " + (event.isError ? "err" : "")}>
            <span className="label">{event.isError ? "error" : "tool result"}</span>
            <span style={{ color: "var(--lv-text-faint)" }}>{event.toolUseId}</span>
          </div>
          {event.isError ? (
            <div className="lv-err-body">{renderToolResultContent(event.content)}</div>
          ) : (
            <LongText content={renderToolResultContent(event.content)} />
          )}
        </div>
      </div>
    );
  }
  if (event.kind === "system") {
    const d = event.data || {};
    return (
      <div className="lv-detail">
        <div className="lv-system-card">
          {d.session_id && (<div><span className="k">session </span><span className="v">{d.session_id}</span></div>)}
          {d.model && (<div><span className="k">model </span><span className="v">{d.model}</span></div>)}
          {d.cwd && (<div><span className="k">cwd </span><span className="v">{d.cwd}</span></div>)}
          {Array.isArray(d.tools) && (<div><span className="k">tools </span><span className="v">{d.tools.length} available</span></div>)}
        </div>
      </div>
    );
  }
  if (event.kind === "usage") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className="lv-detail-header"><span className="label">usage</span></div>
          <pre className="lv-code wrap">{fmtJson(event.data)}</pre>
        </div>
      </div>
    );
  }
  if (event.kind === "result") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className="lv-detail-header"><span className="label">result</span></div>
          <pre className="lv-code wrap">{fmtJson(event.data)}</pre>
        </div>
      </div>
    );
  }
  if (event.kind === "unknown-json") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className="lv-detail-header"><span className="label">json</span></div>
          <pre className="lv-code wrap">{fmtJson(event.data)}</pre>
        </div>
      </div>
    );
  }
  if (event.kind === "text") {
    return (
      <div className="lv-detail">
        <div className="lv-detail-section">
          <div className="lv-detail-header"><span className="label">raw</span></div>
          <div className="lv-detail-body mono">{event.raw}</div>
        </div>
      </div>
    );
  }
  return null;
}

function Row({ event, isOpen, onToggle }: { event: ParsedEvent; isOpen: boolean; onToggle: () => void }) {
  const bits = event.kind === "usage" ? tokenBits(event.data) : [];
  return (
    <div className={`lv-row ${kindClass(event)} ${isOpen ? "open" : ""}`} onClick={onToggle}>
      <div className="lv-row-icon"><div className="dot">{iconFor(event)}</div></div>
      <div className="lv-row-body">
        <div className="lv-row-head">
          <span className="chev"><Icon.Chev /></span>
          {event.taskId != null && <span className="lv-task-chip">#{event.taskId}</span>}
          <span className="lv-row-kind">{labelFor(event)}</span>
          <span className="lv-row-summary">{summaryFor(event)}</span>
          {bits.length > 0 && <span className="lv-row-meta"><span className="pill">{bits.join(" · ")}</span></span>}
        </div>
        {isOpen && <RowDetail event={event} />}
      </div>
    </div>
  );
}

const STYLES = `
.logview {
  --lv-bg: #1a1a19;
  --lv-bg-elev: #211f1e;
  --lv-bg-hover: #262422;
  --lv-panel: #1e1c1b;
  --lv-border: #34322e;
  --lv-border-soft: #2a2826;
  --lv-text: #e9e6dc;
  --lv-text-dim: #a29f94;
  --lv-text-faint: #6e6b62;
  --lv-accent: #d97757;
  --lv-accent-rgb: 217, 119, 87;
  --lv-blue: #7ba7cc;
  --lv-purple: #b392c7;
  --lv-green: #8db76e;
  --lv-yellow: #d9b15a;
  --lv-red: #d97070;
  --lv-cyan: #6fb6b0;
  --lv-mono: ui-monospace, "SF Mono", "JetBrains Mono", "Menlo", "Monaco", "Cascadia Code", Consolas, monospace;
  --lv-row-py: 10px;
  --lv-fs-body: 14px;
  --lv-fs-small: 12.5px;
  --lv-fs-tiny: 11px;

  background: var(--lv-bg);
  color: var(--lv-text);
  font-family: var(--lv-mono);
  font-size: var(--lv-fs-body);
  line-height: 1.55;
  border: 1px solid var(--lv-border);
  border-radius: 8px;
  overflow: hidden;
}

.logview * { box-sizing: border-box; }
.logview ::selection { background: rgba(var(--lv-accent-rgb), 0.3); }

.lv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--lv-border-soft);
  background: linear-gradient(to bottom, var(--lv-bg), var(--lv-bg-elev));
}

.lv-btn {
  font-family: var(--lv-mono);
  font-size: var(--lv-fs-tiny);
  background: transparent;
  color: var(--lv-text-dim);
  border: 1px solid var(--lv-border);
  padding: 5px 10px;
  border-radius: 5px;
  cursor: pointer;
  letter-spacing: 0.02em;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: all 0.1s;
  white-space: nowrap;
}
.lv-btn:hover { color: var(--lv-text); border-color: var(--lv-text-faint); background: var(--lv-bg-hover); }
.lv-btn.active { color: var(--lv-accent); border-color: var(--lv-accent); background: rgba(var(--lv-accent-rgb), 0.08); }

.lv-spacer { flex: 1; }
.lv-count { color: var(--lv-text-faint); font-size: var(--lv-fs-tiny); letter-spacing: 0.04em; }

.lv-list {
  padding: 8px 14px 16px;
  overflow-y: auto;
}

.lv-empty { color: var(--lv-text-faint); font-style: italic; padding: 18px 4px; }

.lv-row {
  position: relative;
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 10px;
  padding: var(--lv-row-py) 10px var(--lv-row-py) 0;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.08s;
}
.lv-row:hover { background: var(--lv-bg-hover); }
.lv-row.open { background: var(--lv-bg-elev); }

.lv-row-icon {
  grid-column: 1;
  grid-row: 1;
  width: 28px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}
.lv-row-icon .dot {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: var(--lv-bg-elev);
  border: 1px solid var(--lv-border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--lv-text-dim);
}
.lv-row-icon svg { width: 14px; height: 14px; }
.lv-row.k-user .dot { border-color: rgba(123, 167, 204, 0.35); color: var(--lv-blue); background: rgba(123,167,204,0.06); }
.lv-row.k-thinking .dot { border-color: rgba(179, 146, 199, 0.35); color: var(--lv-purple); background: rgba(179,146,199,0.06); }
.lv-row.k-tool .dot { border-color: rgba(141, 183, 110, 0.35); color: var(--lv-green); background: rgba(141,183,110,0.06); }
.lv-row.k-tool.err .dot { border-color: rgba(217, 112, 112, 0.45); color: var(--lv-red); background: rgba(217,112,112,0.08); }
.lv-row.k-text .dot { border-color: rgba(217, 119, 87, 0.40); color: var(--lv-accent); background: rgba(217, 119, 87, 0.06); }
.lv-row.k-system .dot { border-color: var(--lv-border); color: var(--lv-text-faint); }
.lv-row.k-plain .dot { border-color: var(--lv-border-soft); color: var(--lv-text-dim); background: rgba(255,255,255,0.015); }
.lv-row.k-unknown .dot { border-color: rgba(217, 177, 90, 0.40); color: var(--lv-yellow); background: rgba(217, 177, 90, 0.06); }
.lv-row.k-plain .lv-row-kind { color: var(--lv-text-dim); }
.lv-row.k-unknown .lv-row-kind { color: var(--lv-yellow); }

.lv-task-chip {
  font-family: var(--lv-mono);
  font-size: var(--lv-fs-tiny);
  color: var(--lv-text-dim);
  background: rgba(var(--lv-accent-rgb), 0.10);
  border: 1px solid rgba(var(--lv-accent-rgb), 0.25);
  padding: 1px 6px;
  border-radius: 3px;
  letter-spacing: 0.02em;
  flex-shrink: 0;
}

.lv-row-body { grid-column: 2; min-width: 0; }

.lv-row-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.lv-row-kind {
  font-size: var(--lv-fs-tiny);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--lv-text-faint);
  font-weight: 500;
  flex-shrink: 0;
}
.lv-row.k-user .lv-row-kind { color: var(--lv-blue); }
.lv-row.k-thinking .lv-row-kind { color: var(--lv-purple); }
.lv-row.k-tool .lv-row-kind { color: var(--lv-green); }
.lv-row.k-tool.err .lv-row-kind { color: var(--lv-red); }
.lv-row.k-text .lv-row-kind { color: var(--lv-accent); }

.lv-row-summary {
  color: var(--lv-text-dim);
  font-size: var(--lv-fs-small);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1;
}
.lv-row-summary strong { color: var(--lv-text); font-weight: 500; }
.lv-row-summary code {
  color: var(--lv-yellow);
  background: rgba(217, 177, 90, 0.08);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 12px;
}
.lv-row.open .lv-row-summary { white-space: normal; overflow: visible; text-overflow: clip; }

.lv-row-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: var(--lv-fs-tiny);
  color: var(--lv-text-faint);
  flex-shrink: 0;
}

.chev {
  display: inline-flex;
  width: 10px;
  color: var(--lv-text-faint);
  transform: rotate(0deg);
  transition: transform 0.12s;
  flex-shrink: 0;
}
.chev svg { width: 10px; height: 10px; }
.lv-row.open .chev { transform: rotate(90deg); color: var(--lv-text-dim); }

.lv-detail {
  margin-top: 12px;
  padding: 0;
  border-left: 2px solid var(--lv-border);
  padding-left: 14px;
  display: grid;
  gap: 12px;
}

.lv-detail-section {
  background: var(--lv-panel);
  border: 1px solid var(--lv-border-soft);
  border-radius: 5px;
  overflow: hidden;
}

.lv-detail-header {
  padding: 7px 12px;
  font-size: var(--lv-fs-tiny);
  color: var(--lv-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  background: rgba(255,255,255,0.015);
  border-bottom: 1px solid var(--lv-border-soft);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.lv-detail-header .label { color: var(--lv-text-dim); }
.lv-detail-header.err { color: var(--lv-red); }

.lv-detail-body {
  padding: 12px 14px;
  font-size: var(--lv-fs-small);
  color: var(--lv-text);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
  line-height: 1.65;
}
.lv-detail-body.mono { font-family: var(--lv-mono); }

.lv-trunc-btn {
  display: inline-block;
  margin-top: 10px;
  color: var(--lv-text-faint);
  background: transparent;
  border: 1px dashed var(--lv-border);
  padding: 3px 8px;
  border-radius: 4px;
  font-family: var(--lv-mono);
  font-size: var(--lv-fs-tiny);
  cursor: pointer;
}
.lv-trunc-btn:hover { color: var(--lv-text); border-color: var(--lv-text-faint); }

.lv-kv {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 6px 14px;
  font-size: var(--lv-fs-small);
  padding: 12px 14px;
}
.lv-kv .k { color: var(--lv-text-faint); font-size: var(--lv-fs-tiny); padding-top: 2px; }
.lv-kv .v {
  color: var(--lv-text);
  word-break: break-word;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.lv-kv .v.path { color: var(--lv-cyan); }
.lv-kv .v.cmd {
  background: rgba(0,0,0,0.3);
  padding: 4px 8px;
  border-radius: 3px;
  border: 1px solid var(--lv-border-soft);
  display: inline-block;
}
.lv-kv .v.pattern { color: var(--lv-yellow); }

.lv-filetree {
  padding: 12px 14px;
  font-size: var(--lv-fs-small);
  line-height: 1.7;
}
.lv-filetree .line {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--lv-text-dim);
}
.lv-filetree .line .name { color: var(--lv-text); }
.lv-filetree .line.dir .name { color: var(--lv-cyan); }
.lv-filetree .line svg { width: 12px; height: 12px; color: var(--lv-text-faint); }
.lv-filetree .empty { color: var(--lv-text-faint); font-style: italic; }

.lv-code {
  margin: 0;
  padding: 12px 14px;
  font-family: var(--lv-mono);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--lv-text);
  background: rgba(0,0,0,0.25);
  white-space: pre;
  overflow-x: auto;
  max-height: 420px;
}
.lv-code.wrap { white-space: pre-wrap; word-break: break-word; }

.lv-err-body {
  color: var(--lv-red);
  background: rgba(217, 112, 112, 0.05);
  border-left: 3px solid var(--lv-red);
  padding: 10px 14px;
  font-size: var(--lv-fs-small);
  white-space: pre-wrap;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255,255,255,0.03);
  color: var(--lv-text-faint);
  font-size: var(--lv-fs-tiny);
  border: 1px solid var(--lv-border-soft);
}
.pill.err { color: var(--lv-red); border-color: rgba(217,112,112,0.3); background: rgba(217,112,112,0.05); }

.lv-system-card {
  border: 1px dashed var(--lv-border);
  border-radius: 5px;
  padding: 10px 14px;
  font-size: var(--lv-fs-tiny);
  color: var(--lv-text-faint);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px 20px;
}
.lv-system-card .k { color: var(--lv-text-faint); }
.lv-system-card .v { color: var(--lv-text-dim); }

.logview ::-webkit-scrollbar { width: 9px; height: 9px; }
.logview ::-webkit-scrollbar-track { background: transparent; }
.logview ::-webkit-scrollbar-thumb { background: var(--lv-border); border-radius: 10px; }
.logview ::-webkit-scrollbar-thumb:hover { background: var(--lv-text-faint); }
`;

export default function LogViewer({ logs, maxHeight = 400 }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<FilterMode>("all");

  const events = useMemo(() => classify(logs), [logs]);

  const visible = useMemo(() => {
    const out: { event: ParsedEvent; index: number }[] = [];
    events.forEach((event, index) => {
      if (filter === "agent" && event.kind !== "agent-text" && event.kind !== "result") return;
      if (filter === "tools" && event.kind !== "tool-pair" && event.kind !== "tool-result-orphan") return;
      out.push({ event, index });
    });
    return out;
  }, [events, filter]);

  useEffect(() => {
    const el = containerRef.current;
    if (el && autoScrollRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs, filter]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    autoScrollRef.current = nearBottom;
  };

  const toggle = (i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  };

  const expandAll = () => setExpanded(new Set(visible.map((v) => v.index)));
  const collapseAll = () => setExpanded(new Set());

  return (
    <div className="logview">
      <style>{STYLES}</style>
      <div className="lv-toolbar">
        <button className={"lv-btn " + (filter === "all" ? "active" : "")} onClick={() => setFilter("all")}>all</button>
        <button className={"lv-btn " + (filter === "agent" ? "active" : "")} onClick={() => setFilter("agent")}>agent</button>
        <button className={"lv-btn " + (filter === "tools" ? "active" : "")} onClick={() => setFilter("tools")}>tools</button>
        <span className="lv-spacer" />
        <span className="lv-count">{visible.length} / {events.length}</span>
        <button className="lv-btn" onClick={expandAll}>expand</button>
        <button className="lv-btn" onClick={collapseAll}>collapse</button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="lv-list"
        style={{ maxHeight }}
      >
        {visible.length === 0 ? (
          <div className="lv-empty">{logs.length === 0 ? "No log output yet…" : "No events match filter."}</div>
        ) : (
          visible.map(({ event, index }) => (
            <Row key={index} event={event} isOpen={expanded.has(index)} onToggle={() => toggle(index)} />
          ))
        )}
      </div>
    </div>
  );
}
