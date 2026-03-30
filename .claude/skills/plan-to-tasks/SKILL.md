---
name: plan-to-tasks
description: >
  Converts a comprehensive plan.md into an executable workspace for Claude Code agents.
  Generates sequential task files, a dependency manifest, test directory, project context
  file, progress log, and the runner script. Use this skill whenever the user wants to
  break a plan into tasks, set up a workspace from a project plan, go from plan to
  execution, prepare a repo for multi-agent work, or mentions "plan to tasks", "break
  down the plan", "set up tasks from the plan", "create tasks from plan.md", or similar.
  Also trigger when the user has a plan.md and asks to "get started", "set up the
  project", or "prepare for execution".
disable-model-invocation: true
---

# planToTasks

Convert a `plan.md` into a ready-to-execute workspace: task files, dependency manifest, test scaffolding, project context, progress log, and runner script.

## Input

A `plan.md` file in the repo root (or a path specified by the user). This file should be comprehensive — covering architecture, milestones, requirements, tech stack, folder structure, dependencies, and deliverables.

Read the entire plan.md before doing anything else. You need full context to make good task-splitting decisions.

## What you produce

| File/Dir              | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `PROJECT.md`          | Project context for agents — tech stack, structure, conventions, goals |
| `.gitignore`          | Prevents agents from committing junk (.DS_Store, node_modules, etc.)   |
| `tasks/`              | Sequential task files: `001.md`, `002.md`, ...                         |
| `tasks/manifest.json` | Dependency graph — the runner script reads this                        |
| `tasks/status/`       | Empty dir — filesystem-based task locking/completion state             |
| `tests/`              | Empty dir with `run_all.sh` — agents write test scripts here           |
| `progress.txt`        | Append-only free-text log for agent handoffs                           |
| `run-tasks.sh`        | The agent loop runner script                                           |

**Do NOT create:** `CLAUDE.md`, `.claudeignore`, or anything project-specific in the skill itself. All project specifics come from `plan.md` and go into the generated files.

## Step 0: Backup existing files

Before writing anything, check if any of these already exist: `PROJECT.md`, `.gitignore`, `tasks/`, `tests/`, `progress.txt`, `run-tasks.sh`.

For each that exists, create a timestamped backup:

```bash
TIMESTAMP=$(date +%Y%m%d%H%M%S)
# Ensure backup timestamp is unique
while [ -d "tasks.bak.$TIMESTAMP" ] || [ -f "PROJECT.md.bak.$TIMESTAMP" ]; do
  TIMESTAMP="${TIMESTAMP}_$(( RANDOM % 1000 ))"
done
[ -f PROJECT.md ] && mv PROJECT.md PROJECT.md.bak.$TIMESTAMP
[ -f .gitignore ] && cp .gitignore .gitignore.bak.$TIMESTAMP
[ -d tasks/ ] && mv tasks/ tasks.bak.$TIMESTAMP/
[ -d tests/ ] && mv tests/ tests.bak.$TIMESTAMP/
[ -f progress.txt ] && mv progress.txt progress.txt.bak.$TIMESTAMP
[ -f run-tasks.sh ] && mv run-tasks.sh run-tasks.sh.bak.$TIMESTAMP
```

## Step 1: Read and understand the plan

Read `plan.md` completely. Extract:

- **Tech stack and versions** (languages, frameworks, databases, tools)
- **Project structure** (folder layout, module boundaries)
- **Coding conventions** (if mentioned — naming, patterns, style)
- **Milestones and deliverables** (the work to be done)
- **Dependencies between deliverables** (what must come before what)

## Step 2: Create PROJECT.md

Create `PROJECT.md` at the repo root. This is the project context file that agents reference — it is NOT `CLAUDE.md` and does not load automatically. Agents are instructed to read it explicitly.

Structure:

```markdown
# [Project Name]

## Goal

[1-2 sentence project summary from plan.md]

## Tech Stack

[Extracted from plan.md — languages, frameworks, databases, key dependencies with versions]

## Project Structure

[Folder map extracted from plan.md — key directories, not every file]

## Conventions

[Coding conventions from plan.md — naming, patterns, formatting. If plan.md doesn't specify any, write "Follow standard conventions for the stack."]

## Architecture Notes

[Any API contracts, data models, key design decisions from plan.md that agents need repeatedly. Be selective — only include what's referenced across multiple tasks.]
```

Keep it under 300 lines. Every line costs agent context.

## Step 2b: Create .gitignore

Create (or merge into) `.gitignore` at the repo root. This file **must exist before any agent runs `git add`** to prevent committing junk files.

Start with a base set of universally unwanted patterns, then add stack-specific entries derived from the tech stack you extracted in Step 1.

```gitignore
# OS
.DS_Store
Thumbs.db

# Editor / IDE
.idea/
.vscode/
*.swp
*.swo
*~

# Environment & secrets
.env
.env.*

# Task runner state (lock dirs contain PIDs)
tasks/status/*.lock/
```

Then append patterns for the project's tech stack. Common examples:

- **Node / JS / TS:** `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`
- **Python:** `__pycache__/`, `*.pyc`, `.venv/`, `venv/`, `.mypy_cache/`
- **Go:** binary name, `vendor/` (if not vendored intentionally)
- **Rust:** `target/`
- **Java / Kotlin:** `build/`, `.gradle/`, `*.class`

Use your judgment based on the plan's tech stack — only include patterns that are relevant. If the plan already specifies a `.gitignore`, use that instead and merge in the base patterns above.

## Step 3: Create task files

Create `tasks/` directory and `tasks/status/` subdirectory. Populate `tasks/` with numbered task files.

### Task splitting — use your engineering judgment

Think like a senior engineer planning a sprint. Your goal is to maximize productivity for agents executing these tasks (potentially in parallel when independent).

**Prefer fewer, larger tasks** when the work is cohesive and an agent can complete it in one session. A single task that sets up the DB schema, seed script, and types is better than three separate tasks — less overhead, fewer handoffs.

**Split into multiple tasks** when:

- The deliverable has many unrelated files or subsystems
- Completing everything in one pass would require holding too much context
- There are natural breakpoints where one piece must be verified before continuing
- Later work depends on earlier output (e.g., can't build API routes before the DB exists)

**Identify parallelism.** If two tasks don't depend on each other, they can run simultaneously. Be explicit about this in the manifest (Step 4). For example: API routes and frontend shell might both depend on scaffolding but not on each other.

**Be mindful of context efficiency.** If two tasks would require the agent to read the same set of files, consider merging them.

The number of tasks depends entirely on the plan's scope. A small project might produce 5 tasks. A large one might produce 30+. Let the plan dictate this.

### Task file format

Each file is named: `001.md`, `002.md`, `003.md`, etc.

Use this template:

```markdown
# Task NNN: [Short descriptive title]

## Context

[2-3 sentences max. What does this task connect to? What should exist before this runs? What will use its output?]

## Files to Read

- PROJECT.md
- [exact/path/to/file.ext — every file the agent should read before starting]

## Files to Write

- [exact/path/to/file.ext — every file the agent will create or modify]
- tests/NNN_short_name.sh

## Steps

1. [High-level step — what to do, not how to do it]
2. [Another step]
3. [...]
   N. Write test script to `tests/NNN_short_name.sh` based on the test suggestions below.

## Test Suggestions

- [What to verify — e.g., "Server starts without errors on port 3000"]
- [Another verification — e.g., "POST /api/users returns 201 with valid payload"]
- [Another — e.g., "TypeScript compiles with no errors"]

## Definition of Done

[Plain English summary of what "complete" looks like. The agent checks this before marking the task done.]
```

### Task file rules

- **Keep each file under ~100 lines.** If you're going over, the task is too big — split it.
- **Steps stay high-level.** List _what_ needs to happen, not _how_. The executing agent is a capable engineer. "Create the auth middleware" is good. "Import express, create a function called authMiddleware that takes req, res, next..." is too detailed.
- **Files to Read uses exact paths from project root.** No directories, no glob patterns. `src/db/schema.ts` not `src/db/`. Include `PROJECT.md` in every task.
- **Files to Write includes the test script.** The agent writes the test as part of the task. Follow the naming convention: `tests/NNN_short_name.sh`.
- **Test Suggestions are high-level.** Tell the agent _what_ to verify, not _how_. The agent writes the actual test script.
- **Self-contained.** An agent should be able to read one task file + PROJECT.md and know exactly what to do without reading other task files. The Context section handles cross-references.
- **No ambiguity.** If a step could be interpreted two ways, add a brief clarification. But don't over-specify.

## Step 4: Create manifest.json

Create `tasks/manifest.json`. This is the structured data the runner script reads — task IDs, titles, and dependency relationships.

```json
{
  "tasks": [
    { "id": "001", "title": "Project Scaffolding", "depends_on": [] },
    { "id": "002", "title": "DB Schema", "depends_on": ["001"] },
    { "id": "003", "title": "Auth System", "depends_on": ["002"] },
    { "id": "004", "title": "API Routes", "depends_on": ["002"] }
  ]
}
```

Rules:

- `depends_on` lists task IDs that must be complete before this task can start.
- Tasks with no shared dependencies can run in parallel (e.g., 003 and 004 above).
- Every task in the manifest must have a corresponding `.md` file in `tasks/`.
- Order in the array should reflect a reasonable sequential execution order (for readability), even though the runner uses `depends_on` for scheduling.

## Step 5: Create test scaffolding

Create `tests/` directory and `tests/run_all.sh`:

```bash
#!/bin/bash
# Run all test scripts in order. Stops on first failure.
set -e

TESTS_DIR="$(dirname "$0")"
PASS_COUNT=0
TOTAL_COUNT=0

echo ""
echo "========================================"
echo "  Running All Tests (Regression)"
echo "========================================"
echo ""

for test_file in "$TESTS_DIR"/[0-9]*.sh; do
  [ -e "$test_file" ] || continue
  [ "$(basename "$test_file")" = "run_all.sh" ] && continue

  TOTAL_COUNT=$((TOTAL_COUNT + 1))
  TEST_NAME=$(basename "$test_file" .sh)

  echo "--- $TEST_NAME ---"
  if bash "$test_file"; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  PASS"
  else
    echo ""
    echo "  FAIL: $test_file"
    echo ""
    echo "Regression stopped. $PASS_COUNT/$TOTAL_COUNT passed before failure."
    exit 1
  fi
  echo ""
done

echo "========================================"
echo "  All $TOTAL_COUNT tests passed."
echo "========================================"
```

Make it executable: `chmod +x tests/run_all.sh`

## Step 6: Create progress.txt

Create `progress.txt` at the repo root with a header:

```
# Progress Log
# Agents: append your session notes below. Include task number, status, what changed, and anything the next agent needs to know.
# Format:
#   === Task NNN | Status: complete/incomplete | [timestamp] ===
#   CHANGES: ...
#   ISSUES: ...
#   NEXT STEPS: ...

```

## Step 7: Create run-tasks.sh

Create `run-tasks.sh` at the repo root. This is the parallel-safe agent loop with branch-per-task isolation.

```bash
#!/bin/bash
set -euo pipefail

TASKS_DIR="tasks"
STATUS_DIR="$TASKS_DIR/status"
MANIFEST="$TASKS_DIR/manifest.json"
TASK_TIMEOUT="${TASK_TIMEOUT:-30m}"
CURRENT_TASK=""

# ─── Cleanup on exit ───
cleanup() {
  if [ -n "$CURRENT_TASK" ]; then
    echo "-- Cleaning up lock for task $CURRENT_TASK"
    rmdir "$STATUS_DIR/$CURRENT_TASK.lock" 2>/dev/null || true
  fi
}
trap cleanup EXIT SIGINT SIGTERM

# ─── Auto-install dependencies ───
install_pkg() {
  local name="$1"
  echo "-- Installing $name..."
  if command -v brew &>/dev/null; then
    brew install "$name"
  elif command -v apt-get &>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq "$name"
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y "$name"
  elif command -v pacman &>/dev/null; then
    sudo pacman -S --noconfirm "$name"
  else
    echo "!! Could not auto-install $name — no supported package manager found (brew, apt, dnf, pacman)."
    echo "   Please install $name manually and re-run."
    exit 1
  fi
}

MISSING=()
command -v jq &>/dev/null || MISSING+=("jq")
command -v claude &>/dev/null || MISSING+=("claude")
if ! command -v timeout &>/dev/null && ! command -v gtimeout &>/dev/null; then
  MISSING+=("coreutils")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "── Missing dependencies: ${MISSING[*]}"
  echo ""
  read -r -p "Install them now? [Y/n] " answer
  answer="${answer:-Y}"
  if [[ "$answer" =~ ^[Yy]$ ]]; then
    for dep in "${MISSING[@]}"; do
      if [ "$dep" = "claude" ]; then
        if command -v npm &>/dev/null; then
          echo "-- Installing claude CLI via npm..."
          npm install -g @anthropic-ai/claude-code
        else
          echo "!! npm not found. Install Node.js first, then: npm install -g @anthropic-ai/claude-code"
          exit 1
        fi
      else
        install_pkg "$dep"
      fi
    done
    echo ""
    echo "-- All dependencies installed."
    echo ""
  else
    echo "!! Cannot proceed without: ${MISSING[*]}"
    exit 1
  fi
fi

# ─── Timeout command (macOS compatibility) ───
if command -v timeout &>/dev/null; then
  TIMEOUT_CMD="timeout"
elif command -v gtimeout &>/dev/null; then
  TIMEOUT_CMD="gtimeout"
else
  TIMEOUT_CMD=""
fi

# ─── Validation ───
if [ ! -f "$MANIFEST" ]; then
  echo "!! Manifest not found: $MANIFEST"
  exit 1
fi

TASK_COUNT=$(jq '.tasks | length' "$MANIFEST")
if [ "$TASK_COUNT" -eq 0 ]; then
  echo "!! No tasks in manifest."
  exit 1
fi

mkdir -p "$STATUS_DIR"

# ─── Git init ───
if [ ! -d .git ]; then
  git init
  echo "# $(basename "$(pwd)")" > README.md
  git add README.md
  git commit -m "Initial commit"
  echo "-- Initialized git repo with README.md"
elif [ -z "$(git log --oneline -1 2>/dev/null)" ]; then
  echo "# $(basename "$(pwd)")" > README.md
  git add README.md
  git commit -m "Initial commit"
  echo "-- Created initial commit with README.md"
fi

# ─── Detect default branch ───
DEFAULT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo "main")

# ─── Helpers ───
is_done()   { [ -f "$STATUS_DIR/$1.done" ]; }
is_locked() { [ -d "$STATUS_DIR/$1.lock" ]; }

is_stale_lock() {
  local pid_file="$STATUS_DIR/$1.lock/pid"
  if [ -f "$pid_file" ]; then
    local pid
    pid=$(cat "$pid_file")
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0  # PID is dead — lock is stale
    fi
  fi
  return 1
}

deps_met() {
  local task_id="$1"
  local deps
  deps=$(jq -r --arg id "$task_id" '.tasks[] | select(.id == $id) | .depends_on[]' "$MANIFEST" 2>/dev/null)
  for dep in $deps; do
    is_done "$dep" || return 1
  done
  return 0
}

claim_task() {
  mkdir "$STATUS_DIR/$1.lock" 2>/dev/null && echo $$ > "$STATUS_DIR/$1.lock/pid"
}

release_task() {
  rm -f "$STATUS_DIR/$1.lock/pid" 2>/dev/null || true
  rmdir "$STATUS_DIR/$1.lock" 2>/dev/null || true
}

mark_done() {
  touch "$STATUS_DIR/$1.done"
  release_task "$1"
}

# ─── Main loop ───
while true; do
  AVAILABLE=()
  ALL_DONE=true

  while IFS= read -r task_id; do
    if is_done "$task_id"; then
      continue
    fi
    ALL_DONE=false
    if is_locked "$task_id"; then
      # Check for stale locks (process died without cleanup)
      if is_stale_lock "$task_id"; then
        echo "-- Clearing stale lock for task $task_id"
        release_task "$task_id"
      else
        continue
      fi
    fi
    if deps_met "$task_id"; then
      AVAILABLE+=("$task_id")
    fi
  done < <(jq -r '.tasks[].id' "$MANIFEST")

  if [ "$ALL_DONE" = true ]; then
    echo ""
    echo "========================================"
    echo "  All tasks complete!"
    echo "========================================"
    exit 0
  fi

  if [ ${#AVAILABLE[@]} -eq 0 ]; then
    echo "-- No tasks available (dependencies pending or locked by another agent). Waiting 30s..."
    sleep 30
    continue
  fi

  TASK_ID="${AVAILABLE[0]}"
  TASK_TITLE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .title' "$MANIFEST")

  if ! claim_task "$TASK_ID"; then
    echo "-- Task $TASK_ID was claimed by another agent. Retrying..."
    continue
  fi
  CURRENT_TASK="$TASK_ID"

  echo ""
  echo "========================================"
  echo ">>  Task $TASK_ID: $TASK_TITLE"
  echo "========================================"
  echo ""

  # Branch for isolation — always start fresh from default branch
  BRANCH="task/${TASK_ID}"
  git checkout "$DEFAULT_BRANCH" 2>/dev/null
  git pull --ff-only 2>&1 || echo "-- git pull skipped (no remote or not fast-forwardable)"
  git branch -D "$BRANCH" 2>/dev/null || true
  git checkout -b "$BRANCH"

  # Execute
  CLAUDE_CMD=(claude --dangerously-skip-permissions --model claude-sonnet-4-latest -p "/execute $TASK_ID")
  if [ -n "$TIMEOUT_CMD" ]; then
    RUN_CMD=("$TIMEOUT_CMD" "$TASK_TIMEOUT" "${CLAUDE_CMD[@]}")
  else
    RUN_CMD=("${CLAUDE_CMD[@]}")
  fi
  if "${RUN_CMD[@]}"; then
    if is_done "$TASK_ID"; then
      echo ""
      echo "-- Merging $BRANCH to $DEFAULT_BRANCH..."
      git checkout "$DEFAULT_BRANCH"
      if git merge "$BRANCH" --no-ff -m "merge task $TASK_ID: $TASK_TITLE"; then
        git branch -d "$BRANCH" 2>/dev/null || true
        echo "** Task $TASK_ID complete and merged."
      else
        echo "-- Merge conflict on task $TASK_ID. Spawning agent to resolve..."
        CONFLICTED=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
        RESOLVE_PROMPT="Resolve the git merge conflict from merging branch '$BRANCH' into '$DEFAULT_BRANCH' for task $TASK_ID ($TASK_TITLE).

Conflicted files: $CONFLICTED

Steps:
1. Read each conflicted file
2. Resolve conflicts by integrating both sides correctly — prefer keeping all non-overlapping changes from both branches
3. Remove ALL conflict markers (<<<<<<< ======= >>>>>>>)
4. git add each resolved file
5. git commit --no-edit

Only edit conflicted files. Only resolve conflicts — do not refactor or change logic."

        RESOLVE_CMD=(claude --dangerously-skip-permissions -p "$RESOLVE_PROMPT")
        if [ -n "$TIMEOUT_CMD" ]; then
          RESOLVE_CMD=("$TIMEOUT_CMD" "10m" "${RESOLVE_CMD[@]}")
        fi

        if "${RESOLVE_CMD[@]}"; then
          echo "** Task $TASK_ID: merge conflict resolved and merged."
          git branch -d "$BRANCH" 2>/dev/null || true
        else
          echo "!! Task $TASK_ID: conflict resolution failed. Aborting merge and releasing for retry."
          git merge --abort 2>/dev/null || true
          release_task "$TASK_ID"
          CURRENT_TASK=""
        fi
      fi
    else
      echo "-- Task $TASK_ID: agent exited without completing. Committing partial work."
      git add -A && git commit -m "task $TASK_ID: partial progress" --allow-empty 2>/dev/null || true
      git checkout "$DEFAULT_BRANCH"
      git merge "$BRANCH" --no-ff -m "partial: task $TASK_ID" 2>/dev/null || true
      git branch -d "$BRANCH" 2>/dev/null || true
      release_task "$TASK_ID"
    fi
  else
    echo "!! Task $TASK_ID: agent timed out or errored."
    git checkout "$DEFAULT_BRANCH" 2>/dev/null
    git branch -D "$BRANCH" 2>/dev/null || true
    release_task "$TASK_ID"
  fi
  CURRENT_TASK=""
done
```

Make it executable: `chmod +x run-tasks.sh`

## Step 8: Final check

After generating everything, verify:

- Every milestone/deliverable from plan.md is covered by at least one task
- Tasks are in a logical execution order (dependencies come first in manifest)
- No task's "Files to Read" references files that wouldn't exist yet given its dependencies
- `manifest.json` task list matches the task files exactly
- `PROJECT.md` is under 300 lines
- `.gitignore` exists and includes stack-appropriate patterns
- `tests/run_all.sh` exists and is executable
- `run-tasks.sh` exists and is executable
- `progress.txt` exists
- `tasks/status/` directory exists

Report to the user: how many tasks were created, which tasks can run in parallel, and a brief summary of the task breakdown.

## Example

Given a plan.md for a SaaS app with auth, a REST API, and a React frontend, you might produce:

```
tasks/001.md  — Project scaffolding and config        (depends: none)
tasks/002.md  — Database schema and migrations         (depends: 001)
tasks/003.md  — Auth system (JWT, middleware, routes)   (depends: 002)
tasks/004.md  — Core API routes (CRUD)                  (depends: 002)
tasks/005.md  — Frontend shell (routing, layout)        (depends: 001)
tasks/006.md  — Frontend feature pages                  (depends: 005, 004)
tasks/007.md  — Integration tests                       (depends: 003, 004, 006)
tasks/008.md  — CI/CD pipeline                          (depends: 007)
```

Parallelism: 003 + 004 can run together (both depend only on 002). 005 can run alongside 002 (only depends on 001). The manifest expresses all of this.
