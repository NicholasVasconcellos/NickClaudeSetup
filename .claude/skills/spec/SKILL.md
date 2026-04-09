---
name: spec
description: >
  Write tests for a task based on its Acceptance Criteria.
  Invoked by runner via: /spec NNN
disable-model-invocation: true
---

# spec

Write tests from the task's Acceptance Criteria. Do NOT implement anything.

## Input

Task number (e.g., `/spec 003`). Task file, PROJECT.md, and progress.txt are injected via prompt. State file path is provided.

## Steps

1. Read injected files (PROJECT.md, task file, progress.txt).
2. If progress.txt has prior entries for this task, read them for context.
3. Determine test types needed (see Test Strategy below).
4. Write test files (see Output Files below).
5. `chmod +x tests/NNN_test.sh`
6. `git add -A && git commit -m "task NNN: spec - test files"`
7. Update state: `echo 'implement' > <state_file_path>`

## Test Strategy

Pick the right layer(s) based on what the task touches:

### Layer 1: Unit tests (ALWAYS)

Test every exported function, hook, utility, or module the task requires.

- Import the function, call it with known inputs, assert outputs.
- Mock external deps (Supabase, Anthropic, fetch) — never call live services.
- Test edge cases: empty inputs, missing fields, error states.
- Test return shapes/types, not just truthiness.

### Layer 2: API route tests (if task creates API routes)

- Call the route handler directly with mock Request objects.
- Assert status codes, response shape, error handling.
- Verify auth checks if applicable.

### Layer 3: Component tests (if task creates UI components)

- Use @testing-library/react to render components.
- Assert key elements render (by role/text, NOT implementation details).
- Simulate user interactions (click, type) and verify state changes.
- Test loading, error, and empty states.

### Layer 4: UI verification (if task touches UI — AFTER all other tests pass)

After unit/API/component tests pass, add a `## Manual UI Verification` section
at the bottom of the test script that prints step-by-step MCP instructions:

```
echo ""
echo "=== UI Verification (run with browser MCP) ==="
echo "1. Navigate to [relevant page URL]"
echo "2. Screenshot the page"
echo "3. Verify [specific component] is visible"
echo "4. Click [specific element]"
echo "5. Screenshot again"
echo "6. Verify [expected state change]"
```

The review agent uses these steps with MCP browser tools for visual verification
and error correction loops.

## Output Files

```
tests/
  NNN_test.sh          # Bash runner (thin wrapper)
  NNN/
    *.test.ts           # Vitest test files (the real tests)
    mocks.ts            # Shared mocks for this task (if needed)
```

### NNN_test.sh (wrapper)

```bash
#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo ""
echo "=== Task NNN: [Title] ==="
echo ""

# Run vitest for this task's tests
cd "$ROOT"
npx vitest run tests/NNN/ --reporter=verbose 2>&1
EXIT_CODE=$?

# UI verification instructions (if applicable)
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "=== UI Verification (run with browser MCP) ==="
  echo "1. Navigate to http://localhost:3000/[page]"
  echo "2. Screenshot and verify [component] renders"
  echo "3. Click [element], screenshot, verify [result]"
fi

exit $EXIT_CODE
```

### Test file example

```ts
// tests/NNN/prioritizer.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock external deps BEFORE importing module under test
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockSupabaseClient),
}));

import { prioritize } from "../../packages/shared/src/ai/prioritizer";

describe("prioritize()", () => {
  it("returns items sorted by score descending", async () => {
    const result = await prioritize(mockTasks);
    const scores = result.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("flags items with deadlines within 48h", async () => {
    const result = await prioritize([taskDueTomorrow]);
    expect(result[0].flags).toContain("approaching_deadline");
  });

  it("preserves user-set impact_score", async () => {
    const task = { ...mockTask, impact_score: 5 };
    const result = await prioritize([task]);
    expect(result[0].impact_score).toBe(5);
  });

  it("handles empty input", async () => {
    const result = await prioritize([]);
    expect(result).toEqual([]);
  });
});
```

## Rules

- **Test WHAT, not HOW.** Assert behavior (inputs → outputs), not implementation details.
- **Never grep for keywords.** If you're checking file contents with grep, you're doing it wrong. Import and call the code.
- **Mock everything external.** Supabase, Anthropic, fetch, env vars. Tests must run offline with no API keys.
- **Test return shapes explicitly.** Don't just check truthiness — verify the structure and types of returned data.
- **One test file per module/component.** Keep tests focused and scannable.
- **Do NOT create source files, stubs, or scaffolding.** Only test files and mocks.
- **Exit 0 on all pass, non-zero on any failure.**

## Vitest Config

If `vitest.config.ts` doesn't exist at repo root, create a minimal one:

```ts
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom", // for component tests
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./packages/shared/src"),
      "@web": path.resolve(__dirname, "./apps/web"),
    },
  },
});
```

Also ensure `vitest` is in root devDependencies. If not, add it.

## Context limit

If context is getting heavy: commit what you have, append concise notes to progress.txt for this task, exit without updating state. Runner will retry.

## Progress logging

After completing work, append a concise entry to progress.txt for your task. Then optionally rewrite all entries for this task (yours + any prior agents') into one compact summary. Never touch other tasks' entries.
