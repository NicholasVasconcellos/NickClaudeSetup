"use client";

import React from "react";

interface CostPanelProps {
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  taskCosts?: Map<number, number>;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export default function CostPanel({ totalCost, tokensIn, tokensOut, taskCosts }: CostPanelProps) {
  return (
    <div
      style={{
        backgroundColor: "var(--bg-secondary)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 16,
      }}
    >
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--text-muted)",
          marginBottom: 12,
        }}
      >
        Cost Summary
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Total Cost</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
            ${totalCost.toFixed(4)}
          </div>
        </div>

        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Tokens In</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>
              {formatTokenCount(tokensIn)}
            </div>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Tokens Out</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>
              {formatTokenCount(tokensOut)}
            </div>
          </div>
        </div>
      </div>

      {taskCosts && taskCosts.size > 0 && (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              color: "var(--text-muted)",
              marginBottom: 8,
            }}
          >
            Per Task
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {Array.from(taskCosts.entries())
              .sort(([, a], [, b]) => b - a)
              .map(([taskId, cost]) => (
                <div
                  key={taskId}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                  }}
                >
                  <span style={{ color: "var(--text-muted)" }}>#{taskId}</span>
                  <span style={{ color: "var(--text-secondary)" }}>${cost.toFixed(4)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
