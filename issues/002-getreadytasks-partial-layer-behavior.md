# getReadyTasks Returns Tasks From Incomplete Layers

**Severity:** Low (correct behavior, but potentially surprising)
**Component:** `packages/orchestrator/src/dag.ts` — `getReadyTasks()`

## Observation

`getReadyTasks()` correctly returns any pending task whose dependencies are all done/merged. However, this means tasks within the same conceptual "layer" don't wait for their layer peers.

Example with the todo app plan:
- Layer 0 has two independent roots: "Init project" (task 1) and "Data model" (task 2)
- If only task 1 finishes, `getReadyTasks()` still returns task 2 as ready (it has no deps)
- The diamond dependents in layer 1 (which need BOTH roots) correctly remain blocked

This is **correct behavior** — the layer-by-layer execution in `runner.ts` already handles this by processing all tasks in a layer before moving on. But `getReadyTasks()` alone doesn't enforce layer boundaries, which could cause issues if it were used outside the layer loop (e.g., a future "eager scheduling" mode).

## Context

This was discovered when writing a test that expected 0 ready tasks after completing only 1 of 2 roots. The actual answer is 1 (the other root itself), which is correct — a root task with no dependencies is always ready regardless of what else is happening.

## Recommendation

No code change needed. But if an eager/dynamic scheduler is ever built on top of `getReadyTasks()`, it should be aware that layer boundaries are not enforced at this level — they're an orchestration concern in `runner.ts`, not a DAG concern.
