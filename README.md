# Nick Claude Setup

Sharing my personal setup with Claude Code for autonomous test-driven development, with full control. Go from a plan to a final working product.

Start with `plan.md`, then get to a working project with three commands.

_Credit to: https://x.com/mattpocockuk for similar setup inspiring this one_

## How to use

### 1. Write your plan

Add `plan.md` in your project root for what you want to create.

[See tips for creating a good plan and why it matters](#planning-best-practices) (will save you hours down the line — most important part of the workflow).

### 2. Initialize the workspace

```bash
bash init.sh
```

Creates all directories, writes `run-tasks.sh`, `tests/run_all.sh`, `progress.txt` template, base `.gitignore`, and merges `thinkingEnabled: true` into `.claude/settings.json`. Pure bash, no AI.

### 3. Generate tasks

Open Claude Code and run:

```
/getTasks
```

Reads your `plan.md` and produces `PROJECT.md`, numbered task files, `manifest.json`, and appends stack-specific `.gitignore` patterns. This is the only step that uses AI — it does the intellectual work of decomposing your plan into dependency-aware, self-contained tasks.

### 4. Launch agents

```bash
./run-tasks.sh
```

Orchestrates the full build: topological sort for parallel execution, per-task worktree isolation, a state machine driving each task through phases, and a background merge queue.

---

## How It Works

```
plan.md ──▶ init.sh ──▶ /getTasks ──▶ tasks/ + manifest.json ──▶ run-tasks.sh ──▶ built project
```

### Initialization (`init.sh`)

Pure bash setup — no AI involved:

| Created                  | Purpose                                            |
| ------------------------ | -------------------------------------------------- |
| `tasks/status/`          | State files tracking each task's phase             |
| `tasks/merge-queue/`     | Directory-based merge queue for completed tasks    |
| `tests/run_all.sh`       | Regression test runner                             |
| `.worktrees/`            | Git worktree directory for branch isolation        |
| `logs/`                  | Per-task log files                                 |
| `progress.txt`           | Append-only log for agent handoffs                 |
| `run-tasks.sh`           | The orchestrator script (embedded in `init.sh`)    |
| `.gitignore`             | Base patterns (state files, worktrees, logs, merge-queue all ignored) |
| `.claude/settings.json`  | Merges `thinkingEnabled: true`                     |

### Task Generation (`/getTasks`)

Reads `plan.md` and produces the task workspace:

| Generated File                | Purpose                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `PROJECT.md`                  | Project context for agents — stack, structure, conventions          |
| `tasks/001.md`, `002.md`, ... | Self-contained task specs with acceptance criteria and file lists   |
| `tasks/manifest.json`         | Dependency graph (DAG) enabling parallel execution                  |

Each task file contains goal, features, constraints, acceptance criteria, and exact file paths to read/write. Tasks describe WHAT, never HOW — implementation is left to the agents.

### Execution Phases

Each task moves through a state machine: **spec → implement → review → done → merged**

State is tracked via `tasks/status/NNN.state` files. The runner initializes missing state files as `spec` at startup. Agents update state on success; the runner only writes `merged` after a successful merge.

| Phase       | Skill        | Model/Effort | What happens                                                        |
| ----------- | ------------ | ------------ | ------------------------------------------------------------------- |
| **spec**    | `/spec`      | Sonnet/High  | Writes `tests/NNN_test.sh` from acceptance criteria. No source code. |
| **implement** | `/implement` | Opus/High    | Builds the features. Runs tests. Debugs until passing.             |
| **review**  | `/review`    | Sonnet/High  | Cleans up code, enforces conventions, runs regression.              |
| **done**    | _(runner)_   | Opus/High    | Queued for merge into main branch.                                  |

Per-phase model and effort are configurable via env vars (`SPEC_MODEL`, `IMPLEMENT_MODEL`, etc.). Each `claude` invocation gets `--effort` flag.

All phases inject `@PROJECT.md @tasks/NNN.md @progress.txt` plus extra files parsed from the task's "Files to Read" section.

**Context limit handling:** if an agent hits context limits, it commits partial work, logs notes to `progress.txt`, and exits without updating state. The runner retries with a fresh agent that picks up where it left off.

### The Runner Script (`run-tasks.sh`)

The orchestrator handles the full lifecycle:

- **Topological sort** — computes parallel execution layers from `depends_on` in the manifest at runtime
- **Parallel execution** — launches all tasks in a layer as background processes with PID tracking and per-task log files
- **Worktree isolation** — each task runs on its own `task/NNN` git branch in a dedicated worktree
- **State machine** — drives `spec → implement → review → done` with retry loops per phase (configurable `MAX_RETRIES`, default 3)
- **Background merge queue** — directory-based queue with a merge loop running alongside task workers
- **Conflict resolution** — merge conflicts are auto-resolved by a dedicated agent; falls back to abort on failure
- **Layer failure handling** — if any task in a layer fails, the runner finishes the current layer then stops
- **Structural validation** — checks manifest JSON, verifies task files exist, detects circular dependencies at startup

---

## File Structure

```
your-project/
├── plan.md                  # Your project plan (you write this)
├── init.sh                  # Workspace initializer (run first)
├── PROJECT.md               # Generated project context for agents
├── tasks/
│   ├── 001.md ... NNN.md    # Individual task specs
│   ├── manifest.json        # Dependency graph
│   ├── status/              # State files (NNN.state)
│   └── merge-queue/         # Directory-based merge queue
├── tests/
│   ├── run_all.sh           # Regression runner
│   └── NNN_test.sh          # Per-task test scripts (spec phase)
├── progress.txt             # Agent handoff log
├── logs/                    # Per-task execution logs
├── .worktrees/              # Git worktrees for branch isolation
└── run-tasks.sh             # Orchestrator script
```

---

## Prerequisites

- **Git** — must be installed
- **jq** — for manifest parsing
- **Claude Code CLI** — `claude` must be on PATH

## Setup

Copy `.claude/skills/` and `init.sh` into your project:

```bash
cp -r .claude/skills/ /path/to/your-project/.claude/skills/
cp init.sh /path/to/your-project/
```

Then create your `plan.md`, run `bash init.sh`, and follow the steps above.

---

## Configuration

Override defaults via environment variables:

```bash
# Models per phase
SPEC_MODEL=sonnet IMPLEMENT_MODEL=opus REVIEW_MODEL=sonnet MERGE_MODEL=opus

# Effort per phase
SPEC_EFFORT=high IMPLEMENT_EFFORT=high REVIEW_EFFORT=high MERGE_EFFORT=high

# Retry limit per phase
MAX_RETRIES=3
```

---

## Planning Best Practices

The plan is the single highest-leverage artifact in the workflow. Every minute spent here saves multiples downstream — a vague plan produces tasks that contradict each other, a vague final product, agents that guess at architecture, and hours of debugging that a clearer sentence would have prevented.

### How to make a plan

Test the agent's understanding (and by consequence your own) by using ask-user-question iterations to get concrete decisions on architecture: stack, folder structure, API surface, etc.

### What a good plan contains

- **Concrete architecture decisions** — name the stack, the folder structure, the data model, and the API surface. "Use a REST API" is not enough; "Express routes under `/api/v1/` returning JSON, Postgres via Prisma" gives agents something to build against.
- **Explicit scope boundaries** — state what is _out_ of scope. Agents will happily build features you didn't ask for if the plan leaves room for interpretation.
- **Edge cases and error behavior** — if you know how auth failures, empty states, or concurrent writes should be handled, say so. Unspecified behavior becomes inconsistent behavior across tasks.
- **Acceptance criteria** — describe what "done" looks like for the whole project, not just individual features. This anchors the generated task definitions of done.

Dump your idea, even if it is messy. Brainstorm and dump everything you want to be featured into a doc, use voice notes or type it out.

Prompt Claude to poke holes and challenge your approach, have it help you decide on a concrete approach. If anything is unclear, research it on another tab to get more context on the best approach for a given goal instead of leaving it to chance.

Prompts I like:

_Interview me about the plan, repeatedly ask questions about literally anything, to make sure there are no gaps._

_Tell me what I might be overlooking and why it matters_

_What questions should I be asking that I haven't thought of yet?_
