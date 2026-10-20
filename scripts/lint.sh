#!/usr/bin/env bash
# ── lint wrapper ───────────────────────────────────────────────────────────
# Tries oxlint first, then eslint (oxlint sigills with 132 on some hosts).
# Either is run through bun when node is not on PATH: the hook's own shell has
# neither on some hosts, and a tool that cannot be started is not a tool that
# passed. Flags pass through unchanged.
#
# A tree with no linter installed passes, and says so. A tree that has one it
# cannot run fails — that is an environment fault, not a clean lint.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Present, and something here can start it (node via the shebang, or bun).
can_run() {
  local bin="$1"
  [ -e "$bin" ] || [ -L "$bin" ] || return 1
  command -v bun >/dev/null 2>&1 || return 1
  bun "$bin" --version >/dev/null 2>&1
}

installed() { [ -e "$1" ] || [ -L "$1" ]; }

for tool in oxlint eslint; do
  bin="$ROOT/node_modules/.bin/$tool"
  can_run "$bin" || continue
  # Smoke test — 132 means the binary sigilled, which bun does not fix; the
  # other linter gets its turn instead.
  if "$bin" --version >/dev/null 2>&1; then
    exec "$bin" "$@"
  fi
  exec bun "$bin" "$@"
done

for tool in oxlint eslint; do
  bin="$ROOT/node_modules/.bin/$tool"
  if installed "$bin"; then
    echo "lint: $tool is installed but cannot be run (no node on PATH, no bun) — refusing to report a clean lint" >&2
    exit 1
  fi
done

echo "lint: no linter installed in this tree — nothing to check" >&2
exit 0
