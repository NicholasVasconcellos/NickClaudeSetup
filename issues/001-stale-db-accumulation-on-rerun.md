# Stale DB Accumulation on Re-run

**Severity:** Medium
**Component:** `packages/orchestrator/src/seed.ts`, `packages/orchestrator/src/demo.ts`

## Problem

Running the seed script or any test harness multiple times against the same SQLite database causes tasks to accumulate rather than being replaced. The `Database.init()` method creates tables if they don't exist but does not clear existing rows.

During testing, seeding 11 tasks twice produced 22 rows in the `tasks` table. Task IDs auto-increment, so the second batch gets IDs 12-22, and their `dependsOn` arrays still reference IDs 1-11 from the first batch. This means:

- `computeLayers()` operates on all 22 tasks, producing a broken DAG where half the dependency references point to tasks from a prior seed run
- `getReadyTasks()` returns stale tasks from previous runs
- The dashboard shows duplicate entries

## Reproduction

```bash
# Run seed twice against the same DB
npx tsx packages/orchestrator/src/seed.ts --db-path .orchestrator/test.db
npx tsx packages/orchestrator/src/seed.ts --db-path .orchestrator/test.db
# DB now has 28 tasks (14 + 14) with cross-run dependency references
```

## Suggested Fix

Either:
1. **Truncate on seed:** Add `DELETE FROM tasks` (and related tables) at the start of `seedDatabase()` when used for testing/demo purposes
2. **Session isolation:** Only load tasks for the current session in `getAllTasks()`, filtering by `session_id`
3. **Idempotent seed:** Check if tasks already exist by title before inserting, skip duplicates

Option 2 is the cleanest since it aligns with the session model already in the schema.
