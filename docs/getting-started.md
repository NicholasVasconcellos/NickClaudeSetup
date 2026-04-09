# Getting Started with Claude Orchestrator

A step-by-step guide to going from a `plan.md` file to a fully implemented project using autonomous Claude Code agents.

---

## Prerequisites

1. **Node.js 20+** and **pnpm 9+** installed
2. **Claude CLI** authenticated — run `claude auth login` if not already
3. **Git** configured with a remote (the orchestrator pushes after each merge)

---

## Step 1: Install the Orchestrator

Clone or navigate to the orchestrator repo and install dependencies:

```bash
cd /path/to/NickClaudeSetup
pnpm install
```

---

## Step 2: Write Your Plan

Create a `plan.md` in your **target project** root. This is the single document that drives everything. The more specific you are, the better the output.

A good plan includes:

- **What** you're building (1-2 sentence overview)
- **Requirements** grouped by feature area
- **Acceptance criteria** for each feature (testable, specific)
- **Technical constraints** (framework, database, APIs, etc.)
- **Non-goals** (what you're explicitly not building)

Example structure:

```markdown
# Project: Task Management API

## Overview
A REST API for managing tasks with authentication, real-time updates, and team collaboration.

## Requirements

### Authentication
- JWT-based auth with signup, login, refresh
- Password hashing with bcrypt
- Rate limiting: 10 requests/minute per IP
- Acceptance: POST /auth/signup returns 201 with JWT pair

### Task CRUD
- Create, read, update, delete tasks
- Tasks belong to a user and optionally a team
- Support filtering by status, assignee, due date
- Acceptance: GET /tasks?status=open returns filtered list with pagination

### Real-time Updates
- WebSocket connection for live task updates
- Notify team members when tasks are assigned or completed
- Acceptance: Connected clients receive task updates within 500ms

## Technical Constraints
- TypeScript + Express
- PostgreSQL with Prisma ORM
- Deploy to Railway

## Non-goals
- No mobile app
- No file attachments (v2)
```

---

## Step 3: Run Task Decomposition

The orchestrator's first phase analyzes your plan and breaks it into tasks with dependencies. From the **orchestrator repo** directory:

```bash
pnpm dev -- --project-dir /path/to/your/project
```

This will:
1. Run the **discovery** skill — scans your project for services, tools, dependencies
2. Run the **get-tasks** skill — reads `plan.md` and outputs tasks as JSON
3. Insert tasks into SQLite with dependency relationships
4. Compute the DAG (execution order)
5. Print the task graph and begin execution

### CLI Options

| Flag | Default | Description |
|------|---------|-------------|
| `--project-dir <path>` | Current directory | Your target project |
| `--concurrency <n>` | 4 | Max parallel tasks per layer |
| `--timeout <ms>` | 600000 (10min) | Per-task timeout |
| `--overall-timeout <ms>` | 7200000 (2hr) | Total run timeout |
| `--ws-port <port>` | 3100 | WebSocket port for dashboard |
| `--no-push` | false | Disable auto-push after merge |
| `--main-branch <branch>` | main | Branch to merge into |

---

## Step 4: Open the Dashboard

In a second terminal:

```bash
pnpm dev:dashboard
```

Open **http://localhost:3200** in your browser. You'll see:

- **Task Graph** — visual DAG showing tasks as cards, color-coded by state, with dependency lines
- **Log Viewer** — real-time streaming output from all running agents
- **Controls** — Pause All / Resume All, plus per-task Pause / Resume / Retry / Skip
- **Cost Panel** — running totals for USD, tokens in/out, per-task breakdown

### Task States (Color Key)

| State | Color | Meaning |
|-------|-------|---------|
| Pending | Gray | Waiting for dependencies |
| Spec | Blue | Writing tests from acceptance criteria |
| Executing | Cyan | Implementing code to pass tests |
| Reviewing | Yellow | Code review + cleanup |
| Done | Green | All tests passing, ready to merge |
| Merged | Emerald | Merged to main branch |
| Failed | Red | Failed after max retries |
| Skipped | Neutral | Skipped (dependency failed) |
| Paused | Orange | Manually paused via dashboard |

---

## Step 5: Monitor and Intervene

While the orchestrator runs, you can:

- **Pause a task** — click it in the graph, then "Pause" in task controls
- **Skip a task** — if you realize it's not needed
- **Retry a failed task** — after fixing the underlying issue (e.g., adding missing API keys)
- **Pause everything** — "Pause All" stops new tasks from starting

The orchestrator handles these edge cases automatically:

- **Test failures** → retries the execute phase (up to 3 times by default)
- **Spec timeouts** → kills the agent, retries with fresh context
- **Review rejections** → sends back to execute with specific fix instructions
- **Merge conflicts** → attempts auto-resolution, runs tests to verify
- **Permanent failures** → marks failed, skips dependent tasks, continues the rest

---

## Step 6: Review the Output

When the run completes:

1. **All successful tasks** are merged to your main branch and pushed to GitHub
2. **A session summary** is generated with stats: tasks completed/failed/skipped, total cost, duration
3. **Learnings** are captured from errors and fixes, then routed to skill files for future improvements

Check your project — the code is on the main branch, committed per-task with concise messages.

---

## Working with Large Plans

For plans with 30+ requirements, the orchestrator handles scale through:

### Milestones
The get-tasks skill groups related tasks into milestones (e.g., "Authentication", "API Layer", "Frontend"). Each milestone's tasks are internally ordered, and milestones can depend on each other.

### DAG Layers
Tasks are organized into layers based on dependencies. Within each layer, tasks run in parallel up to the concurrency limit. A project with 40 tasks might have 8-10 layers, with 3-6 tasks running simultaneously per layer.

### Context Management
Each agent only receives:
- Its own task description and acceptance criteria
- A summary of completed dependency tasks (not full code)
- The codebase map (auto-generated, showing file structure)
- Relevant library docs (fetched via Context7)

This keeps each agent focused and within context limits.

### Tips for Large Plans

1. **Be specific in acceptance criteria** — vague criteria lead to vague implementations
2. **Group related work** — the decomposer handles this, but explicit grouping in your plan helps
3. **Call out integration points** — "The notification service must use the same JWT middleware from the auth API"
4. **Set concurrency based on your machine** — 4 is safe for most setups, 6-8 if you have RAM to spare
5. **Use `--no-push` for first runs** — review locally before pushing to remote
6. **Keep plan.md under 5000 words** — longer plans work but are harder for the decomposer to hold in context. Split into sections if needed.

---

## Demo Mode

To see the orchestrator in action without spending Claude credits:

```bash
# Terminal 1: Run the demo (simulates 14 tasks with edge cases)
npx tsx packages/orchestrator/src/demo.ts

# Terminal 2: Start the dashboard
pnpm dev:dashboard

# Open http://localhost:3200
```

The demo showcases: normal flow, test failure retries, spec timeouts, review rejections with security fixes, merge conflicts with auto-resolution, permanent failures, and skipped tasks.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Claude CLI not found" | Run `claude auth login` or check `claude --version` |
| Tasks hang past timeout | Increase `--timeout` or check if the task is too large (split it) |
| Merge conflicts not auto-resolving | The orchestrator tries auto-resolve then fails the task. Resolve manually and retry via dashboard |
| Dashboard shows "Disconnected" | Check that the orchestrator is running on the same `--ws-port` (default 3100) |
| Too many concurrent tasks | Lower `--concurrency` to reduce memory/CPU pressure |
| "Cycle detected" error | Your plan has circular dependencies — A depends on B depends on A. Fix in plan.md |

---

## Project Structure Reference

```
NickClaudeSetup/
├── packages/
│   ├── orchestrator/src/     # Core engine (TypeScript)
│   │   ├── index.ts          # CLI entry point
│   │   ├── runner.ts         # Main execution loop
│   │   ├── dag.ts            # Task dependency graph
│   │   ├── db.ts             # SQLite state persistence
│   │   ├── git.ts            # Git worktree isolation
│   │   ├── claude.ts         # Claude CLI spawning
│   │   ├── state-machine.ts  # Phase transitions
│   │   ├── ws-server.ts      # WebSocket for dashboard
│   │   ├── learning.ts       # Self-improvement pipeline
│   │   └── types.ts          # Shared types
│   └── dashboard/src/        # Next.js web UI
├── skills/                   # Agent instructions per phase
├── templates/                # Project templates
└── docs/                     # This documentation
```
