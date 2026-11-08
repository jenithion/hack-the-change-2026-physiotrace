#!/usr/bin/env bash
# Creates ../<repo>-<name> on branch feat/<name> with its own ports and installed dependencies.
set -euo pipefail
name="${1:?Usage: scripts/worktree.sh <name>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/../$(basename "$root")-$name"

[ -f "$root/.env" ] || { echo "No .env in $root. Fill it in first."; exit 1; }

# Take the first port pair that no other worktree uses: 3000/8000, 3001/8001, and so on.
used="$(git -C "$root" worktree list --porcelain | sed -n 's/^worktree //p' \
  | while read -r d; do grep -h '^WEB_PORT=' "$d/.env" 2>/dev/null || true; done)"
i=0
while echo "$used" | grep -qx "WEB_PORT=$((3000 + i))"; do i=$((i + 1)); done
web=$((3000 + i)); api=$((8000 + i))

if git -C "$root" show-ref --verify --quiet "refs/heads/feat/$name"; then
  git -C "$root" worktree add "$dir" "feat/$name"
else
  git -C "$root" worktree add -b "feat/$name" "$dir"
fi

cp "$root/.env" "$dir/.env"
sed -i.bak \
  -e "s|^WEB_PORT=.*|WEB_PORT=$web|" \
  -e "s|^API_PORT=.*|API_PORT=$api|" \
  -e "s|^NEXT_PUBLIC_API_URL=.*|NEXT_PUBLIC_API_URL=http://127.0.0.1:$api|" \
  -e "s|^CORS_ORIGINS=.*|CORS_ORIGINS=http://localhost:$web|" \
  "$dir/.env"
rm "$dir/.env.bak"

(cd "$dir/frontend" && npm ci)
(cd "$dir/backend" && uv sync)

echo "Ready: $dir (web :$web, api :$api)"
echo "Run it with: cd $dir && ./scripts/dev.sh"
