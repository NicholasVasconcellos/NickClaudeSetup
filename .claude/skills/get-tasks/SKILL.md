---
name: get-tasks
description: >
  Break a PRD, issue, or user description into atomic tasks
  with dependency ordering. Outputs structured JSON task plan.
  Trigger on: /get-tasks
disable-model-invocation: true
---

# get-tasks

Analyze the project and decompose it into atomic tasks.

## Inputs

You will receive one of: a PRD document, a GitHub issue, a user description, or a combination. Read all provided inputs before doing anything else.

## Step 1 — Generate or update CODEBASE.md

If `CODEBASE.md` does not exist at the project root, create it now. If it exists but is stale (missing files or directories that clearly exist), update it.

CODEBASE.md must be:
- Hierarchical: reflect the actual directory tree
- Scannable: use concise annotations, not prose
- Accurate: walk the real file system, do not guess

Format example:
```
src/
  server/
    index.ts          — Express entry point, registers all routes
    middleware/
      auth.ts         — JWT verification middleware
  db/
    schema.ts         — Drizzle ORM schema definitions
    migrations/       — Migration files (auto-generated)
tests/
  server/
    auth.test.ts      — Auth route integration tests
```

## Step 2 — Fetch relevant documentation

Use Context7 to fetch documentation for every library, framework, or SDK that the task involves. Do this before forming any plan. Confirm the version pinned in package.json (or equivalent) matches a current, widely-supported release. Note any version concerns in your output.

## Step 3 — Analyze requirements

Read the inputs again. Identify:
- The end goal (what done looks like)
- The domain areas involved (auth, data layer, UI, infra, etc.)
- Constraints (existing conventions, tech stack, deployment target)
- Unknowns that need a decision before work can begin

If critical unknowns exist, list them and stop — ask the user before continuing.

## Step 4 — Decompose into tasks

Decompose the work into a flat list of tasks. A task must be:
- **Atomic**: one logical unit of work, completable by one agent in one session
- **Concrete**: the description includes enough context to implement without re-reading the full PRD
- **Verifiable**: acceptance criteria are explicit and testable

Walk down every branch of the design tree. Do not stop early because a list feels long. Do not merge distinct concerns into one task to keep the list short. There is no upper or lower limit on task count — decompose until every task is truly atomic.

For each task, identify which other tasks (by title) must complete before it can start.

## Step 5 — Output

Output the task plan as a single JSON object and nothing else after it. Do not wrap it in a code block — output raw JSON.

Schema:
```json
{
  "tasks": [
    {
      "title": "string",
      "description": "string — what to build and the exact acceptance criteria",
      "dependsOn": ["task title", "..."]
    }
  ]
}
```

Rules for the JSON output:
- `title` is unique across all tasks
- `description` is self-contained — a fresh agent must be able to read it and know exactly what to implement and how to verify it is done
- `dependsOn` references `title` strings exactly as written; use `[]` if there are no dependencies.

## Step 6 — Post-output checklist

After outputting the JSON, append a plain-text section with these items:

**Missing or recommended MCP tools**
List any MCP servers or CLI tools that would help execute these tasks but are not confirmed available (e.g., a database MCP if tasks touch a database, Playwright MCP if tasks touch UI). For each, include the install or setup command.

**Manual steps required**
List every action the user must take manually before execution can begin — API key setup, OAuth app creation, environment variable configuration, cloud resource provisioning, etc. Be specific: include where to get the credential and what env var or config file it goes into.

## What NOT to do

- Do not write any code.
- Do not create any files other than CODEBASE.md.
- Do not ask clarifying questions unless there are blocking unknowns identified in Step 3.
- Do not pad the task list with generic tasks like "write tests" or "add logging" — tests belong inside each task's acceptance criteria; logging is part of implementation.
- Do not invent constraints that are not in the inputs.
