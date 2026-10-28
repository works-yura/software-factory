#!/usr/bin/env bash
# LIVE CHECK — SPENDS YOUR CLAUDE SUBSCRIPTION.
#
# Runs the server end-to-end scenario (tests/e2e/server/claude-chat.e2e.test.ts)
# with the REAL `claude` CLI instead of the fake: the dev server (`dev:local`)
# on a scratch database and sandbox root, a Claude Code Factory on the fake
# GitLab repository, a personal chat that calls a Factory tool over MCP, a Write
# that parks on permission, and Allow resuming it. The Factory runs on
# `--model haiku` to keep the cost down (a few cents per run on an API key;
# a handful of messages on a subscription).
#
# The server's HOME is a scratch directory with your Claude Code login linked
# in (~/.claude, ~/.claude.json, ~/Library/Keychains), so `claude` runs as you
# and records its session in your ~/.claude like any other run. Nothing in
# ~/.mastracode is touched.
#
# Not part of `verify` or `e2e`. Usage (from the repo root):
#   scripts/live-claude-check.sh          # asks before spending anything
#   scripts/live-claude-check.sh --yes    # no prompt
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

cat >&2 <<'EOF'
==============================================================================
 LIVE Claude Code check: this runs the REAL `claude` CLI (model: haiku) and
 spends your Claude subscription / API credits. It is NOT part of verify.
==============================================================================
EOF

if ! command -v claude >/dev/null 2>&1; then
  echo "live-claude-check: no \`claude\` on PATH; install Claude Code and sign in first." >&2
  exit 1
fi
echo "Using $(command -v claude) ($(claude --version 2>/dev/null || echo 'unknown version'))" >&2

if [[ "${1:-}" != "--yes" ]]; then
  read -r -p "Spend Claude usage on a live run? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Cancelled." >&2; exit 1; }
fi

# The server must run the real CLI: never inherit a fake from the environment.
unset FACTORY_CLAUDE_CODE_COMMAND
export FACTORY_E2E_LIVE=1

cd "$root/tests/e2e"
if command -v timeout >/dev/null 2>&1; then
  exec timeout "${FACTORY_LIVE_TIMEOUT_S:-900}" corepack pnpm exec vitest run --config vitest.live.config.ts
fi
exec corepack pnpm exec vitest run --config vitest.live.config.ts
