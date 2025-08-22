#!/usr/bin/env bash

set -euo pipefail

# Runs the Vite dev server for the editor UI and the Tauri shell together.
# Assumes dependencies are already installed:
# - UI: editor/ui has node_modules (run `npm install` there beforehand)
# - Tauri: Rust toolchain installed for `cargo run`

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"/.. && pwd)"
UI_DIR="$ROOT_DIR/editor/ui"
TAURI_DIR="$ROOT_DIR/editor/tauri"

# Configurable port; must match editor/tauri/tauri.conf.json devPath
PORT="${PORT:-5173}"

vite_pid=""

cleanup() {
  if [[ -n "${vite_pid}" ]] && ps -p "${vite_pid}" >/dev/null 2>&1; then
    echo "\nStopping Vite (pid ${vite_pid})..."
    kill "${vite_pid}" 2>/dev/null || true
    # Give it a moment to exit
    sleep 1 || true
  fi
}

trap cleanup EXIT INT TERM

echo "Starting Vite dev server (port ${PORT})..."
(
  cd "$UI_DIR"
  # Respect PORT if Vite is configured to read it
  PORT="$PORT" npm run dev
) &
vite_pid=$!

# Lightweight wait for dev server to be reachable
echo -n "Waiting for Vite to be reachable"
for i in {1..60}; do
  if curl -sSf "http://127.0.0.1:${PORT}" >/dev/null 2>&1; then
    echo " — up!"
    break
  fi
  echo -n "."
  sleep 0.5
done
echo

echo "Starting Tauri shell..."
cd "$TAURI_DIR"
cargo run

