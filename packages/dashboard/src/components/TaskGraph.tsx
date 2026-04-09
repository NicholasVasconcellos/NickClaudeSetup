"use client";

import React, { useMemo } from "react";
import TaskCard, { STATE_COLORS } from "./TaskCard";

interface TaskData {
  state: string;
  title?: string;
  phase?: string;
  cost?: number;
  contextPercentage?: number;
}

interface TaskGraphProps {
  tasks: Map<number, TaskData>;
  layers: { active: number; completed: number[] };
  selectedTaskId?: number;
  onSelectTask?: (id: number) => void;
}

const CARD_WIDTH = 200;
const CARD_HEIGHT = 80;
const LAYER_GAP = 60;
const CARD_GAP = 16;
const PADDING = 24;

export default function TaskGraph({
  tasks,
  layers,
  selectedTaskId,
  onSelectTask,
}: TaskGraphProps) {
  // Group tasks by their presumed layer based on order
  // In production this would come from the DAG, but for now we infer from task IDs
  const taskLayers = useMemo(() => {
    const allIds = Array.from(tasks.keys()).sort((a, b) => a - b);
    if (allIds.length === 0) return [];

    // If we know the active layer, we can at least separate completed layers
    const completedSet = new Set(layers.completed);
    const layerMap = new Map<number, number[]>();

    // Simple heuristic: distribute tasks across layers
    // Tasks with done/merged state go to earlier layers
    const doneIds: number[] = [];
    const activeIds: number[] = [];
    const pendingIds: number[] = [];

    for (const id of allIds) {
      const task = tasks.get(id);
      if (!task) continue;
      if (task.state === "done" || task.state === "merged") {
        doneIds.push(id);
      } else if (task.state === "pending" || task.state === "skipped") {
        pendingIds.push(id);
      } else {
        activeIds.push(id);
      }
    }

    const result: number[][] = [];
    if (doneIds.length > 0) result.push(doneIds);
    if (activeIds.length > 0) result.push(activeIds);
    if (pendingIds.length > 0) result.push(pendingIds);

    // If no categorization worked, just put everything in one layer
    if (result.length === 0 && allIds.length > 0) {
      result.push(allIds);
    }

    return result;
  }, [tasks, layers]);

  const totalWidth =
    taskLayers.length * (CARD_WIDTH + LAYER_GAP) - LAYER_GAP + PADDING * 2;
  const maxPerLayer = Math.max(1, ...taskLayers.map((l) => l.length));
  const totalHeight =
    maxPerLayer * (CARD_HEIGHT + CARD_GAP) - CARD_GAP + PADDING * 2;

  if (tasks.size === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "var(--text-muted)",
          fontSize: 14,
        }}
      >
        Waiting for tasks...
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        overflowX: "auto",
        overflowY: "auto",
        flex: 1,
        backgroundColor: "var(--bg-primary)",
        borderRadius: 8,
        border: "1px solid var(--border)",
      }}
    >
      {/* SVG overlay for dependency lines */}
      <svg
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: totalWidth,
          height: totalHeight,
          pointerEvents: "none",
        }}
      >
        {taskLayers.map((layerIds, layerIdx) => {
          if (layerIdx === 0) return null;
          const prevLayer = taskLayers[layerIdx - 1];
          return layerIds.map((taskId, taskIdx) => {
            const toX = PADDING + layerIdx * (CARD_WIDTH + LAYER_GAP);
            const toY =
              PADDING + taskIdx * (CARD_HEIGHT + CARD_GAP) + CARD_HEIGHT / 2;

            return prevLayer.map((prevId, prevIdx) => {
              const fromX =
                PADDING +
                (layerIdx - 1) * (CARD_WIDTH + LAYER_GAP) +
                CARD_WIDTH;
              const fromY =
                PADDING +
                prevIdx * (CARD_HEIGHT + CARD_GAP) +
                CARD_HEIGHT / 2;

              const midX = (fromX + toX) / 2;

              return (
                <path
                  key={`${prevId}-${taskId}`}
                  d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth={1.5}
                  opacity={0.5}
                />
              );
            });
          });
        })}
      </svg>

      {/* Task cards */}
      <div style={{ position: "relative", width: totalWidth, height: totalHeight }}>
        {taskLayers.map((layerIds, layerIdx) =>
          layerIds.map((taskId, taskIdx) => {
            const task = tasks.get(taskId);
            if (!task) return null;

            const x = PADDING + layerIdx * (CARD_WIDTH + LAYER_GAP);
            const y = PADDING + taskIdx * (CARD_HEIGHT + CARD_GAP);
            const isSelected = selectedTaskId === taskId;

            return (
              <div
                key={taskId}
                style={{
                  position: "absolute",
                  left: x,
                  top: y,
                  width: CARD_WIDTH,
                  outline: isSelected
                    ? `2px solid var(--accent)`
                    : "none",
                  outlineOffset: 2,
                  borderRadius: 6,
                }}
              >
                <TaskCard
                  id={taskId}
                  title={task.title ?? `Task ${taskId}`}
                  state={task.state}
                  phase={task.phase}
                  cost={task.cost}
                  contextPercentage={task.contextPercentage}
                  onClick={() => onSelectTask?.(taskId)}
                />
              </div>
            );
          })
        )}
      </div>

      {/* Layer labels */}
      <div style={{ position: "absolute", bottom: 4, left: 0, right: 0, display: "flex" }}>
        {taskLayers.map((_, layerIdx) => {
          const x = PADDING + layerIdx * (CARD_WIDTH + LAYER_GAP) + CARD_WIDTH / 2;
          const isActive = layerIdx === layers.active;
          const isCompleted = layers.completed.includes(layerIdx);

          return (
            <div
              key={layerIdx}
              style={{
                position: "absolute",
                left: x,
                transform: "translateX(-50%)",
                fontSize: 10,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: isActive
                  ? "var(--accent)"
                  : isCompleted
                    ? "var(--success)"
                    : "var(--text-muted)",
              }}
            >
              Layer {layerIdx}
            </div>
          );
        })}
      </div>
    </div>
  );
}
