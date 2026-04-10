"use client";
import React from "react";

interface Suggestion {
  title: string;
  description: string;
  filePath: string;
}

interface SuggestionsProps {
  suggestions: Suggestion[];
}

export default function Suggestions({ suggestions }: SuggestionsProps) {
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase" as const,
          letterSpacing: "0.05em",
          color: "var(--text-muted)",
          marginBottom: 12,
        }}
      >
        Suggestions
      </div>
      {suggestions.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            fontStyle: "italic",
          }}
        >
          No suggestions yet
        </div>
      ) : (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            maxHeight: 300,
            overflowY: "auto" as const,
          }}
        >
          {suggestions.map((s, i) => (
            <div
              key={i}
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "10px 12px",
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--text-primary)",
                }}
              >
                {s.title}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  marginTop: 4,
                }}
              >
                {s.description}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
