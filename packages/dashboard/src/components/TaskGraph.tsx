"use client";

import React, { useMemo, useRef, useEffect } from "react";
import TaskCard, { STATE_COLORS } from "./TaskCard";

interface TaskData {
  state: string;
  title?: string;
  description?: string;
  milestone?: string | null;
  dependsOn?: number[];
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

const HIDDEN_STATES = new Set(["pending", "skipped"]);

export default function TaskGraph({
  tasks,
  layers,
  selectedTaskId,
  onSelectTask,
}: TaskGraphProps) {
  // Persistent position cache: once assigned, never moves
  const positionCache = useRef<Map<number, { layerIdx: number; slotIdx: number }>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLayerCount = useRef(0);

  // Compute DAG layout via topological layer assignment using dependsOn
  const { taskLayers, positionMap } = useMemo(() => {
    const visibleIds: number[] = [];
    for (const [id, task] of tasks) {
      if (!HIDDEN_STATES.has(task.state)) {
        visibleIds.push(id);
      }
    }

    if (visibleIds.length === 0) {
      return { taskLayers: [] as number[][], positionMap: new Map<number, { layerIdx: number; slotIdx: number }>() };
    }

    const visibleSet = new Set(visibleIds);

    // Compute layer for each visible task: layer = max(layer of visible deps) + 1
    // Tasks with no (visible) dependencies go to layer 0
    const layerOf = new Map<number, number>();

    function computeLayer(id: number): number {
      if (layerOf.has(id)) return layerOf.get(id)!;
      // Mark with -1 to detect cycles
      layerOf.set(id, -1);
      const task = tasks.get(id);
      let maxDep = -1;
      if (task?.dependsOn) {
        for (const depId of task.dependsOn) {
          if (visibleSet.has(depId)) {
            const depLayer = computeLayer(depId);
            if (depLayer > maxDep) maxDep = depLayer;
          }
        }
      }
      const layer = maxDep + 1;
      layerOf.set(id, layer);
      return layer;
    }

    for (const id of visibleIds) {
      computeLayer(id);
    }

    // Group by layer
    const layerGroups = new Map<number, number[]>();
    for (const id of visibleIds) {
      const l = layerOf.get(id)!;
      if (!layerGroups.has(l)) layerGroups.set(l, []);
      layerGroups.get(l)!.push(id);
    }

    // Sort layer indices and build ordered array
    const sortedLayerIndices = Array.from(layerGroups.keys()).sort((a, b) => a - b);
    const result: number[][] = sortedLayerIndices.map((li) => {
      const ids = layerGroups.get(li)!;
      // Sort tasks within a layer by ID for stability
      ids.sort((a, b) => a - b);
      return ids;
    });

    // Assign positions: use cache for already-placed tasks, assign new slots for new tasks
    const cache = positionCache.current;
    const newPositionMap = new Map<number, { layerIdx: number; slotIdx: number }>();

    for (let layerIdx = 0; layerIdx < result.length; layerIdx++) {
      const layerIds = result[layerIdx];
      // Collect already-cached tasks at this layer index
      const cachedInLayer: { id: number; slotIdx: number }[] = [];
      const uncached: number[] = [];

      for (const id of layerIds) {
        const cached = cache.get(id);
        if (cached && cached.layerIdx === layerIdx) {
          cachedInLayer.push({ id, slotIdx: cached.slotIdx });
        } else if (cached) {
          // Task moved layers — treat as new placement at this layer
          uncached.push(id);
        } else {
          uncached.push(id);
        }
      }

      // Determine occupied slots
      const occupiedSlots = new Set(cachedInLayer.map((c) => c.slotIdx));

      // Place cached tasks
      for (const c of cachedInLayer) {
        newPositionMap.set(c.id, { layerIdx, slotIdx: c.slotIdx });
      }

      // Place uncached tasks in first available slots
      let nextSlot = 0;
      for (const id of uncached) {
        while (occupiedSlots.has(nextSlot)) nextSlot++;
        const pos = { layerIdx, slotIdx: nextSlot };
        newPositionMap.set(id, pos);
        cache.set(id, pos);
        occupiedSlots.add(nextSlot);
        nextSlot++;
      }
    }

    return { taskLayers: result, positionMap: newPositionMap };
  }, [tasks]);

  // Auto-scroll right when new layers appear
  const layerCount = taskLayers.length;
  useEffect(() => {
    if (layerCount > prevLayerCount.current && containerRef.current) {
      const el = containerRef.current;
      el.scrollLeft = el.scrollWidth - el.clientWidth;
    }
    prevLayerCount.current = layerCount;
  }, [layerCount]);

  // Compute max slot per layer for height calculation
  const maxSlot = useMemo(() => {
    let max = 0;
    for (const pos of positionMap.values()) {
      if (pos.slotIdx > max) max = pos.slotIdx;
    }
    return max;
  }, [positionMap]);

  const totalWidth =
    taskLayers.length * (CARD_WIDTH + LAYER_GAP) - LAYER_GAP + PADDING * 2;
  const totalHeight =
    (maxSlot + 1) * (CARD_HEIGHT + CARD_GAP) - CARD_GAP + PADDING * 2;

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

  // Build a lookup from task id -> pixel position for dependency lines
  const taskPositions = new Map<number, { x: number; y: number }>();
  for (const [id, pos] of positionMap) {
    taskPositions.set(id, {
      x: PADDING + pos.layerIdx * (CARD_WIDTH + LAYER_GAP),
      y: PADDING + pos.slotIdx * (CARD_HEIGHT + CARD_GAP),
    });
  }

  // Collect dependency edges
  const edges: { fromId: number; toId: number }[] = [];
  for (const [id, task] of tasks) {
    if (HIDDEN_STATES.has(task.state)) continue;
    if (task.dependsOn) {
      for (const depId of task.dependsOn) {
        if (taskPositions.has(depId)) {
          edges.push({ fromId: depId, toId: id });
        }
      }
    }
  }

  return (
    <div
      ref={containerRef}
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
        {edges.map(({ fromId, toId }) => {
          const from = taskPositions.get(fromId);
          const to = taskPositions.get(toId);
          if (!from || !to) return null;

          const fromX = from.x + CARD_WIDTH;
          const fromY = from.y + CARD_HEIGHT / 2;
          const toX = to.x;
          const toY = to.y + CARD_HEIGHT / 2;
          const midX = (fromX + toX) / 2;

          return (
            <path
              key={`${fromId}-${toId}`}
              d={`M ${fromX} ${fromY} C ${midX} ${fromY}, ${midX} ${toY}, ${toX} ${toY}`}
              fill="none"
              stroke="var(--border)"
              strokeWidth={1.5}
              opacity={0.5}
            />
          );
        })}
      </svg>

      {/* Task cards */}
      <div style={{ position: "relative", width: totalWidth, height: totalHeight }}>
        {Array.from(positionMap.entries()).map(([taskId, pos]) => {
          const task = tasks.get(taskId);
          if (!task) return null;

          const x = PADDING + pos.layerIdx * (CARD_WIDTH + LAYER_GAP);
          const y = PADDING + pos.slotIdx * (CARD_HEIGHT + CARD_GAP);
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
                description={task.description}
                milestone={task.milestone}
                dependsOn={task.dependsOn}
                state={task.state}
                phase={task.phase}
                cost={task.cost}
                contextPercentage={task.contextPercentage}
                onClick={() => onSelectTask?.(taskId)}
              />
            </div>
          );
        })}
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
