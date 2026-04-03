#!/bin/bash
set -euo pipefail

echo "Setting up workspace..."

# ─── Directories ───
mkdir -p tasks/status tasks/merge-queue tests .worktrees logs

# ─── .claude/settings.json (merge, don't overwrite) ───
mkdir -p .claude
if [ -f .claude/settings.json ]; then
  if command -v jq &>/dev/null; then
    jq '. + {"thinkingEnabled": true}' .claude/settings.json > .claude/settings.tmp && mv .claude/settings.tmp .claude/settings.json
  fi
else
  echo '{"thinkingEnabled": true}' > .claude/settings.json
fi

# ─── .gitignore (base patterns, agent appends stack-specific) ───
if [ ! -f .gitignore ]; then
  cat > .gitignore << 'GIEOF'
# OS
.DS_Store
Thumbs.db

# Editor
.idea/
.vscode/
*.swp
*~

# Secrets
.env
.env.*

# Workspace (runner-managed)
.worktrees/
logs/
tasks/merge-queue/
tasks/status/*.state
GIEOF
fi

# ─── progress.txt ───
cat > progress.txt << 'PEOF'
# Progress Log
# Format:
#   === Task NNN | Phase: spec/implement/review | Status: complete/partial | [timestamp] ===
#   CHANGES: ...
#   ISSUES: ...
#   NEXT: ...

PEOF

# ─── tests/run_all.sh ───
cat > tests/run_all.sh << 'TEOF'
#!/bin/bash
set -e
TESTS_DIR="$(dirname "$0")"
PASS=0; TOTAL=0

echo ""
echo "========================================"
echo "  Running All Tests"
echo "========================================"
echo ""

for test_file in "$TESTS_DIR"/[0-9]*.sh; do
  [ -e "$test_file" ] || continue
  TOTAL=$((TOTAL + 1))
  TEST_NAME=$(basename "$test_file" .sh)
  echo "--- $TEST_NAME ---"
  if bash "$test_file"; then
    PASS=$((PASS + 1)); echo "  PASS"
  else
    echo "  FAIL: $test_file"
    echo "Stopped. $PASS/$TOTAL passed."
    exit 1
  fi
  echo ""
done

echo "========================================"
echo "  All $TOTAL tests passed."
echo "========================================"
TEOF
chmod +x tests/run_all.sh

# ─── run-tasks.sh ───
cat > run-tasks.sh << 'REOF'
#!/bin/bash
set -euo pipefail

# ─── Config (override via env) ───
TASKS_DIR="tasks"
STATUS_DIR="$TASKS_DIR/status"
MANIFEST="$TASKS_DIR/manifest.json"
MERGE_QUEUE="$TASKS_DIR/merge-queue"
WORKTREE_BASE=".worktrees"
LOG_DIR="logs"
MAIN_DIR="$(pwd)"

SPEC_MODEL="${SPEC_MODEL:-sonnet}"
SPEC_EFFORT="${SPEC_EFFORT:-high}"
IMPLEMENT_MODEL="${IMPLEMENT_MODEL:-opus}"
IMPLEMENT_EFFORT="${IMPLEMENT_EFFORT:-high}"
REVIEW_MODEL="${REVIEW_MODEL:-sonnet}"
REVIEW_EFFORT="${REVIEW_EFFORT:-high}"
MERGE_MODEL="${MERGE_MODEL:-opus}"
MERGE_EFFORT="${MERGE_EFFORT:-high}"
MAX_RETRIES="${MAX_RETRIES:-3}"
DEFAULT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo main)

# ─── Validation ───
for cmd in jq claude git; do
  command -v "$cmd" &>/dev/null || { echo "!! $cmd required."; exit 1; }
done
[ -f "$MANIFEST" ] || { echo "!! $MANIFEST not found."; exit 1; }

mkdir -p "$STATUS_DIR" "$MERGE_QUEUE" "$LOG_DIR"

if ! git log --oneline -1 &>/dev/null 2>&1; then
  git add -A 2>/dev/null || true
  git commit --allow-empty -m "initial commit"
fi

# Validate manifest structure
TASK_COUNT=$(jq '.tasks | length' "$MANIFEST" 2>/dev/null) || { echo "!! Invalid manifest JSON."; exit 1; }
[ "$TASK_COUNT" -gt 0 ] || { echo "!! No tasks in manifest."; exit 1; }

# Check all task files exist
jq -r '.tasks[].id' "$MANIFEST" | while read -r id; do
  [ -f "$TASKS_DIR/$id.md" ] || { echo "!! Missing task file: $TASKS_DIR/$id.md"; exit 1; }
done

# Initialize state files (default: spec)
jq -r '.tasks[].id' "$MANIFEST" | while read -r id; do
  [ -f "$STATUS_DIR/$id.state" ] || echo "spec" > "$STATUS_DIR/$id.state"
done

# ─── Topological sort → execution layers ───
compute_layers() {
  local remaining=$(jq -r '.tasks[].id' "$MANIFEST")
  local done_ids=""

  while [ -n "$(echo "$remaining" | tr -d '[:space:]')" ]; do
    local layer=""
    local next=""

    for tid in $remaining; do
      local deps=$(jq -r --arg id "$tid" '.tasks[] | select(.id == $id) | .depends_on[]' "$MANIFEST" 2>/dev/null)
      local met=true
      for dep in $deps; do
        echo "$done_ids" | grep -qw "$dep" || { met=false; break; }
      done
      if $met; then
        layer="$layer $tid"
      else
        next="$next $tid"
      fi
    done

    layer=$(echo "$layer" | xargs)
    [ -z "$layer" ] && { echo "!! Circular dependency detected." >&2; exit 1; }
    echo "$layer"
    done_ids="$done_ids $layer"
    remaining="$next"
  done
}

# ─── Parse extra files to read from task file ───
get_extra_files() {
  local task_file="$1"
  local wt_dir="$2"
  sed -n '/^## Files to Read/,/^##/p' "$task_file" | grep '^\- ' | sed 's/^- //' | while read -r f; do
    case "$f" in PROJECT.md|tasks/*|progress.txt) continue ;; esac
    [ -f "$wt_dir/$f" ] && printf "@%s " "$f"
  done
}

# ─── Run all phases for a single task ───
run_task() {
  local TASK_ID="$1"
  local STATUS_FILE="$MAIN_DIR/$STATUS_DIR/${TASK_ID}.state"
  local TASK_TITLE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .title' "$MANIFEST")
  local BRANCH="task/${TASK_ID}"
  local WT="$MAIN_DIR/$WORKTREE_BASE/task-${TASK_ID}"

  echo ">> Task $TASK_ID: $TASK_TITLE"

  local STATE=$(cat "$STATUS_FILE")
  [ "$STATE" = "merged" ] && { echo "** Already merged. Skipping."; return 0; }

  # If done but not merged, skip to merge queue
  if [ "$STATE" = "done" ]; then
    echo "** Already done. Queuing merge."
    touch "$MAIN_DIR/$MERGE_QUEUE/$TASK_ID"
    return 0
  fi

  # Create worktree
  git branch -D "$BRANCH" 2>/dev/null || true
  rm -rf "$WT"
  git worktree add "$WT" -b "$BRANCH"

  local BASE="@PROJECT.md @tasks/${TASK_ID}.md @progress.txt"
  local EXTRA=$(get_extra_files "$WT/tasks/${TASK_ID}.md" "$WT")

  # ── Phase 1: Spec ──
  local ATTEMPT=0
  while [ "$(cat "$STATUS_FILE")" = "spec" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    [ $ATTEMPT -gt "$MAX_RETRIES" ] && { echo "!! Spec failed after $MAX_RETRIES attempts."; return 1; }
    [ $ATTEMPT -gt 1 ] && echo "-- Spec retry $ATTEMPT/$MAX_RETRIES"
    claude --dangerously-skip-permissions --model "$SPEC_MODEL" --effort "$SPEC_EFFORT" -p \
      "/spec $TASK_ID
State file: $STATUS_FILE
When done: echo 'implement' > $STATUS_FILE

$BASE $EXTRA" \
      --cwd "$WT"
  done
  echo "** Spec complete."

  # Add test file to injected files for remaining phases
  EXTRA="$(get_extra_files "$WT/tasks/${TASK_ID}.md" "$WT") @tests/${TASK_ID}_test.sh"

  # ── Phase 2: Implement ──
  ATTEMPT=0
  while [ "$(cat "$STATUS_FILE")" = "implement" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    [ $ATTEMPT -gt "$MAX_RETRIES" ] && { echo "!! Implement failed after $MAX_RETRIES attempts."; return 1; }
    [ $ATTEMPT -gt 1 ] && echo "-- Implement retry $ATTEMPT/$MAX_RETRIES"
    claude --dangerously-skip-permissions --model "$IMPLEMENT_MODEL" --effort "$IMPLEMENT_EFFORT" -p \
      "/implement $TASK_ID
State file: $STATUS_FILE
When tests pass: echo 'review' > $STATUS_FILE

$BASE $EXTRA" \
      --cwd "$WT"
  done
  echo "** Implement complete."

  # ── Phase 3: Review ──
  ATTEMPT=0
  while [ "$(cat "$STATUS_FILE")" = "review" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    [ $ATTEMPT -gt "$MAX_RETRIES" ] && { echo "!! Review failed after $MAX_RETRIES attempts."; return 1; }
    [ $ATTEMPT -gt 1 ] && echo "-- Review retry $ATTEMPT/$MAX_RETRIES"
    claude --dangerously-skip-permissions --model "$REVIEW_MODEL" --effort "$REVIEW_EFFORT" -p \
      "/review $TASK_ID
State file: $STATUS_FILE
When done: echo 'done' > $STATUS_FILE

$BASE $EXTRA" \
      --cwd "$WT"
  done
  echo "** Review complete."

  # Final commit if uncommitted changes remain
  (cd "$WT" && git add -A && git diff --cached --quiet || git commit -m "task $TASK_ID: $TASK_TITLE") 2>/dev/null || true

  # Queue for merge
  touch "$MAIN_DIR/$MERGE_QUEUE/$TASK_ID"
  echo "** Task $TASK_ID queued for merge."
}

# ─── Merge one task branch into main ───
merge_task() {
  local TASK_ID="$1"
  local STATUS_FILE="$MAIN_DIR/$STATUS_DIR/${TASK_ID}.state"
  local TASK_TITLE=$(jq -r --arg id "$TASK_ID" '.tasks[] | select(.id == $id) | .title' "$MANIFEST")
  local BRANCH="task/${TASK_ID}"
  local WT="$MAIN_DIR/$WORKTREE_BASE/task-${TASK_ID}"

  echo "-- Merging task $TASK_ID..."

  if git merge "$BRANCH" --no-ff -m "merge task $TASK_ID: $TASK_TITLE"; then
    echo "** Merged $TASK_ID."
  else
    echo "-- Conflict on $TASK_ID. Resolving..."
    local CONFLICTED=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
    claude --dangerously-skip-permissions --model "$MERGE_MODEL" --effort "$MERGE_EFFORT" -p \
      "Resolve merge conflicts in: $CONFLICTED
Read git log for context. Keep both sides. Remove all conflict markers.
git add each file. git commit --no-edit." || {
      echo "!! Conflict resolution failed for $TASK_ID."
      git merge --abort 2>/dev/null || true
      return 1
    }
    echo "** Conflict resolved for $TASK_ID."
  fi

  echo "merged" > "$STATUS_FILE"
  git worktree remove "$WT" --force 2>/dev/null || true
  git branch -d "$BRANCH" 2>/dev/null || true
  rm -f "$MAIN_DIR/$MERGE_QUEUE/$TASK_ID"
}

# ─── Compute layers ───
LAYERS=$(compute_layers)
LAYER_NUM=0

echo ""
echo "========================================"
echo "  Execution Plan"
echo "========================================"
while IFS= read -r l; do
  LAYER_NUM=$((LAYER_NUM + 1))
  echo "  Layer $LAYER_NUM: $l"
done <<< "$LAYERS"
echo "========================================"
echo ""

# ─── Execute layer by layer ───
LAYER_NUM=0
while IFS= read -r layer; do
  LAYER_NUM=$((LAYER_NUM + 1))
  [ -z "$(echo "$layer" | tr -d '[:space:]')" ] && continue

  echo ""
  echo "========================================"
  echo "  Layer $LAYER_NUM: $layer"
  echo "========================================"

  # Verify all deps are merged
  for tid in $layer; do
    deps=$(jq -r --arg id "$tid" '.tasks[] | select(.id == $id) | .depends_on[]' "$MANIFEST" 2>/dev/null)
    for dep in $deps; do
      [ "$(cat "$STATUS_DIR/$dep.state" 2>/dev/null)" = "merged" ] || {
        echo "!! Dependency $dep not merged for task $tid."
        exit 1
      }
    done
  done

  # Launch tasks in parallel
  PID_LIST=()
  TID_LIST=()
  for tid in $layer; do
    state=$(cat "$STATUS_DIR/$tid.state")
    [ "$state" = "merged" ] && continue

    run_task "$tid" > "$LOG_DIR/$tid.log" 2>&1 &
    PID_LIST+=($!)
    TID_LIST+=("$tid")
    echo "-- Started task $tid (PID: ${PID_LIST[-1]})"
  done

  # Merge queue loop (background)
  MERGE_STOP="$MAIN_DIR/.merge_stop_$$"
  rm -f "$MERGE_STOP"
  (
    while true; do
      for f in $(ls "$MAIN_DIR/$MERGE_QUEUE" 2>/dev/null | sort); do
        merge_task "$f" >> "$LOG_DIR/merge.log" 2>&1
      done
      [ -f "$MERGE_STOP" ] && [ -z "$(ls -A "$MAIN_DIR/$MERGE_QUEUE" 2>/dev/null)" ] && break
      sleep 2
    done
  ) &
  MERGE_PID=$!

  # Wait for all task workers
  LAYER_OK=true
  for i in "${!PID_LIST[@]}"; do
    if wait "${PID_LIST[$i]}"; then
      echo "** Task ${TID_LIST[$i]} completed."
    else
      echo "!! Task ${TID_LIST[$i]} failed. See $LOG_DIR/${TID_LIST[$i]}.log"
      LAYER_OK=false
    fi
  done

  # Drain merge queue and stop
  touch "$MERGE_STOP"
  wait "$MERGE_PID" 2>/dev/null || true
  rm -f "$MERGE_STOP"

  # Verify all layer tasks merged
  for tid in $layer; do
    state=$(cat "$STATUS_DIR/$tid.state" 2>/dev/null)
    if [ "$state" != "merged" ] && [ "$state" != "spec" ]; then
      # Task was attempted but not fully merged
      [ "$LAYER_OK" = true ] || continue
    fi
  done

  if ! $LAYER_OK; then
    echo ""
    echo "!! Layer $LAYER_NUM had failures. Stopping."
    break
  fi
done <<< "$LAYERS"

# ─── Final status ───
echo ""
echo "========================================"
echo "  Final Status"
echo "========================================"
jq -r '.tasks[].id' "$MANIFEST" | while read -r id; do
  title=$(jq -r --arg id "$id" '.tasks[] | select(.id == $id) | .title' "$MANIFEST")
  state=$(cat "$STATUS_DIR/$id.state" 2>/dev/null || echo "unknown")
  echo "  $id: $title — $state"
done
echo "========================================"
REOF
chmod +x run-tasks.sh

# ─── Git init if needed ───
if ! git rev-parse --git-dir &>/dev/null 2>&1; then
  git init
fi

echo ""
echo "Workspace ready. Run /getTasks to populate tasks from plan.md."
