---
name: execute
description: >
  Implement a specific task from the tasks/ directory. Reads the task file, implements
  the code, writes and runs tests, debugs failures, and commits on success. Invoked by
  the runner script or manually via: /execute NNN (where NNN is the task number).
  This skill is project-agnostic — all project context comes from PROJECT.md.
disable-model-invocation: true
---

# execute

Implement a single task, write its tests, debug until passing, run regression, and commit.

## Input

A task number passed as an argument (e.g., `/execute 003`). The corresponding file is `tasks/003.md`.

## Execution Steps

### 1. Load context

- Read `PROJECT.md` for project-level context (tech stack, conventions, structure).
- Read `tasks/NNN.md` for the task specification.
- Read `progress.txt` — check if previous agents left notes about this task (partial work, known issues, decisions). If there are entries for this task, absorb that context before starting.
- Read every file listed in "Files to Read" in the task file.

### 2. Implement the task

- Follow the steps in the task file.
- Create or modify only the files listed in "Files to Write."
- You are not prohibited from reading or writing other files, but you should rarely need to. Everything you need should be in the specified files. If you find yourself exploring the codebase, stop — re-read the task file and PROJECT.md.
- If you must touch an unlisted file (e.g., a build error requires fixing an import), note it in your progress.txt entry.

### 3. Write the test script

- The task file has a "Test Suggestions" section. Use it to write an executable test script.
- Save it to the path specified in "Files to Write" (convention: `tests/NNN_short_name.sh`).
- Make it executable: `chmod +x tests/NNN_short_name.sh`.
- Test scripts must:
  - Be self-contained (run with just `bash tests/NNN_short_name.sh`)
  - Be verbose — print what is being tested and pinpoint exact failure location
  - Exit 0 on success, non-zero on failure
  - Follow this pattern:

```bash
#!/bin/bash
set -e
PASS=0; FAIL=0; ERRORS=""

assert() {
  local description="$1"
  shift
  if eval "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    echo "  ✓ $description"
  else
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS\n  ✗ $description\n    command: $*"
    echo "  ✗ $description"
    echo "    command: $*"
  fi
}

assert_file_exists() {
  assert "File exists: $1" "[ -f '$1' ]"
}

assert_file_contains() {
  assert "File $1 contains '$2'" "grep -q '$2' '$1'"
}

echo ""
echo "=== Test NNN: [Task Title] ==="
echo ""

# -- Tests go here --
assert_file_exists "src/example.ts"
assert "TypeScript compiles" "npx tsc --noEmit"
assert "Server starts" "timeout 5 node dist/server.js &>/dev/null"

# -- Summary --
echo ""
if [ $FAIL -gt 0 ]; then
  echo "FAILED: $PASS passed, $FAIL failed"
  echo -e "$ERRORS"
  exit 1
else
  echo "PASSED: $PASS passed"
  exit 0
fi
```

### 4. Run the task test

Run the test script you just wrote: `bash tests/NNN_short_name.sh`

**If it passes:** proceed to step 5.

**If it fails:** enter the debug loop (step 4a).

### 4a. Debug loop

When a test fails:

1. Read the test output carefully. Identify the exact failure.
2. Fix the issue in the relevant source file.
3. Re-run the test.
4. Repeat until the test passes.

**Self-monitoring:** If you've been through multiple debug cycles without resolution, or you notice your responses becoming repetitive or unfocused, it's time to exit gracefully:

- Stop debugging.
- Commit your current work: `git add -A && git commit -m "task NNN: partial progress"`
- Append to `progress.txt` (see step 7 format) with status `incomplete`, including:
  - What you implemented
  - What's failing and your best guess at the root cause
  - What the next agent should try
- Exit. The runner will pick this task up again with a fresh agent that reads your notes.

Do NOT keep spinning. A fresh agent with your notes is more effective than a stale context grinding on the same error.

### 5. Run regression

Run `bash tests/run_all.sh` to execute all existing test scripts.

**If regression passes:** proceed to step 6.

**If regression fails:** a previous task's tests are broken. This means your changes introduced a regression.
- Read the failing test output.
- Fix the regression without breaking your current task's tests.
- Re-run `bash tests/run_all.sh`.
- If you can't resolve the regression after a few attempts, log it in progress.txt and exit gracefully (same as the debug loop exit in 4a).

### 6. Mark task done, log progress, and commit

Do all of this in a **single atomic commit** to avoid race conditions with the runner script:

1. Create the done marker: `touch tasks/status/NNN.done`
2. Append to `progress.txt`:

```
=== Task NNN | Status: complete | $(date '+%Y-%m-%d %H:%M:%S') ===
CHANGES: [Brief summary of what was implemented]
NOTES: [Any gotchas, decisions, or context for future agents. Omit if nothing notable.]
```

3. Stage and commit everything together:

```bash
touch tasks/status/NNN.done
git add -A
git commit -m "task NNN: [task title]"
```

The commit must include: source code changes, the test script, `progress.txt` updates, and the `tasks/status/NNN.done` marker. **Everything in one commit.** Do not split the done marker into a separate commit — the runner script checks for the `.done` file immediately after the agent exits, and a gap between commits creates a window where the task appears incomplete.

### 8. Verify clean state

Run `git status --porcelain`. If anything is uncommitted, stage and commit it.

## Rules

- **One task per invocation.** Do not read other task files. Do not work ahead.
- **Files to Read is your starting point, not a restriction.** You have everything you need there. If a build error forces you to read another file, read the direct dependency (one hop) and stop. Don't explore.
- **Write tests before declaring victory.** The task is not done until the test script exists AND passes AND regression passes.
- **Commit atomically.** Source changes, test script, and progress log go in together. Don't leave partial commits.
- **Log generously to progress.txt.** The next agent's only lifeline is your notes. Be specific about what works, what doesn't, and what to try next.
- **Exit gracefully when stuck.** A fresh agent with your notes is better than an exhausted context producing garbage. Commit partial work, log findings, and stop.
