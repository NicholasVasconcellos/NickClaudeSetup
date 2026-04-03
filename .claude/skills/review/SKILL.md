---
name: review
description: >
  Review and clean up a task implementation. Run regression. Mark task done.
  Invoked by runner via: /review NNN
disable-model-invocation: true
---

# review

Clean up the code, enforce conventions, run regression, finalize the task.

## Input

Task number (e.g., `/review 003`). Task file, PROJECT.md, progress.txt, and test script are injected via prompt. State file path is provided.

## Steps

1. Read injected files. Focus on PROJECT.md conventions.
2. Review all changed files (check `git diff --name-only` against the base branch).
3. Clean up: remove dead code, debug logs, unused imports. Enforce naming/style from PROJECT.md.
4. Run `bash tests/NNN_test.sh` — task tests must pass after cleanup.
5. Run `bash tests/run_all.sh` — regression must pass.
6. If either fails, fix without breaking the other.
7. Finalize in one commit:
   ```bash
   git add -A && git commit -m "task NNN: [task title]"
   ```
8. Update state: `echo 'done' > <state_file_path>`

## Rules

- Do NOT add features. Simplify and clean only.
- Do NOT modify test scripts unless they have an obvious bug (wrong path, typo). Note any test changes in progress.txt.
- Preserve behavior. If cleanup breaks a test, the cleanup was wrong.
- Flag files modified outside "Files to Write" — keep only if justified.

## Context limit

If stuck after multiple fix cycles: `git add -A && git commit -m "task NNN: review - partial"`. Append concise notes to progress.txt. Exit without updating state. Runner will retry.

## Progress logging

After completing work, append a concise entry to progress.txt for your task. Then optionally rewrite all entries for this task into one compact summary. Never touch other tasks' entries.
