# Orchestrator Logic — Full Walkthrough

A step-by-step trace of every function call from a sample `plan.md` through task completion.

---

## 0. Sample plan.md

```markdown
# Project: My App

## Requirements
### Auth API
- JWT login/register
  Acceptance criteria:
  - POST /auth/login returns token
  - POST /auth/register creates user

### Profile Page (depends on Auth API)
- User profile CRUD
  Acceptance criteria:
  - GET /profile returns user data
  - PUT /profile updates user data
```

---

## 1. Plan to Tasks (external `get-tasks` skill)

- The `get-tasks` skill reads `plan.md`
- Decomposes into structured tasks with title, description, dependencies, milestone
- Calls `Database.createTask()` for each:
  - Task 1: "Auth API" — `dependsOn: []`
  - Task 2: "Profile Page" — `dependsOn: [1]`

---

## 2. Entry Point — `index.ts`

- `parseArgs(argv)` — reads CLI flags (`--project-dir`, `--concurrency`, `--db-path`, etc.)
- `printBanner(config)` — displays startup info
- Creates `new Runner(config)`
  - `Runner` constructor instantiates:
    - `new Database(config.dbPath)`
    - `new GitManager(config)`
    - `new ClaudeRunner(config)`
    - `new StateMachine(db)`
    - `new EventBus(config.wsPort)`
    - `new LearningPipeline(db, claude, config)`
- Calls `runner.init()`
  - `Database.init()` — creates SQLite tables (tasks, task_logs, agent_runs, learnings, merge_events, sessions)
  - `GitManager.cleanupOrphanedWorktrees()` — removes leftover `.orchestrator/worktrees/` dirs
  - `EventBus.start()` — starts WebSocket server on port 3100
  - `EventBus.onCommand(handler)` — registers dashboard command handler
  - `ClaudeRunner.checkAvailable()` — runs `claude --version` to verify CLI exists
- Calls `runner.run()`
- Registers SIGINT/SIGTERM handlers → `runner.shutdown()`

---

## 3. DAG Computation — `dag.ts`

- `computeLayers(allTasks)` — Kahn's algorithm
  - Builds in-degree map from `dependsOn` arrays
  - **Layer 0**: tasks with 0 in-degree → `[Task 1: Auth API]`
  - **Layer 1**: tasks whose deps are all in prior layers → `[Task 2: Profile Page]`
- `validateDAG(tasks)` — checks for cycles, self-refs, missing dependency IDs

Other utilities:
- `topologicalSort(tasks)` — returns task IDs in topological order
- `getReadyTasks(tasks)` — filter tasks that are pending + all deps done/merged
- `getDependents(taskId, tasks)` — find direct dependents

---

## 4. Layer-by-Layer Execution — `runner.run()`

- `Database.createSession()` — new session record
- `setTimeout(overallTimeout)` — starts abort timer (default 2h)
- `computeLayers(allTasks)` — get DAG layers
- For each layer:
  - Skip layers where all tasks are already terminal (merged/skipped/failed)
  - `EventBus.layerStarted(layerIndex, taskIds)` — broadcast to dashboard
  - `withConcurrency(tasks, maxConcurrency)` — run up to 4 tasks in parallel
    - For each task in the layer → `executeTask(task)`
  - `EventBus.layerCompleted(layerIndex)`

---

## 5. `executeTask(task)` — The Core Loop

Each task goes through **3 sequential phases + merge**:

### 5a. Git Worktree Setup

- `GitManager.createWorktree(taskId)`
  - Runs: `git worktree add -b task/{id} .orchestrator/worktrees/task-{id} {mainBranch}`
  - Returns `{ worktreePath, branch }`
- `Database.updateTaskWorktree(id, path, branch)`

### 5b. SPEC Phase

- `StateMachine.transition(taskId, "spec")` — validates `pending → spec`
  - `Database.updateTaskState(id, "spec", "spec")`
  - Returns old state for event emission
- `EventBus.taskStateChanged(taskId, "pending", "spec")`
- `EventBus.agentStarted(taskId, "spec", model)`
- `Database.startAgentRun(taskId, "spec", model)` — records run start
- `buildPrompt(task, "spec")` — generates prompt:
  > "Write tests based on acceptance criteria. Do not implement yet. Tests should be runnable and initially failing."
  - Includes completed dependency context via `Database.getCompletedTaskContext(task.dependsOn)`
- `ClaudeRunner.runTask({ prompt, cwd: worktreePath, model })`
  - Spawns: `claude -p <prompt> --model <model> --output-format json --verbose`
  - Streams stdout line-by-line:
    - Each line → `Database.appendLog(taskId, "spec", line)`
    - Each line → `EventBus.taskLogAppend(taskId, line)`
  - Manages timeout via internal `AbortController` + `setTimeout`
  - Listens to external `AbortSignal` for global shutdown
  - On completion → `parseCostFromOutput(stdout)` extracts tokens + USD
    - Tries JSON parsing line-by-line, falls back to regex
- `Database.finishAgentRun(runId, tokensIn, tokensOut, cost, duration)`
- `EventBus.agentFinished(taskId, "spec", tokens, cost)`
- If `exitCode !== 0` → throws error (caught by outer catch block)

### 5c. EXECUTE Phase

- `StateMachine.transition(taskId, "executing")` — validates `spec → executing`
- `EventBus.taskStateChanged(taskId, "spec", "executing")`
- Re-fetches task from DB for fresh state
- `buildPrompt(task, "execute")`:
  > "Implement the code to pass these tests. Use subagents for parallel work. Do not modify test files unless they contain bugs."
- Same `ClaudeRunner.runTask()` + logging + cost tracking flow as spec

### 5d. REVIEW Phase

- `StateMachine.transition(taskId, "reviewing")` — validates `executing → reviewing`
- `EventBus.taskStateChanged(taskId, "executing", "reviewing")`
- `buildPrompt(task, "review")`:
  > "Review and clean up. Run all tests. Fix issues. Ensure TypeScript types are sound, linting passes. Do not add new features."
- Same `ClaudeRunner.runTask()` + logging + cost tracking flow

### 5e. Transition to Done

- `StateMachine.transition(taskId, "done")` — validates `reviewing → done`
- `EventBus.taskStateChanged(taskId, "reviewing", "done")`

### 5f. MERGE Phase — `enqueueMerge(taskId)`

- Chains onto `mergeQueue` (Promise chain) — ensures only one merge runs at a time
- Calls `_doMerge(taskId)`:

**Happy path:**
- `GitManager.mergeTask(taskId)`
  - `git checkout {mainBranch}`
  - `git merge --no-ff -m "Merge task {id}" task/{id}`
  - Returns `{ success: true, conflicts: [] }`
- `Database.recordMerge(taskId, "success", false)`
- `GitManager.push()` (unless `--no-push`)
- `StateMachine.transition(taskId, "merged")`
- `EventBus.taskStateChanged(taskId, "done", "merged")`

**Conflict path — agent-assisted resolution:**
- `GitManager.mergeTask(taskId)` returns `{ success: false, conflicts: ["file1.ts", ...] }`
  - Working tree now contains conflict markers (merge NOT aborted yet)
- `Database.recordMerge(taskId, "conflict", false)`
- `_attemptConflictResolution(taskId, conflicts)`:
  - `EventBus.agentStarted(taskId, "merge", model)` — model is `claude-opus-4-6`
  - `Database.startAgentRun(taskId, "merge", model)`
  - `GitManager.getConflictContext(taskId)` — gathers:
    - Merge base commit hash (`git merge-base main task/{id}`)
    - Commits on task branch since divergence (`git log main..task/{id} --oneline`)
    - Commits on main since divergence (`git log task/{id}..main --oneline`)
    - Full conflict diff with markers (`git diff`)
    - List of conflicted files (`git diff --name-only --diff-filter=U`)
  - Builds merge resolution prompt with full context + instructions:
    - Read each conflicted file and understand both sides
    - Remove all `<<<<<<<` / `=======` / `>>>>>>>` markers
    - Preserve intent of both branches
    - Run tests to verify
    - Do NOT commit (orchestrator handles it)
  - `ClaudeRunner.runTask({ prompt, cwd: projectDir, model: "claude-opus-4-6" })`
    - Agent runs in the project directory where conflict markers live
    - Output streamed to logs + EventBus as `"merge"` phase
  - `Database.finishAgentRun(...)` + `EventBus.agentFinished(...)`
  - If agent exit code is 0:
    - `GitManager.stageAndCommitMerge(taskId)` — `git add -A` + `git commit --no-edit`
    - Returns `true` if commit succeeds, `false` if unresolved markers remain
  - If agent fails or commit fails → returns `false`

- **If resolved (`true`):**
  - `Database.recordMerge(taskId, "success", true)` — `conflictResolved: true`
  - `GitManager.push()` (unless `--no-push`)
  - `StateMachine.transition(taskId, "merged")`
  - `EventBus.taskStateChanged(taskId, "done", "merged")`

- **If not resolved (`false`):**
  - `GitManager.abortMerge()` — `git merge --abort`
  - `LearningPipeline.capture(taskId, "merge", conflictDetails)`
  - `StateMachine.fail(taskId)` — retry or terminal failure (see section 6)
  - `EventBus.taskStateChanged(taskId, "done", newState)`

### 5g. Cleanup

- `GitManager.removeWorktree(taskId)` — `git worktree remove --force` + `git branch -D task/{id}`
- `Database.updateTaskWorktree(id, null, null)`
- On failure paths where merge was never reached, worktree cleanup happens in the `finally` block

---

## 6. Error Handling and Retries — `state-machine.ts`

If any phase fails (non-zero exit code, timeout, or merge conflict resolution failure):

- `LearningPipeline.capture(taskId, phase, errorMsg)` — stores raw error note
- `StateMachine.fail(taskId)`:
  - `Database.getTask(taskId)` — reads current state
  - If `retryCount < maxRetries` (default 3):
    - `Database.incrementRetry(taskId)` — bumps count
    - `getStateForPhase(task.phase)` — maps current phase to rewind state:
      - `"spec"` → `"spec"` state
      - `"execute"` → `"executing"` state
      - `"review"` → `"reviewing"` state
      - `null` → `"pending"` state
    - `Database.updateTaskState(taskId, rewindState, rewindPhase)` — rewinds
  - Else:
    - `transition(taskId, "failed")` — terminal state
    - Dependent tasks become un-schedulable (effectively skipped)

**Note:** The automatic rewind sets DB state but does not re-execute. Actual re-execution is triggered by:
- The dashboard's `task:retry` command → resets to `"pending"` + calls `executeTask()` again
- A future orchestrator run that picks up non-terminal tasks

### State Transition Map

```
TRANSITIONS = {
  pending:   → spec, failed, paused, skipped
  spec:      → executing, failed, paused, skipped
  executing: → reviewing, failed, paused, skipped
  reviewing: → done, failed, paused, skipped
  done:      → merged, failed, skipped
  merged:    → (terminal)
  failed:    → (terminal)
  skipped:   → (terminal)
  paused:    → executing, failed, skipped
}
```

### Happy path:
```
pending → spec → executing → reviewing → done → merged
```

### Failure with retry:
```
pending → spec → executing [FAIL]
  → rewind to "executing" (retryCount++)
  → dashboard retry → pending → spec → executing → reviewing → done → merged
```

### Merge conflict with resolution:
```
pending → spec → executing → reviewing → done
  → merge conflict detected
  → Opus agent resolves conflicts in-place
  → git add -A && git commit --no-edit
  → merged
```

### Merge conflict, resolution fails:
```
pending → spec → executing → reviewing → done
  → merge conflict detected
  → Opus agent fails to resolve
  → git merge --abort
  → stateMachine.fail() → rewind to "reviewing" (retryCount++)
  → dashboard retry → re-review → re-merge attempt
```

---

## 7. Post-Run: Learning Pipeline — `learning.ts`

After all layers complete (or on shutdown via `runner.shutdown()`):

- `LearningPipeline.runPipeline(skillsDir)`:
  1. **Capture** — raw error notes already stored during execution via `capture()` / `captureFromError()`
  2. **Translate** — `_translateBatch(unprocessed)`:
     - Sends raw notes to Claude (haiku model)
     - Gets back actionable rules + skill targets (get-tasks/spec/execute/review/general)
     - `Database.updateLearning(id, actionableStep, false, skillTarget)`
  3. **Validate** — `_validateBatch(translated)`:
     - Claude filters noise, marks keep/discard
     - Discarded learnings tagged with `"__discarded"` skill
     - `Database.updateLearning(id, ..., true, ...)`
  4. **Apply** — `applyToSkills(skillsDir)`:
     - Groups validated learnings by `skillTarget`
     - Appends to `{skillTarget}.md` under `## Learnings` section
     - Creates section if missing
  - Returns `{ translated, validated, applied }`

---

## 8. Post-Run: Summary — `runner._buildSummary()`

- Aggregates from `Database.getAgentRuns()` and `Database.getAllTasks()`:
  - `totalTasks`, `completed` (merged + done), `failed`, `skipped`
  - `totalCost`, `totalTokensIn`, `totalTokensOut`
  - `duration`, `learnings` count
- `Database.finishSession(sessionId, null, totalCost)`
- `EventBus.runCompleted(summary)` — broadcast to dashboard

---

## 9. Real-Time Dashboard — `ws-server.ts`

Throughout execution, the EventBus broadcasts events over WebSocket:

| Event | When |
|---|---|
| `task:state_change` | Every state transition |
| `task:log_append` | Every line of Claude output |
| `task:agent_started` | Phase begins (spec/execute/review/merge) |
| `task:agent_finished` | Phase ends, with cost data |
| `layer:started` | Layer begins processing |
| `layer:completed` | All tasks in layer finished |
| `run:completed` | Final summary |

The dashboard can send commands back:

| Command | Effect |
|---|---|
| `task:pause` | `StateMachine.pause()` → paused state |
| `task:resume` | `StateMachine.resume()` → back to executing |
| `task:retry` | Reset to pending + `executeTask()` in background |
| `task:skip` | `StateMachine.skip()` → skipped (terminal) |
| `run:pause_all` | Sets `runner.paused = true` |
| `run:resume_all` | Sets `runner.paused = false` |

---

## 10. Models by Phase

| Phase | Default Model | Purpose |
|---|---|---|
| `spec` | `claude-sonnet-4-6` | Write failing tests from acceptance criteria |
| `execute` | `claude-sonnet-4-6` | Implement code to pass the tests |
| `review` | `claude-sonnet-4-6` | Clean up, lint, type-check, verify all tests pass |
| `merge` | `claude-opus-4-6` | Resolve merge conflicts with full branch context |
| `learning` | `claude-haiku-4-5` | Translate/validate learnings (cheap batch work) |

---

## 11. Concurrency and Queuing

- **Layer parallelism**: Tasks within a layer run in parallel up to `maxConcurrency` (default 4)
  - Implemented via `withConcurrency(tasks, max)` — tracks an `executing` Set, awaits `Promise.race` when full
- **Sequential merging**: All merges happen one-at-a-time via `mergeQueue` (Promise chain)
  - Prevents race conditions on the main branch
- **Timeout handling**:
  - Per-task: `taskTimeout` (default 10 min) — managed by `ClaudeRunner` via `setTimeout` + `SIGTERM`
  - Overall: `overallTimeout` (default 2h) — managed by `Runner` via `setTimeout` + `AbortController.abort()`
  - External abort signal propagated to all running `ClaudeRunner.runTask()` calls

---

## 12. Database Schema

All tables use SQLite with WAL journaling.

| Table | Purpose |
|---|---|
| `tasks` | Task metadata, state, phase, worktree path, retry count |
| `task_logs` | Per-phase output lines |
| `agent_runs` | Agent invocation records (tokens, cost, duration, model) |
| `learnings` | Captured learnings (raw → translated → validated) |
| `merge_events` | Merge success/conflict/failed records with `conflict_resolved` flag |
| `sessions` | Run sessions (start, finish, total cost) |

---

## 13. File Reference

| File | Purpose |
|---|---|
| `src/index.ts` | CLI entry, arg parsing, banner, `main()` wrapper |
| `src/runner.ts` | Core orchestration: init, run layers, executeTask, merging, conflict resolution, prompts |
| `src/types.ts` | All type defs: Task, State, Phase, Config, Events, etc. |
| `src/state-machine.ts` | State transition logic + retry handling |
| `src/dag.ts` | DAG computation (Kahn's algorithm), validation, topological sort |
| `src/db.ts` | SQLite ORM: tasks, logs, runs, learnings, merge events, sessions |
| `src/claude.ts` | Claude CLI spawning, output streaming, cost/token parsing |
| `src/git.ts` | Git worktree lifecycle: create, remove, merge, conflict context, push |
| `src/ws-server.ts` | WebSocket event bus for dashboard real-time updates |
| `src/learning.ts` | Learning pipeline: capture → translate → validate → apply to skills |
| `src/seed.ts` | Demo data: 14 full-stack tasks with realistic dependencies |
| `src/demo.ts` | Simulation mode with edge case scenarios |
