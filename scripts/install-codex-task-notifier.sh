#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE="${CODEX_TASK_NOTIFIER_SOURCE:-$REPO_ROOT/plugins/codex-task-notifier}"
DRY_RUN="false"

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="true"
elif [[ $# -gt 0 ]]; then
  echo "usage: $0 [--dry-run]" >&2
  exit 2
fi

node "$SCRIPT_DIR/install-codex-task-notifier.mjs" "$SOURCE" "$DRY_RUN"
