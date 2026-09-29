#!/usr/bin/env bash
# Start the local backend (TCBS account features) and the Vite dev server together.
# Ctrl+C stops both. Override the interpreter with PYTHON=/path/to/python3.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for candidate in /usr/bin/python3 python3; do
    if "$candidate" -c "import fastapi, requests, numpy" >/dev/null 2>&1; then PY="$candidate"; break; fi
  done
fi
if [ -z "$PY" ]; then
  echo "No Python with fastapi/requests/numpy found. Run: pip install -r backend/requirements.txt" >&2
  exit 1
fi

"$PY" backend/server.py &
BACKEND=$!
trap 'kill $BACKEND 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 1 60); do
  curl -s -o /dev/null http://localhost:8000/docs && break
  sleep 0.5
done
echo "Backend ready on :8000 ($PY) — starting Vite"
npx vite
