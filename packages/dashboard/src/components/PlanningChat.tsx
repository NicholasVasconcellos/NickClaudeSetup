"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  options?: string[];
  timestamp: number;
}

interface PlanningChatProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isWaiting: boolean;
}

export type { ChatMessage };

export default function PlanningChat({ messages, onSendMessage, isWaiting }: PlanningChatProps) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isWaiting]);

  const handleSubmit = useCallback(() => {
    const text = input.trim();
    if (!text || isWaiting) return;
    onSendMessage(text);
    setInput("");
  }, [input, isWaiting, onSendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", width: "100%" }}>
      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {messages.length === 0 && !isWaiting && (
          <div style={{ color: "var(--text-muted)", fontSize: 13, fontStyle: "italic", textAlign: "center", marginTop: 40 }}>
            Ask the agent about your plan...
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i}>
            <div
              style={{
                display: "flex",
                justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
              }}
            >
              <div
                style={{
                  maxWidth: "80%",
                  padding: "10px 14px",
                  borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                  backgroundColor: msg.role === "user" ? "rgba(59,130,246,0.15)" : "var(--bg-tertiary)",
                  color: "var(--text-primary)",
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {msg.content}
              </div>
            </div>
            <div
              style={{
                fontSize: 10,
                color: "var(--text-muted)",
                marginTop: 2,
                textAlign: msg.role === "user" ? "right" : "left",
                paddingLeft: msg.role === "user" ? 0 : 4,
                paddingRight: msg.role === "user" ? 4 : 0,
              }}
            >
              {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </div>

            {/* Interactive options */}
            {msg.role === "assistant" && msg.options && msg.options.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
                {msg.options.map((opt, j) => (
                  <button
                    key={j}
                    onClick={() => onSendMessage(opt)}
                    disabled={isWaiting}
                    style={{
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      padding: "8px 14px",
                      fontSize: 12,
                      color: "var(--text-secondary)",
                      cursor: isWaiting ? "not-allowed" : "pointer",
                      transition: "border-color 0.15s, color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      if (!isWaiting) {
                        e.currentTarget.style.borderColor = "var(--accent)";
                        e.currentTarget.style.color = "var(--accent)";
                      }
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = "var(--border)";
                      e.currentTarget.style.color = "var(--text-secondary)";
                    }}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Typing indicator */}
        {isWaiting && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                padding: "10px 18px",
                borderRadius: "12px 12px 12px 2px",
                backgroundColor: "var(--bg-tertiary)",
                color: "var(--text-muted)",
                fontSize: 18,
                letterSpacing: 4,
              }}
            >
              <span style={{ animation: "chatDot 1.4s infinite", animationDelay: "0s" }}>.</span>
              <span style={{ animation: "chatDot 1.4s infinite", animationDelay: "0.2s" }}>.</span>
              <span style={{ animation: "chatDot 1.4s infinite", animationDelay: "0.4s" }}>.</span>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid var(--border)",
          padding: 12,
          display: "flex",
          gap: 8,
          alignItems: "flex-end",
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about your plan..."
          disabled={isWaiting}
          rows={1}
          style={{
            flex: 1,
            backgroundColor: "var(--bg-tertiary)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 12px",
            fontSize: 13,
            color: "var(--text-primary)",
            resize: "none",
            outline: "none",
            fontFamily: "inherit",
            lineHeight: 1.4,
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border)"; }}
        />
        <button
          onClick={handleSubmit}
          disabled={isWaiting || !input.trim()}
          style={{
            backgroundColor: isWaiting || !input.trim() ? "var(--bg-tertiary)" : "var(--accent)",
            color: isWaiting || !input.trim() ? "var(--text-muted)" : "#fff",
            border: "none",
            borderRadius: 6,
            padding: "8px 14px",
            fontSize: 14,
            fontWeight: 600,
            cursor: isWaiting || !input.trim() ? "not-allowed" : "pointer",
            flexShrink: 0,
          }}
        >
          →
        </button>
      </div>

      <style>{`
        @keyframes chatDot {
          0%, 20% { opacity: 0.2; }
          50% { opacity: 1; }
          80%, 100% { opacity: 0.2; }
        }
      `}</style>
    </div>
  );
}
