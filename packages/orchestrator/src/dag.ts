import type { Task } from "./types.ts";

// ── buildBlockedByMap ─────────────────────────────────────────
// For each task, returns the set of dependency IDs that are not yet terminal.
// Terminal states: "done", "merged", "skipped", "failed".

export function buildBlockedByMap(tasks: Task[]): Map<number, Set<number>> {
  const terminal = new Set(["done", "merged", "skipped", "failed"]);
  const stateMap = new Map(tasks.map((t) => [t.id, t.state]));
  const result = new Map<number, Set<number>>();

  for (const task of tasks) {
    if (terminal.has(task.state)) {
      result.set(task.id, new Set());
      continue;
    }
    const pending = new Set<number>();
    for (const depId of task.dependsOn) {
      const depState = stateMap.get(depId);
      if (depState !== undefined && !terminal.has(depState)) {
        pending.add(depId);
      }
    }
    result.set(task.id, pending);
  }

  return result;
}

// ── getDependents ─────────────────────────────────────────────
// Returns all tasks that have taskId in their dependsOn list (direct dependents only).

export function getDependents(taskId: number, tasks: Task[]): Task[] {
  return tasks.filter((t) => t.dependsOn.includes(taskId));
}

// ── validateDAG ───────────────────────────────────────────────
// Checks for: cycles, references to non-existent task IDs, and self-references.

export function validateDAG(tasks: Task[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const idSet = new Set(tasks.map((t) => t.id));

  // Self-references and missing dep IDs
  for (const task of tasks) {
    for (const depId of task.dependsOn) {
      if (depId === task.id) {
        errors.push(`Task #${task.id} "${task.title}" depends on itself (self-reference).`);
      } else if (!idSet.has(depId)) {
        errors.push(
          `Task #${task.id} "${task.title}" references non-existent task ID ${depId}.`
        );
      }
    }
  }

  // Cycle detection — only consider edges within the known id set
  const inDegree = new Map<number, number>();
  const adjReverse = new Map<number, number[]>();

  for (const task of tasks) {
    inDegree.set(task.id, 0);
    adjReverse.set(task.id, []);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!idSet.has(dep) || dep === task.id) continue; // skip already-reported issues
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
      adjReverse.get(dep)!.push(task.id);
    }
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const visited = new Set<number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited.add(id);
    for (const dependent of adjReverse.get(id)!) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (visited.size < tasks.length) {
    const cycled = tasks
      .filter((t) => !visited.has(t.id))
      .map((t) => `#${t.id} "${t.title}"`)
      .join(", ");
    errors.push(`Cycle detected involving tasks: ${cycled}`);
  }

  return { valid: errors.length === 0, errors };
}
