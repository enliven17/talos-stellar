#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# deploy.test.sh — Test suite for contracts/deploy.sh argument parsing
#
# contracts/deploy.sh previously computed SOURCE with
# SOURCE="${@:$((${#@}+1))}", an index one past the end of the argument
# list, so `--source <key>` silently fell back to an empty string. This
# suite exercises the replacement `while [[ $# -gt 0 ]]; case` loop via
# DRY_RUN=1 (which prints the resolved NETWORK/SOURCE and exits before
# building or touching the network).
#
# Usage:
#   bash scripts/deploy.test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_SCRIPT="${SCRIPT_DIR}/../contracts/deploy.sh"

PASS=0
FAIL=0
TOTAL=0

DEPLOY_RC=0
DEPLOY_OUTPUT=""

# ── Helpers ───────────────────────────────────────────────────────────

# deploy_case <deploy.sh args...> — runs the script with DRY_RUN=1;
# results land in DEPLOY_RC / DEPLOY_OUTPUT.
deploy_case() {
  local rc=0
  DEPLOY_OUTPUT="$(DRY_RUN=1 bash "$DEPLOY_SCRIPT" "$@" 2>&1)" || rc=$?
  DEPLOY_RC=$rc
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

# ── Test cases ────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  deploy.sh — test suite"
echo "════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Syntax check ──
echo "Test 1: bash -n syntax check"
t1() {
  bash -n "$DEPLOY_SCRIPT"
}
run_test "deploy.sh parses cleanly (bash -n)" t1

# ── Test 2: --source sets SOURCE (the regression this issue fixes) ──
echo ""
echo "Test 2: --source foo sets SOURCE to foo"
deploy_case testnet --source foo
t2() {
  [[ $DEPLOY_RC -eq 0 ]] &&
    grep -qxF "NETWORK=testnet" <<<"$DEPLOY_OUTPUT" &&
    grep -qxF "SOURCE=foo" <<<"$DEPLOY_OUTPUT"
}
run_test "testnet --source foo → SOURCE=foo" t2

# ── Test 3: No flags keeps the default key ──
echo ""
echo "Test 3: No flags keeps the deployer default"
deploy_case
t3() {
  [[ $DEPLOY_RC -eq 0 ]] &&
    grep -qxF "NETWORK=testnet" <<<"$DEPLOY_OUTPUT" &&
    grep -qxF "SOURCE=deployer" <<<"$DEPLOY_OUTPUT"
}
run_test "no args → NETWORK=testnet, SOURCE=deployer" t3

# ── Test 4: --source without a value exits non-zero with usage ──
echo ""
echo "Test 4: --source with no value → usage + non-zero exit"
deploy_case --source
t4() {
  [[ $DEPLOY_RC -ne 0 ]] && grep -qi "usage:" <<<"$DEPLOY_OUTPUT"
}
run_test "--source (missing value) → non-zero exit + usage" t4

# ── Test 5: --source as the trailing argument with nothing after it ──
echo ""
echo "Test 5: --source trailing after network, no value → usage + non-zero exit"
deploy_case mainnet --source
t5() {
  [[ $DEPLOY_RC -ne 0 ]] && grep -qi "usage:" <<<"$DEPLOY_OUTPUT"
}
run_test "mainnet --source (missing value) → non-zero exit + usage" t5

# ── Test 6: Unknown flag → usage + non-zero exit ──
echo ""
echo "Test 6: Unknown flag → usage + non-zero exit"
deploy_case --bogus
t6() {
  [[ $DEPLOY_RC -ne 0 ]] && grep -qi "usage:" <<<"$DEPLOY_OUTPUT"
}
run_test "unknown flag → non-zero exit + usage" t6

# ── Test 7: mainnet network is honored alongside --source ──
echo ""
echo "Test 7: mainnet network with --source"
deploy_case mainnet --source mykey
t7() {
  [[ $DEPLOY_RC -eq 0 ]] &&
    grep -qxF "NETWORK=mainnet" <<<"$DEPLOY_OUTPUT" &&
    grep -qxF "SOURCE=mykey" <<<"$DEPLOY_OUTPUT"
}
run_test "mainnet --source mykey → NETWORK=mainnet, SOURCE=mykey" t7

# ── Test 8: --source may precede the positional network argument ──
echo ""
echo "Test 8: --source before the positional network argument"
deploy_case --source mykey mainnet
t8() {
  [[ $DEPLOY_RC -eq 0 ]] &&
    grep -qxF "NETWORK=mainnet" <<<"$DEPLOY_OUTPUT" &&
    grep -qxF "SOURCE=mykey" <<<"$DEPLOY_OUTPUT"
}
run_test "--source mykey mainnet → NETWORK=mainnet, SOURCE=mykey" t8

# ── Test 9: Unknown network name is rejected rather than silently used ──
echo ""
echo "Test 9: Unknown positional argument → usage + non-zero exit"
deploy_case devnet
t9() {
  [[ $DEPLOY_RC -ne 0 ]] && grep -qi "usage:" <<<"$DEPLOY_OUTPUT"
}
run_test "unrecognized network → non-zero exit + usage" t9

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Results: ${PASS}/${TOTAL} passed, ${FAIL} failed"
echo "════════════════════════════════════════════════════════"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  echo "❌ Some tests failed."
  exit 1
fi

echo "✅ All tests passed."
exit 0
