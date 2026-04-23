"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

interface LogViewerProps {
  logs: string[];
  maxHeight?: number;
}

type FilterMode = "all" | "agent" | "tools";

type ParsedEvent =
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
  | { kind: "text"; raw: string };

function classify(logs: string[]): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const pairIndex = new Map<string, number>();

  for (const raw of logs) {
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      events.push({ kind: "text", raw });
      continue;
    }

    if (!parsed || typeof parsed !== "object") {
      events.push({ kind: "unknown-json", raw, data: parsed });
      continue;
    }

    const t = parsed.type;

    if (t === "system") {
      const sub = parsed.subtype ?? "event";
      const model = parsed.model ? ` (${parsed.model})` : "";
      events.push({ kind: "system", raw, summary: `system: ${sub}${model}`, data: parsed });
      continue;
    }

    if (t === "result" || parsed.result !== undefined) {
      const txt = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed.result ?? parsed);
      const trunc = txt.length > 140 ? txt.slice(0, 140) + "…" : txt;
      events.push({ kind: "result", raw, summary: `result: ${trunc}`, data: parsed });
      continue;
    }

    if (t === "assistant" && parsed.message?.content) {
      const content = parsed.message.content as any[];
      for (const item of content) {
        if (item?.type === "text" && typeof item.text === "string") {
          events.push({ kind: "agent-text", raw, text: item.text });
        } else if (item?.type === "tool_use") {
          const id = item.id ?? `${events.length}`;
          const ev: ParsedEvent = {
            kind: "tool-pair",
            raw,
            name: item.name ?? "tool",
            input: item.input ?? {},
            toolUseId: id,
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
      });
      continue;
    }

    events.push({ kind: "unknown-json", raw, data: parsed });
  }

  return events;
}

function textColor(line: string): string {
  if (line.includes("ERROR") || line.includes("error")) return "var(--error)";
  if (line.includes("WARN") || line.includes("warn")) return "var(--warning)";
  if (line.includes("SUCCESS") || line.includes("success")) return "var(--success)";
  return "var(--text-secondary)";
}

function fmtJson(v: any): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
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

  const rowBase: React.CSSProperties = {
    borderBottom: "1px solid #1a1a1a",
    padding: "2px 0",
    cursor: "pointer",
  };

  const gutter = (n: number) => (
    <span style={{ color: "var(--text-muted)", marginRight: 8, userSelect: "none" }}>
      {String(n + 1).padStart(4, " ")}
    </span>
  );

  const pre: React.CSSProperties = {
    margin: "4px 0 4px 36px",
    padding: "8px 10px",
    backgroundColor: "#141414",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const btn = (active: boolean): React.CSSProperties => ({
    padding: "4px 10px",
    fontSize: 11,
    background: active ? "var(--accent)" : "transparent",
    color: active ? "#fff" : "var(--text-secondary)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    cursor: "pointer",
  });

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <button style={btn(filter === "all")} onClick={() => setFilter("all")}>All</button>
        <button style={btn(filter === "agent")} onClick={() => setFilter("agent")}>Agent text</button>
        <button style={btn(filter === "tools")} onClick={() => setFilter("tools")}>Tool calls</button>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          backgroundColor: "#0d0d0d",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "12px 16px",
          maxHeight,
          overflowY: "auto",
          fontFamily:
            '"SF Mono", "Fira Code", "Fira Mono", "Roboto Mono", Menlo, Monaco, Consolas, monospace',
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {visible.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
            {logs.length === 0 ? "No log output yet..." : "No events match filter."}
          </div>
        ) : (
          visible.map(({ event, index }) => {
            const isOpen = expanded.has(index);

            if (event.kind === "text") {
              return (
                <div key={index} style={{ ...rowBase, cursor: "default", color: textColor(event.raw) }}>
                  {gutter(index)}
                  {event.raw}
                </div>
              );
            }

            if (event.kind === "agent-text") {
              return (
                <div key={index} style={{ ...rowBase, cursor: "default", color: "var(--text-primary, #eee)" }}>
                  {gutter(index)}
                  {event.text}
                </div>
              );
            }

            if (event.kind === "system" || event.kind === "result" || event.kind === "usage") {
              const color = event.kind === "result" ? "var(--success)" : "var(--text-muted)";
              return (
                <div key={index}>
                  <div style={{ ...rowBase, color }} onClick={() => toggle(index)}>
                    {gutter(index)}
                    <span style={{ marginRight: 6 }}>{isOpen ? "▼" : "▶"}</span>
                    {event.summary}
                  </div>
                  {isOpen && <pre style={pre}>{fmtJson(event.data)}</pre>}
                </div>
              );
            }

            if (event.kind === "tool-pair") {
              const dot = event.result === undefined
                ? "var(--warning)"
                : event.isError
                  ? "var(--error)"
                  : "var(--success)";
              return (
                <div key={index}>
                  <div style={{ ...rowBase, color: "var(--text-secondary)" }} onClick={() => toggle(index)}>
                    {gutter(index)}
                    <span style={{ marginRight: 6 }}>{isOpen ? "▼" : "▶"}</span>
                    <span
                      style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: dot,
                        marginRight: 8,
                      }}
                    />
                    <span style={{ color: "var(--accent)" }}>🔧 {event.name}</span>
                    {event.result === undefined && (
                      <span style={{ color: "var(--text-muted)", marginLeft: 8 }}>(pending)</span>
                    )}
                  </div>
                  {isOpen && (
                    <div style={{ display: "flex", gap: 8, margin: "4px 0 4px 36px" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>input</div>
                        <pre style={{ ...pre, margin: 0 }}>{fmtJson(event.input)}</pre>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 2 }}>
                          result{event.isError ? " (error)" : ""}
                        </div>
                        <pre
                          style={{
                            ...pre,
                            margin: 0,
                            color: event.isError ? "var(--error)" : "var(--text-secondary)",
                          }}
                        >
                          {event.result === undefined ? "(awaiting)" : renderToolResultContent(event.result)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            if (event.kind === "tool-result-orphan") {
              const color = event.isError ? "var(--error)" : "var(--text-secondary)";
              return (
                <div key={index}>
                  <div style={{ ...rowBase, color }} onClick={() => toggle(index)}>
                    {gutter(index)}
                    <span style={{ marginRight: 6 }}>{isOpen ? "▼" : "▶"}</span>
                    ↳ tool_result{event.isError ? " (error)" : ""}
                  </div>
                  {isOpen && <pre style={pre}>{renderToolResultContent(event.content)}</pre>}
                </div>
              );
            }

            return (
              <div key={index}>
                <div style={{ ...rowBase, color: "var(--text-muted)" }} onClick={() => toggle(index)}>
                  {gutter(index)}
                  <span style={{ marginRight: 6 }}>{isOpen ? "▼" : "▶"}</span>
                  {"{…}"}
                </div>
                {isOpen && <pre style={pre}>{fmtJson(event.data)}</pre>}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
