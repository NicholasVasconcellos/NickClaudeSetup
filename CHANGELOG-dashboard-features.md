# Dashboard Feature Expansion — Changelog

14 features added to the orchestration dashboard in a single session, implemented via parallel subagents on isolated git worktrees.

## Execution Summary

- **Tasks**: 14 total, 3 waves of parallel execution
- **Wave 1** (independent): WS Protocol, DAG Improvements, Skill Editor, File Tree
- **Wave 2** (after WS Protocol): Plan Editor, Execute Button, Human Review Backend, Add Task UI, Inline Prompt
- **Wave 3** (after Wave 2 deps): Review UI, Branch Viz, Suggestions, Skill Variations, Planning Chat
- **Peak concurrency**: 9 agents running simultaneously
- **Both packages typecheck clean** after all changes merged

---

## Features Implemented

### 1. WS Protocol Extension
**Files**: `types.ts`, `ws-server.ts`

Extended the WebSocket protocol with 19 new bidirectional events to support all new features. Added `plan:load`, `run:start`, `task:create`, `task:approve`, `prompt:submit`, `skills:list/get/save`, `files:tree` client events. Added `plan:loaded`, `run:started`, `task:created`, `task:needs_review`, `prompt:response`, `suggestion:new`, `branch:update`, `skills:list_result`, `skills:content`, `files:tree_result` server events. Added `mode: "automated" | "human_review"` to OrchestratorConfig.

### 2. Plan Editor / Upload
**Files**: NEW `PlanEditor.tsx`, modified `page.tsx`, `useWebSocket.ts`

Collapsible panel above the DAG with a monospace markdown textarea. Supports file upload via drag-and-drop or click. "Load Plan" button sends plan content to the backend which parses it into tasks. Shows success indicator with task count after loading.

### 3. Execute Button + Mode Selector
**Files**: modified `Controls.tsx`, `page.tsx`, `useWebSocket.ts`

Added Execute section to the sidebar controls with "Automated" / "Human Review" radio toggle. Execute button sends `run:start` with selected mode. Button disables with pulse animation while run is active, re-enables on completion.

### 4. Human Review Mode (Backend)
**Files**: modified `runner.ts`, `git.ts`

Added approval gate in the runner: when mode is `human_review`, tasks pause after reaching "done" state and emit `task:needs_review` with git diff and agent log summary. Waits for `task:approve` before proceeding to merge. Also added `plan:load` handler (markdown parser that creates tasks from `###` headings), `run:start` handler, and `task:create` handler. Added `getWorktreeDiff()` and `getWorktreeDiffVsMain()` to GitManager.

### 5. Human Review UI
**Files**: NEW `ReviewPanel.tsx`, modified `page.tsx`, `useWebSocket.ts`

Full-width review panel that appears when a task needs approval. Shows git diff with syntax coloring (+green/-red/@@cyan), agent log summary tab, and Approve/Reject buttons. Pending reviews tracked in useWebSocket state and auto-cleared on state transitions.

### 6. DAG Visualization Improvements
**Files**: rewritten `TaskGraph.tsx`

Replaced simple done/active grouping with proper topological sort-based DAG layout using `dependsOn` data. Tasks retain their positions across re-renders via a `useRef` position cache. Graph expands right as new layers activate with auto-scroll. Pending tasks are hidden. Dependency lines drawn from actual `dependsOn` arrays instead of between adjacent layers.

### 7. Git Branch Visualization
**Files**: NEW `BranchGraph.tsx`, modified `page.tsx`, `runner.ts`, `useWebSocket.ts`

SVG-based horizontal branch graph above the DAG. Shows main branch line with branch-off points for each task. Branches color-coded: blue (created), green (merged). Branch labels below each segment. Aligned with DAG columns via shared topological position computation. Backend emits `branch:update` events on worktree create/merge/delete.

### 8. Add Task UI
**Files**: NEW `AddTaskForm.tsx`, modified `page.tsx`, `useWebSocket.ts`

Modal form triggered by "+" button in header. Form fields: title (required with validation), description, milestone, effort dropdown, and dependency multi-select with checkboxes showing existing tasks. Creates task via WS and closes on submit. Overlay closes on Escape or backdrop click.

### 9. Inline Prompt
**Files**: NEW `InlinePrompt.tsx`, modified `page.tsx`, `useWebSocket.ts`

Compact prompt input in the task detail panel. Users can send prompts to a task's agent with "Continue" or "New Thread" mode toggle. Send button and Enter key submission. Displays last response below the input with accent left-border styling. Responses tracked per-task in useWebSocket state.

### 10. Feature Suggestions
**Files**: NEW `Suggestions.tsx`, modified `runner.ts`, `page.tsx`, `useWebSocket.ts`

After task merge, runner spawns a low-effort Claude agent to suggest 1-3 follow-up features. Suggestions saved as markdown files to `.orchestrator/suggestions/` and broadcast via WS. Sidebar component displays suggestion cards with title and description. Fire-and-forget (doesn't block merge pipeline).

### 11. Skill Editor UI
**Files**: NEW `SkillEditor.tsx`, NEW `skills/page.tsx`, modified `ws-server.ts`, `useWebSocket.ts`

New `/skills` page listing all skills from `.claude/skills/*/SKILL.md`. Backend handlers for `skills:list`, `skills:get`, `skills:save` with file I/O (unicast responses to requesting client). Frontend editor with monospace textarea, line/char count, save button with confirmation flash. Left sidebar for skill selection with variation badges.

### 12. Skill Variations
**Files**: modified `SkillEditor.tsx`, `skills/page.tsx`, `ws-server.ts`, `types.ts`, `useWebSocket.ts`

Version tabs per skill: "Active" + variation tabs (v1, v2, etc.). "Save as New Version" auto-generates next version number. "Set Active" button copies a variation to `SKILL.md`. Backend handlers for `skills:save_variation` and `skills:activate`. Variations stored as `SKILL.v1.md`, `SKILL.v2.md` alongside `SKILL.md`.

### 13. Planning Chat Interface
**Files**: NEW `PlanningChat.tsx`, modified `page.tsx`

Chat UI toggled via "Planning Chat" button in header. User/assistant message bubbles with timestamps. Assistant messages can include clickable option buttons (auto-parsed from bullet/numbered lists). Typing indicator with animated dots. Textarea input with Enter-to-send. Uses `prompt:submit` with taskId=0 for planning-scoped conversations.

### 14. Working Files Tree
**Files**: NEW `FileTree.tsx`, modified `ws-server.ts`, `page.tsx`, `useWebSocket.ts`

Collapsible file tree in sidebar. Backend recursively reads project directory (max depth 4), excludes node_modules/.next/dist/.git etc. Frontend renders collapsible directory nodes with expand/collapse arrows, file indicators, and changed-file highlighting. Requested on WS connection.

---

## File Summary

### New Files (10)
- `packages/dashboard/src/components/AddTaskForm.tsx`
- `packages/dashboard/src/components/BranchGraph.tsx`
- `packages/dashboard/src/components/FileTree.tsx`
- `packages/dashboard/src/components/InlinePrompt.tsx`
- `packages/dashboard/src/components/PlanEditor.tsx`
- `packages/dashboard/src/components/PlanningChat.tsx`
- `packages/dashboard/src/components/ReviewPanel.tsx`
- `packages/dashboard/src/components/SkillEditor.tsx`
- `packages/dashboard/src/components/Suggestions.tsx`
- `packages/dashboard/src/app/skills/page.tsx`

### Modified Files (9)
- `packages/dashboard/src/app/page.tsx` (+243 lines)
- `packages/dashboard/src/components/Controls.tsx` (+79 lines)
- `packages/dashboard/src/components/TaskGraph.tsx` (rewritten)
- `packages/dashboard/src/hooks/useWebSocket.ts` (+146 lines)
- `packages/orchestrator/src/types.ts` (+27 lines)
- `packages/orchestrator/src/ws-server.ts` (+215 lines)
- `packages/orchestrator/src/runner.ts` (+219 lines)
- `packages/orchestrator/src/git.ts` (+20 lines)

### Total: ~1,143 lines added across modified files + ~1,500 lines in new files
