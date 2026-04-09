"use client";

import React from "react";

export function getContextColor(percentage: number): string {
  if (percentage >= 90) return "#ef4444";
  if (percentage >= 75) return "#f97316";
  if (percentage >= 50) return "#eab308";
  return "#22c55e";
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

interface ContextBarProps {
  percentage: number;
  tokensUsed: number;
  contextLimit: number;
  label?: string;
  compact?: boolean;
}

export default function ContextBar({ percentage, tokensUsed, contextLimit, label, compact }: ContextBarProps) {
  const color = getContextColor(percentage);
  const barHeight = compact ? 4 : 8;

  if (compact) {
    return (
      <div
        title={`${percentage.toFixed(0)}% context (${formatTokenCount(tokensUsed)} / ${formatTokenCount(contextLimit)})`}
        style={{
          width: "100%",
          height: barHeight,
          backgroundColor: "var(--bg-tertiary)",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(percentage, 1)}%`,
            height: "100%",
            backgroundColor: color,
            borderRadius: 2,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    );
  }

  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 3,
          fontSize: 11,
        }}
      >
        {label && (
          <span style={{ color: "var(--text-muted)", textTransform: "capitalize" }}>
            {label}
          </span>
        )}
        <span style={{ color: color, fontWeight: 500, marginLeft: "auto" }}>
          {percentage.toFixed(0)}%
          <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 4 }}>
            ({formatTokenCount(tokensUsed)} / {formatTokenCount(contextLimit)})
          </span>
        </span>
      </div>
      <div
        style={{
          width: "100%",
          height: barHeight,
          backgroundColor: "var(--bg-tertiary)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.max(percentage, 1)}%`,
            height: "100%",
            backgroundColor: color,
            borderRadius: 3,
            transition: "width 0.3s ease",
          }}
        />
      </div>
    </div>
  );
}
