#!/usr/bin/env bash
# Runs the offline trainer for therapist-defined exercises. Stop with Ctrl+C.
# It claims queued exercises from Supabase and fits their template models.
set -euo pipefail
cd "$(dirname "$0")/../backend"
[ -f ../.env ] || { echo "No .env found. Run: cp .env.example .env, then fill it in."; exit 1; }
uv run --group ml python ../ml/worker.py "$@"
