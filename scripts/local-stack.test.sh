#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# local-stack.test.sh — Test suite for `scripts/local-stack.sh reset-data`
#
# `reset-data` is the docker compose entry point for the safe local
# test-data reset (issue #629). The destructive work lives in the web
# package (`db:reset-test-data`); this suite covers the shell layer:
#   - it refuses to act (and never invokes the CLI) when postgres is down
#   - it targets the compose database via a loopback URL
#   - it forwards flags through to the package script
#   - credentials travel in the environment, never in argv
#
# Usage:
#   bash scripts/local-stack.test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_SCRIPT="${SCRIPT_DIR}/local-stack.sh"

PASS=0
FAIL=0
TOTAL=0
ORIG_DIR="$(pwd)"
TMPROOT="$(mktemp -d)"

STACK_RC=0
STACK_OUTPUT=""
FAKEBIN=""
CALL_LOG=""
# Extra environment assignments passed to a case, e.g. (DATABASE_URL=...).
STACK_EXTRA_ENV=()

cleanup() {
  cd "$ORIG_DIR" || true
  rm -rf "$TMPROOT"
}
trap cleanup EXIT

# ── Helpers ───────────────────────────────────────────────────────────

# make_fakebin <dir> — docker/pnpm stubs, prepended to the real PATH so the
# surrounding toolchain (bash, dirname) still resolves. `docker compose ps -q
# postgres` answers from FAKE_POSTGRES_RUNNING; `pnpm` records its argv and
# environment to FAKE_CALL_LOG. Any other docker call fails the stub loudly.
make_fakebin() {
  local dir="$1"
  mkdir -p "$dir"

  cat > "$dir/docker" <<'STUB'
#!/bin/sh
if [ "$1" = "compose" ] && [ "$2" = "ps" ] && [ "$3" = "-q" ] && [ "$4" = "postgres" ]; then
  [ "${FAKE_POSTGRES_RUNNING:-}" = "1" ] && echo "container-id-postgres"
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 1
STUB

  cat > "$dir/pnpm" <<'STUB'
#!/bin/sh
printf 'ARGS=%s\n' "$*" >> "${FAKE_CALL_LOG:?}"
printf 'DATABASE_URL=%s\n' "${DATABASE_URL:-}" >> "${FAKE_CALL_LOG:?}"
exit 0
STUB

  chmod +x "$dir/docker" "$dir/pnpm"
}

# stack_case <name> <postgres-running:0|1> [stack args...]
# Runs the stack script with a restricted PATH; results land in
# STACK_RC / STACK_OUTPUT / CALL_LOG.
stack_case() {
  local name="$1"
  local running="$2"
  shift 2

  FAKEBIN="$TMPROOT/$name/bin"
  CALL_LOG="$TMPROOT/$name/pnpm-calls.log"
  mkdir -p "$TMPROOT/$name"
  make_fakebin "$FAKEBIN"

  local rc=0
  STACK_OUTPUT="$(env "${STACK_EXTRA_ENV[@]}" \
    PATH="$FAKEBIN:$PATH" \
    FAKE_CALL_LOG="$CALL_LOG" \
    FAKE_POSTGRES_RUNNING="$running" \
    bash "$STACK_SCRIPT" "$@" 2>&1)" || rc=$?
  STACK_RC=$rc
}

run_test() {
  local name="$1"
  shift
  TOTAL=$((TOTAL + 1))
  if "$@"; then
    echo "  ✅ ${name}"
    PASS=$((PASS + 1))
  else
    echo "  ❌ ${name}"
    FAIL=$((FAIL + 1))
  fi
}

cli_args() {
  grep '^ARGS=' "$CALL_LOG" 2>/dev/null || true
}

# ── Test cases ────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  local-stack.sh reset-data — test suite"
echo "════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Dependency failure — postgres down → fail closed ──
echo "Test 1: postgres not running → explicit refusal, CLI never invoked"
stack_case "down" 0 reset-data --yes
t1() {
  [[ $STACK_RC -eq 1 ]] &&
    grep -qi "postgres service is not running" <<<"$STACK_OUTPUT" &&
    grep -q "pnpm stack:up" <<<"$STACK_OUTPUT" &&
    [[ ! -f "$CALL_LOG" ]]
}
run_test "postgres down → exit 1, actionable message, no mutation attempted" t1

# ── Test 2: Positive — running stack delegates with a loopback URL ──
echo ""
echo "Test 2: postgres running → delegates to db:reset-test-data on loopback"
stack_case "up" 1 reset-data --yes
t2() {
  [[ $STACK_RC -eq 0 ]] &&
    grep -qxF "ARGS=--dir web run db:reset-test-data -- --yes" "$CALL_LOG" &&
    grep -qxF "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/talos" "$CALL_LOG"
}
run_test "running stack → CLI invoked with the compose database URL" t2

# ── Test 3: Boundary — no flags forwarded when none are given ──
echo ""
echo "Test 3: no extra flags → nothing is forwarded to the CLI"
stack_case "noflags" 1 reset-data
t3() {
  [[ $STACK_RC -eq 0 ]] && grep -qxF "ARGS=--dir web run db:reset-test-data" "$CALL_LOG"
}
run_test "bare reset-data → argv ends at the script name" t3

# ── Test 4: Positive — an explicit DATABASE_URL override wins ──
echo ""
echo "Test 4: existing DATABASE_URL override is respected"
CUSTOM_URL="postgresql://postgres:postgres@localhost:5432/talos_dev"
STACK_EXTRA_ENV=("DATABASE_URL=$CUSTOM_URL")
stack_case "override" 1 reset-data --yes
STACK_EXTRA_ENV=()
t4() {
  [[ $STACK_RC -eq 0 ]] && grep -qxF "DATABASE_URL=$CUSTOM_URL" "$CALL_LOG"
}
run_test "DATABASE_URL override → used instead of the compose default" t4

# ── Test 5: Negative — unknown subcommand still fails closed ──
echo ""
echo "Test 5: unknown subcommand → usage error, CLI never invoked"
stack_case "unknown" 0 not-a-command
t5() {
  [[ $STACK_RC -eq 1 ]] &&
    grep -q "Usage:" <<<"$STACK_OUTPUT" &&
    grep -q "reset-data" <<<"$STACK_OUTPUT" &&
    [[ ! -f "$CALL_LOG" ]]
}
run_test "unknown subcommand → exit 1 + usage listing reset-data" t5

# ── Test 6: Regression — credentials stay out of argv ──
echo ""
echo "Test 6: regression — credentials never appear in the CLI argv"
stack_case "argv" 1 reset-data --yes --seed
t6() {
  [[ $STACK_RC -eq 0 ]] &&
    grep -qxF "ARGS=--dir web run db:reset-test-data -- --yes --seed" "$CALL_LOG" &&
    ! grep -q "postgresql://" <<<"$(cli_args)" &&
    ! grep -qi "password" <<<"$(cli_args)"
}
run_test "argv carries no URL or password (environment only)" t6

echo ""
echo "────────────────────────────────────────────────────────"
echo "  ${PASS}/${TOTAL} passed, ${FAIL} failed"
echo "────────────────────────────────────────────────────────"
echo ""

[[ $FAIL -eq 0 ]]
