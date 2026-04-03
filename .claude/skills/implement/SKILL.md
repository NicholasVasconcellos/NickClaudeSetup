---
name: implement
description: >
  Implement a task's features. Verify with the test script from spec phase.
  Invoked by runner via: /implement NNN
disable-model-invocation: true
---

# implement

Deliver the features described in the task. Tests are verification, not the objective.

## Input

Task number (e.g., `/implement 003`). Task file, PROJECT.md, progress.txt, and test script are injected via prompt. State file path is provided.

## Steps

1. Read injected files. Focus on Goal, Features/Functionality, Constraints.
2. If progress.txt has prior entries for this task, build on previous work — don't repeat failed approaches.
3. Implement the features. Create/modify only files in "Files to Write."
4. Run `bash tests/NNN_test.sh`. If tests fail, debug and re-run.
5. When tests pass: `git add -A && git commit -m "task NNN: implement - tests passing"`
6. Update state: `echo 'review' > <state_file_path>`

## Rules

- Implement the features, not the tests. Do not game or hardcode test expectations.
- Do NOT modify the test script. If a test seems wrong, note it in progress.txt for the review agent.
- Stay in scope. Only touch files in "Files to Write." If forced to touch another file, note it in progress.txt.
- Build on previous work. If a prior agent left notes, read them. Try what they suggested under NEXT.

## Context limit

If stuck after multiple debug cycles: stop. `git add -A && git commit -m "task NNN: implement - partial"`. Append concise notes to progress.txt (what works, what fails, exact errors, what to try next). Exit without updating state. Runner will retry with a fresh agent.

## Progress logging

After completing work, append a concise entry to progress.txt for your task. Then optionally rewrite all entries for this task into one compact summary. Never touch other tasks' entries.
