---
name: get-tasks
description: >
  Break a PRD, issue, or user description into self-contained tasks
  with dependencies. Outputs structured JSON task plan.
  Trigger on: /get-tasks
disable-model-invocation: true
---

# get-tasks

Analyze the project and decompose it into self-contained tasks.

## Inputs

Read all provided inputs before doing anything else.

## Step 1 — Generate or update CODEBASE.md (subagent)

Spawn a subagent to generate or update `CODEBASE.md`. instruct subagent to:

- Create `CODEBASE.md` if not existing.
- Will serve a map file for agent reducing the need to scan the whole codebae, overall map of the codebase with hierarchical structure. Based on the specification of the plan document.
- Contains coding, style, guidelines and conventions consistent troughout the codebase. Based on the specific plan and libraries / stack used.
- Any addiontal High level information that should be avaialbe project wide for subsequent agents working on new features.
- Ensure it is as consise as possible with only meaningfull information as briefly as possible to minimze context consumption.

CODEBASE.md must be:
- Hierarchical: reflect the actual directory tree
- Scannable: use concise annotations, not prose
- Accurate: based on the real filesystem

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

## Step 2 — Fetch relevant documentation (subagent)

Spawn a subagent to use Context7 to fetch documentation for every library, framework, or SDK that the project will use based on the plan. The subagent should confirm the version pinned in package.json (or equivalent) matches a current, widely-supported release, and note any version concerns. 

Subagent will create a `docs` directory in the root (append to it if existing), and place instructions grouped by the library and use case in their own folders, with updated function syntax and references for it to be used or any other relevant context gathered from fetching the online documentations.

> **Steps 1 and 2 run in parallel as independent subagents.** Move on to step 3 after these are done



## Step 3 — Decompose into tasks

Decompose the work into a flat list of tasks. Each task should read as if a project manager is handing it off to a lead senior engineer. A task must be:
- **Self-contained**: full context about what to build and how it fits into the overall project — a fresh engineer reading only this description should know exactly what's needed
- **Concrete**: specific about the expected outcome — what it looks like when done, what it produces, what changes in the codebase
- **Scoped**: one logical unit of work, implementable in a single session

Walk down every branch of the design tree. Do not stop early because a list feels long. Do not merge distinct concerns into one task to keep the list short. There is no upper or lower limit on task count — decompose until every task is a single coherent unit of work and the tasks fufill the scope of the project no matter how large or small.

For each task, list what other task or tasks it depends on (by title), list which other task should be done before it can start.

## Step 4 — Output

Output the tasks single JSON object. 
Create `/tasks/tasks.json` in root with the raw json. 

Schema:
```json
{
  "tasks": [
    {
      "title": "string",
      "description": "string — what to build, how it fits into the project, and what the expected outcome looks like",
      "contextFiles": ["path to file1", "path to file 2", "..."],
      "dependsOn": ["task title", "..."]
    }
  ]
}
```

Rules for the JSON output:
- `title`: unique across all tasks
- `description`: full deatiled, self-contained, written as a PM handoff to a senior engineer, with full context about the feature, how it fits into the project, and what done looks like
- `dependsOn` references `title` strings exactly as written; use `[]` if there are no dependencies. only list direct dependencies, should follow naturally from the logical flow of creating the task list.


## Step 5 — Post-output checklist

After outputting the JSON, append a plain-text section with these items:

**Missing or recommended MCP tools**
List any MCP servers or CLI tools that would help execute these tasks but are not confirmed available (e.g., a database MCP if tasks touch a database, Playwright MCP if tasks touch UI). For each, include the install or setup command.

**Manual steps required**
List every action the user must take manually before execution can begin — API key setup, OAuth app creation, environment variable configuration, cloud resource provisioning, etc. Be specific: include where to get the credential and what env var or config file it goes into.

## What NOT to do

- Do not write any code.
- Do not create any files other than CODEBASE.md.
- Do not ask clarifying questions unless there are blocking unknowns identified in Step 3.
- Do not pad the task list with generic tasks like "write tests" or "add logging" — testing is handled by a dedicated spec phase; logging is part of implementation.
- Do not invent constraints that are not in the inputs.
