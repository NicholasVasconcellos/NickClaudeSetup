# Agent Notes

Non-obvious rationale and gotchas that don't belong inline. Keep terse. Add
entries under the file they're about. Delete entries when the rationale is
no longer load-bearing.

## packages/orchestrator/src/claude.ts

**`RunTaskOptions.resumeSessionId`** — when set, CLI spawns with
`--resume <id>`. The `prompt` arrives as a new user turn in the existing
session, so callers should send a short continuation (not the full original
prompt — that re-inflates tokens and fights the cached context).

**`killedByUs` / `timedOut` flags** — `exitCode: -1` is our own convention
for "we sent SIGTERM." `timedOut` disambiguates the `setTimeout` case from
external-signal aborts so callers can surface `plan_parse_timeout`.

## packages/orchestrator/src/project.ts

**`agentParsePlan` prompt branches** — fresh runs inline the full
`get-tasks` skill body; resume runs send a short nudge only. The skill +
plan are already in the session's cached context after the first run.

**`parseSessionIdFromLine`** — `session_id` is emitted in the very first
`{type:"system", subtype:"init"}` stream-json event. Captured and persisted
in `parse-plan-meta.json.sessionId` for the "Resume parse" UI button.

**`writeMeta` is best-effort** — disk failures are swallowed; live stream
and DB state are still valid. We never fail a parse on meta-write errors.

**CLI `load-tasks` writes a synthetic meta** — `model: "manual-load"`,
zeroed usage, `errorKind: null`, so the dashboard's `parseStatus` badge
shows "Ready" after CLI ingestion. `sessionId: null` since no agent ran.

## packages/orchestrator/src/runner.ts

**`project:load_tasks` and `project:resume_parse` handlers** open the
target project's DB locally — they must NOT re-point `this.db` or
`this.config.projectDir` (those belong to the active runner's working
project and would corrupt the currently-running execution state).

**Single-flight guard `this.creatingProject`** — reused for both load +
resume so the user can't fire a second creation while one is in flight.

## packages/dashboard/src/components/ProjectSetup.tsx

**"Resume parse" vs "Retry parse" buttons** — both can render at once.
Resume is preferred (cheaper, preserves context) but retry is the safe
fallback when `sessionId` is null (pre-fix runs) or the resumed session
was purged by claude CLI history limits.

**"Load tasks from tasks.json" button** — only visible when the project
has 0 DB tasks AND `tasks/tasks.json` exists. Used to recover projects
whose parse agent wrote the file but never reached the DB-insert step
(e.g. killed mid-parse, DB corruption).
