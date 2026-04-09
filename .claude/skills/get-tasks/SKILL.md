---
name: get-tasks
description: >
  Break a plan.md into executable task files, manifest, and project context.
  Trigger on: "get tasks", "break down the plan", "create tasks", or when
  user has plan.md and init.sh has been run.
disable-model-invocation: true
---

# getTasks

Read `plan.md`. Produce `PROJECT.md`, `tasks/*.md`, `tasks/manifest.json`. Append stack patterns to `.gitignore`.

## Input

`plan.md` in repo root (or user-specified path). `init.sh` must have run first.

## Step 1: Read plan.md completely

Extract: tech stack, project structure, conventions, milestones, dependencies between deliverables.

## Step 2: Create PROJECT.md

Global context for all agents. Under 300 lines.

```markdown
# [Project Name]

## Goal

[1-2 sentences]

## Tech Stack

[Languages, frameworks, databases, versions]

## Project Structure

[Key directories only]

## Conventions

[From plan. If none: "Follow standard conventions for the stack."]

## Architecture Notes

[API contracts, data models, cross-task design decisions. Be selective.]
```

## Step 3: Append to .gitignore

Add stack-specific patterns (e.g., `node_modules/`, `__pycache__/`, `target/`, `dist/`). Don't duplicate existing entries.

## Step 4: Create task files

Numbered files in `tasks/`: `001.md`, `002.md`, etc.

### Splitting

Prefer fewer, larger tasks when cohesive. Split when: unrelated subsystems, natural verification breakpoints, or dependency ordering requires it.

### Format

```markdown
# Task NNN: [Title]

## Goal

[1-2 sentences — what completing this achieves]

## Features / Functionality

- [Observable deliverable]

## Constraints

- [Technical boundaries, what NOT to do]

## Acceptance Criteria

- [Testable pass/fail condition]

## Hints (optional)

[Non-obvious domain knowledge only. Never implementation steps.]

## Files to Read

- PROJECT.md
- [exact/path/to/file.ext]

## Files to Write

- [exact/path/to/file.ext]
```

### Rules

- Under 80 lines. No implementation steps — WHAT, never HOW.
- Acceptance Criteria must be testable.
- Files to Read: exact paths, always include PROJECT.md.
- Self-contained: one task + PROJECT.md = everything an agent needs.
- Walk down each branch of the design tree in the plan file. Create as many tasks as needed, no upper or lower limit, flexible based on the plan.

## Step 5: Create manifest.json

```json
{
  "tasks": [
    { "id": "001", "title": "Scaffolding", "depends_on": [] },
    { "id": "002", "title": "DB Schema", "depends_on": ["001"] },
    { "id": "003", "title": "Auth", "depends_on": ["002"] },
    { "id": "004", "title": "API Routes", "depends_on": ["002"] }
  ]
}
```

Every task has a matching `.md` file. `depends_on` drives the DAG for parallel execution.

## Step 7: Validate

- Every plan milestone covered by at least one task.
- No task reads files that wouldn't exist given its dependency order.
- No circular dependencies.
- Manifest matches task files.
- PROJECT.md under 300 lines.

## Step 8: Commit

```bash
git add -A
git commit -m "tasks: break down plan into $(ls tasks/*.md | wc -l) tasks"
```

Report: task count, layer structure (which tasks can run in parallel), summary.

List any missing/ reccomended mcp tools

Based on the plan inform the user of any manual steps needed to get authentication keys, access tokens, etc. Anything that would need to be done trough the browser and placed in the .env.local file. (if any other file specify)
