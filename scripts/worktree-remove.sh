#!/usr/bin/env bash
# Removes ../<repo>-<name>. Commit or push your work first: uncommitted changes in it are lost.
set -euo pipefail
name="${1:?Usage: scripts/worktree-remove.sh <name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/../$(basename "$root")-$name"

# .env and node_modules are git-ignored and safe to delete. --force would also drop uncommitted edits,
# so remove them first and let git refuse if real changes are left.
rm -rf "$dir/.env" "$dir/frontend/node_modules" "$dir/frontend/.next" "$dir/backend/.venv"
git -C "$root" worktree remove "$dir"
git -C "$root" branch -d "feat/$name" || echo "Branch feat/$name kept: it has commits that are not merged into this checkout's branch."
