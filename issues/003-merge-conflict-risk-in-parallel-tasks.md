# Parallel Tasks With High Merge Conflict Probability

**Severity:** Medium
**Component:** `packages/orchestrator/src/runner.ts` — merge queue and conflict resolution

## Observation

The todo app plan exposed three layers where parallel tasks are structurally likely to produce merge conflicts:

| Layer | Parallel Tasks | Likely Shared Files |
|-------|---------------|-------------------|
| 1 | CRUD API + Storage Adapter | Both depend on the same types (`src/types/todo.ts`), both likely import/re-export from `src/index.ts` |
| 2 | TodoList + TodoFilters + TodoStats (3 tasks) | All three components likely get added to `src/App.tsx` imports and JSX tree |
| 4 | Drag-and-Drop + Dark Mode | Both modify `src/App.tsx` layout/styling, both may add CSS variables or global styles |

The orchestrator handles this via sequential merge queue + Opus conflict resolution agent. However, with 3 parallel tasks in layer 2, the merge pattern is:
1. Task 5 merges cleanly to main
2. Task 6 merges — potential conflict if both added to App.tsx
3. Task 7 merges — conflict is now almost certain since main has changed twice

Each successive merge in a fan-out layer has increasing conflict probability because main diverges further from each task's branch point.

## Current Handling

The conflict resolution flow (`_attemptConflictResolution` in `runner.ts`) spawns an Opus agent with full conflict context. If it fails after 3 retries, the task is marked failed and dependents are blocked.

## Suggestions

1. **Pre-merge rebase:** Before merging task N in a layer, rebase its branch onto current main. This reduces conflict surface since the agent would resolve during rebase rather than hitting accumulated drift at merge time.
2. **Merge ordering heuristic:** Within a layer, merge tasks that touch fewer shared files first, so the "easiest" merges happen before main diverges significantly.
3. **Shared file detection:** During task decomposition (get-tasks skill), flag when multiple parallel tasks are likely to modify the same files and either serialize them or add explicit coordination notes to the task descriptions.
