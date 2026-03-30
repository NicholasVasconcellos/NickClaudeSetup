# Nick Claude Setup

Sharing my personal setup with claude code for autonomous test driven development, with full control. Go from a plan to final working product.

Credit to: https://x.com/mattpocockuk for similar setup inspiring this one

## I start with the `plan.md`, then have the work in progress with two commands.

## Quick Start

### 1. Write your plan

Add the `plan.md` in your project root for what you want to create.

[See tips for creating a good plan and why it matters](#planning-best-practices) (will save you hours down the line — most important part of the workflow).

### 2. Generate tasks

Open Claude Code and run:

```
/plan-to-tasks
```

This skill parses your plan into sequenced, dependency-aware task files optimized for single-agent context windows.

### 3. Launch agents

```bash
./run-tasks.sh
```

Runs a bash loop that repeatedly spawns agents to pick up tasks, execute them on isolated git branches, write tests, debug failures, and merge on success. uses topological sorting for paralel execution when possible.

---

## How It Works

```
plan.md ──▶ /plan-to-tasks ──▶ tasks/ + manifest.json ──▶ run-tasks.sh ──▶ built project
```

### Planning Phase

The `/plan-to-tasks` skill reads your `plan.md` and produces a complete workspace:

| Generated File                | Purpose                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `PROJECT.md`                  | Project context for agents — stack, structure, conventions          |
| `tasks/001.md`, `002.md`, ... | Self-contained task specs with steps, file lists, and test criteria |
| `tasks/manifest.json`         | Dependency graph enabling parallel execution                        |
| `tasks/status/`               | Filesystem-based task locking and completion tracking               |
| `tests/run_all.sh`            | Regression test runner                                              |
| `progress.txt`                | Append-only log for agent handoffs                                  |
| `run-tasks.sh`                | The orchestrator script                                             |
| `.gitignore`                  | Stack-appropriate ignore patterns                                   |

Each task file contains context, exact file paths to read/write, high-level steps, test suggestions, and a definition of done to allow for proper context management, while the overall architecture is already defined and adhered to.

### Execution Phase

The `/execute` skill defines what each agent does when assigned a task:

1. **Load context** — reads `PROJECT.md`, the task file, `progress.txt`, and all specified input files
2. **Implement** — follows the task steps, writes only the specified output files
3. **Test** — writes a self-contained test script and runs it
4. **Debug loop** — if tests fail, the agent reads output, fixes code, and retries. If stuck, it commits partial work with detailed notes and exits for a fresh agent to continue
5. **Regression check** — runs all existing tests to catch breakages
6. **Atomic commit** — source code, tests, progress log, and done marker in a single commit

### The Runner Script (`run-tasks.sh`)

The orchestrator handles the full lifecycle:

- **Dependency resolution** — topological sort via `manifest.json`; only runs tasks whose dependencies are complete
- **Branch isolation** — each task runs on its own `task/NNN` git branch, merged to main on success
- **Parallel safety** — filesystem-based locking with stale lock detection. Run multiple instances simultaneously
- **Timeout protection** — configurable via `TASK_TIMEOUT` env var (default: 30 minutes)
- **Failure handling** — timed-out or errored tasks are released for retry; merge conflicts are auto-resolved by a dedicated agent (falls back to retry if resolution fails)

---

## File Structure

```
your-project/
├── plan.md                  # Your project plan (you write this)
├── PROJECT.md               # Generated project context for agents
├── tasks/
│   ├── 001.md ... NNN.md    # Individual task specs
│   ├── manifest.json        # Dependency graph
│   └── status/              # Lock files and .done markers
├── tests/
│   ├── run_all.sh           # Regression runner
│   └── 001_*.sh ... NNN_*.sh # Per-task test scripts (agent-written)
├── progress.txt             # Agent handoff log
└── run-tasks.sh             # Orchestrator script
```

---

## Prerequisites

- **Git** — must be installed
- **Node.js / npm** — needed to install the Claude Code CLI

All other dependencies (`jq`, `coreutils`, `claude` CLI) are **auto-installed** when you first run `./run-tasks.sh`. The script detects your package manager (brew, apt, dnf, or pacman) and prompts before installing anything.

## Setup

To use these skills in any project, copy the `.claude/skills/` directory into your repo:

```bash
cp -r .claude/skills/ /path/to/your-project/.claude/skills/
```

Then create your `plan.md` and follow the Quick Start steps above.

---

## Planning Best Practices

The plan is the single highest-leverage artifact in the workflow. Every minute spent here saves multiples downstream a vague plan produces, tasks that contradict each other, vague final product AI model converges to the mean (generic slop look), agents that guess at architecture, and hours of debugging that a clearer sentence would have prevented.

## How to make a plan

- test the agent's understandign and by consequence your own understanding of th eproject usign the ask user question, got o iterations of asking questions to get concrete decisions on carchitecture: Stack , folder structue, API surface etc.

### What a good plan contains

- **Concrete architecture decisions** — name the stack, the folder structure, the data model, and the API surface. "Use a REST API" is not enough; "Express routes under `/api/v1/` returning JSON, Postgres via Prisma" gives agents something to build against.
- **Explicit scope boundaries** — state what is _out_ of scope. Agents will happily build features you didn't ask for if the plan leaves room for interpretation.
- **Edge cases and error behavior** — if you know how auth failures, empty states, or concurrent writes should be handled, say so. Unspecified behavior becomes inconsistent behavior across tasks.
- **Acceptance criteria** — describe what "done" looks like for the whole project, not just individual features. This anchors the generated task definitions of done.

dump your idea, even if it is messy. Brainstorm and dump everything you want to be featured into a doc, use voice notes or type it out.

When promp claud eto poke holes and challenge your approach, have it help you decide on the a conrecrete approach.
If anythign is unclear I personally research it on another tab to get more context on the best approach for a given goal instead of leavign it to chance.

Prompts I like:

_Interview me about the plan, repeatedly ask questions about literally anything, to make sure there are no gaps._

_Tell me what I might be overlooking and why it matters_

_What questions should I be asking that I haven’t thought of yet?_
