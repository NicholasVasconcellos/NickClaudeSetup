# No Automated Test Suite for Core DAG Module

**Severity:** Medium
**Component:** `packages/orchestrator/src/dag.ts`

## Problem

The orchestrator has no automated tests (`packages/orchestrator/src/**/*.test.*` returned zero files). The DAG module (`dag.ts`) is a critical path component — cycle detection, layer computation, topological sort, and ready-task filtering all drive the execution order of the entire system.

During this testing session, a standalone `test-dag.ts` was written to validate 45 assertions across 11 edge case categories. All passed (after fixing test bugs), confirming the DAG logic is sound. But these tests don't run in CI and aren't part of the project.

## What Was Tested

| Category | Assertions | Status |
|----------|-----------|--------|
| DAG validation (valid graph) | 2 | Pass |
| Layer computation (6 layers) | 8 | Pass |
| Topological sort ordering | 7 | Pass |
| Ready tasks with partial completion | 5 | Pass |
| Dependents detection (fan-out, diamond, leaf) | 3 | Pass |
| Cycle detection (3-node cycle) | 3 | Pass |
| Self-reference detection | 2 | Pass |
| Empty task list | 4 | Pass |
| Missing dependency ID | 2 | Pass |
| Merge conflict structural analysis | 3 | Pass |
| Database persistence + serialization | 3 | Pass |

## Recommendation

Add Vitest to the orchestrator package and port the test assertions into proper test files:
- `dag.test.ts` — layer computation, topo sort, cycle/self-ref/missing dep detection, empty list
- `db.test.ts` — task CRUD, dependency serialization, stale data handling
- `state-machine.test.ts` — transition validation, retry logic, terminal states

The `packages/orchestrator/package.json` already has `vitest`-compatible tooling (`tsx`, TypeScript). Adding `vitest` as a dev dependency and a `test` script would be minimal effort.
