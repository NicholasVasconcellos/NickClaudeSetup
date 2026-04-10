"use client";
import React, { useMemo } from "react";

interface BranchInfo {
  taskId: number;
  branch: string;
  status: "created" | "merged" | "deleted";
}

interface BranchGraphProps {
  branches: Map<number, BranchInfo>;
  taskPositions: Map<number, { layerIdx: number }>;
  cardWidth?: number;
  layerGap?: number;
  padding?: number;
}

const STATUS_COLORS: Record<string, string> = {
  created: "var(--accent)",
  merged: "var(--success)",
  deleted: "var(--text-muted)",
};

const MAIN_Y = 15;
const BRANCH_Y = 40;
const HEIGHT = 60;

export default function BranchGraph({
  branches,
  taskPositions,
  cardWidth = 200,
  layerGap = 60,
  padding = 24,
}: BranchGraphProps) {
  const entries = useMemo(() => {
    const result: Array<BranchInfo & { x: number }> = [];
    for (const [taskId, info] of branches) {
      const pos = taskPositions.get(taskId);
      if (!pos) continue;
      const x = padding + pos.layerIdx * (cardWidth + layerGap) + cardWidth / 2;
      result.push({ ...info, x });
    }
    result.sort((a, b) => a.x - b.x);
    return result;
  }, [branches, taskPositions, cardWidth, layerGap, padding]);

  if (entries.length === 0) return null;

  // Compute SVG width to cover all branches plus some trailing room
  const maxX = entries.reduce((m, e) => Math.max(m, e.x), 0);
  const totalWidth = maxX + cardWidth / 2 + padding;

  return (
    <div style={{ overflowX: "auto", flexShrink: 0, marginBottom: -8 }}>
      <svg
        width={totalWidth}
        height={HEIGHT}
        style={{ display: "block" }}
      >
        {/* Main branch line */}
        <line
          x1={0}
          y1={MAIN_Y}
          x2={totalWidth}
          y2={MAIN_Y}
          stroke="var(--text-muted)"
          strokeWidth={2}
        />

        {entries.map((entry) => {
          const color = STATUS_COLORS[entry.status] ?? "var(--text-muted)";
          const mergeX = entry.x + cardWidth / 2;

          return (
            <g key={entry.taskId}>
              {/* Branch-off circle on main line */}
              <circle cx={entry.x} cy={MAIN_Y} r={4} fill={color} />

              {/* Line down from main to branch */}
              <line
                x1={entry.x}
                y1={MAIN_Y}
                x2={entry.x}
                y2={BRANCH_Y}
                stroke={color}
                strokeWidth={1.5}
              />

              {/* Horizontal branch segment */}
              <line
                x1={entry.x}
                y1={BRANCH_Y}
                x2={mergeX}
                y2={BRANCH_Y}
                stroke={color}
                strokeWidth={1.5}
              />

              {/* Merge line back up (for merged branches) */}
              {entry.status === "merged" && (
                <>
                  <line
                    x1={mergeX}
                    y1={BRANCH_Y}
                    x2={mergeX}
                    y2={MAIN_Y}
                    stroke={color}
                    strokeWidth={1.5}
                  />
                  <circle cx={mergeX} cy={MAIN_Y} r={3} fill={color} />
                </>
              )}

              {/* Branch label */}
              <text
                x={entry.x + (mergeX - entry.x) / 2}
                y={BRANCH_Y + 12}
                textAnchor="middle"
                fontSize={9}
                fill={color}
                fontFamily="monospace"
              >
                {entry.branch}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
