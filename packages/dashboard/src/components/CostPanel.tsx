"use client";

import React from "react";
import ContextBar, { getContextColor } from "./ContextBar";

interface CostPanelProps {
  totalCost: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead?: number;
  cacheCreation?: number;
  taskCosts?: Map<number, number>;
  taskContextData?: Map<number, { peakPercentage: number; totalTokensUsed: number }>;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

export default function CostPanel({ totalCost, tokensIn, tokensOut, cacheRead, cacheCreation, taskCosts, taskContextData }: CostPanelProps) {
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
          {cacheRead !== undefined && cacheRead > 0 && (
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
              {formatTokenCount(cacheRead)} cached reads
            </div>
          )}
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
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Cached</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-secondary)" }}>
              {cacheRead && cacheRead > 0 ? formatTokenCount(cacheRead) : "\u2014"}
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

      {taskContextData && taskContextData.size > 0 && (
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
            Context Usage
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {Array.from(taskContextData.entries())
              .sort(([, a], [, b]) => b.peakPercentage - a.peakPercentage)
              .map(([taskId, ctx]) => (
                <div key={taskId} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "var(--text-muted)", minWidth: 24 }}>
                    #{taskId}
                  </span>
                  <div style={{ flex: 1 }}>
                    <ContextBar
                      percentage={ctx.peakPercentage}
                      tokensUsed={ctx.totalTokensUsed}
                      contextLimit={0}
                      compact
                    />
                  </div>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 500,
                      color: getContextColor(ctx.peakPercentage),
                      minWidth: 32,
                      textAlign: "right",
                    }}
                  >
                    {ctx.peakPercentage.toFixed(0)}%
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
