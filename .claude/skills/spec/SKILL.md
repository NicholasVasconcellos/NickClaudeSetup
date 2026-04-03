---
name: spec
description: >
  Write a test script for a task based on its Acceptance Criteria.
  Invoked by runner via: /spec NNN
disable-model-invocation: true
---

# spec

Write `tests/NNN_test.sh` from the task's Acceptance Criteria. Do NOT implement anything.

## Input

Task number (e.g., `/spec 003`). Task file, PROJECT.md, and progress.txt are injected via prompt. State file path is provided.

## Steps

1. Read injected files (PROJECT.md, task file, progress.txt).
2. If progress.txt has prior entries for this task, read them for context.
3. Write `tests/NNN_test.sh` — one or more assertions per acceptance criterion.
4. `chmod +x tests/NNN_test.sh`
5. `git add -A && git commit -m "task NNN: spec - test script"`
6. Update state: `echo 'implement' > <state_file_path>`

## Rules

- Test WHAT, not HOW. Verify outcomes without assuming implementation approach.
- Do NOT create source files, stubs, or scaffolding. Only the test script.
- Script must be self-contained: `bash tests/NNN_test.sh` runs everything.
- Exit 0 on all pass, non-zero on any failure. Print clear pass/fail per assertion.

## Context limit

If context is getting heavy: commit what you have, append concise notes to progress.txt for this task, exit without updating state. Runner will retry.

## Progress logging

After completing work, append a concise entry to progress.txt for your task. Then optionally rewrite all entries for this task (yours + any prior agents') into one compact summary. Never touch other tasks' entries.

## Test pattern

```bash
#!/bin/bash
set -e
PASS=0; FAIL=0; ERRORS=""

assert() {
  local desc="$1"; shift
  if eval "$@" >/dev/null 2>&1; then
    PASS=$((PASS + 1)); echo "  ✓ $desc"
  else
    FAIL=$((FAIL + 1))
    ERRORS="$ERRORS\n  ✗ $desc\n    cmd: $*"
    echo "  ✗ $desc"
  fi
}

echo ""
echo "=== Task NNN: [Title] ==="
echo ""

assert "description" "command to test"

echo ""
if [ $FAIL -gt 0 ]; then
  echo "FAILED: $PASS passed, $FAIL failed"
  echo -e "$ERRORS"
  exit 1
else
  echo "PASSED: $PASS passed"
fi
```
