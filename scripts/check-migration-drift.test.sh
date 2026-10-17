#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# check-migration-drift.test.sh — Fixture suite for migration drift gate
#
# Builds temporary drizzle trees covering positive, negative, boundary,
# and malformed-input cases, then asserts exit codes from
# scripts/check-migration-drift.mjs.
#
# Usage:
#   bash scripts/check-migration-drift.test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="${SCRIPT_DIR}/check-migration-drift.mjs"
PASS=0
FAIL=0
TOTAL=0
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/migration-drift-XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

if [[ ! -f "$CHECK_SCRIPT" ]]; then
  echo "missing check script: $CHECK_SCRIPT" >&2
  exit 1
fi

assert_exit() {
  local name="$1"
  local expected="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  set +e
  local out
  out="$("$@" 2>&1)"
  local code=$?
  set -e
  if [[ "$code" -eq "$expected" ]]; then
    PASS=$((PASS + 1))
    echo "PASS  $name (exit $code)"
  else
    FAIL=$((FAIL + 1))
    echo "FAIL  $name (expected exit $expected, got $code)" >&2
    echo "$out" >&2
  fi
}

make_fixture() {
  local dir="$1"
  mkdir -p "$dir/meta"
  # Always include bootstrap unless caller overrides by deleting it.
  printf '%s\n' '-- bootstrap' >"$dir/bootstrap-roles.sql"
}

write_journal() {
  local dir="$1"
  local body="$2"
  printf '%s\n' "$body" >"$dir/meta/_journal.json"
}

# ── 1. Positive: clean journal + matching SQL ─────────────────────────
FIX1="$TMP_ROOT/clean"
make_fixture "$FIX1"
printf 'SELECT 1;\n' >"$FIX1/0000_init.sql"
printf 'SELECT 2;\n' >"$FIX1/0001_next.sql"
write_journal "$FIX1" '{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {"idx": 0, "version": "7", "when": 1, "tag": "0000_init", "breakpoints": true},
    {"idx": 1, "version": "7", "when": 2, "tag": "0001_next", "breakpoints": true}
  ]
}'
assert_exit "clean journal passes" 0 node "$CHECK_SCRIPT" --drizzle-dir "$FIX1"

# ── 2. Negative: journal tag missing SQL (fail closed) ────────────────
FIX2="$TMP_ROOT/missing-sql"
make_fixture "$FIX2"
printf 'SELECT 1;\n' >"$FIX2/0000_init.sql"
write_journal "$FIX2" '{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {"idx": 0, "version": "7", "when": 1, "tag": "0000_init", "breakpoints": true},
    {"idx": 1, "version": "7", "when": 2, "tag": "0001_missing", "breakpoints": true}
  ]
}'
assert_exit "missing SQL fails" 1 node "$CHECK_SCRIPT" --drizzle-dir "$FIX2"

# ── 3. Negative: malformed journal JSON ───────────────────────────────
FIX3="$TMP_ROOT/malformed"
make_fixture "$FIX3"
printf '{not-json' >"$FIX3/meta/_journal.json"
assert_exit "malformed journal fails" 1 node "$CHECK_SCRIPT" --drizzle-dir "$FIX3"

# ── 4. Boundary: empty entries array ──────────────────────────────────
FIX4="$TMP_ROOT/empty-entries"
make_fixture "$FIX4"
write_journal "$FIX4" '{"version":"7","dialect":"postgresql","entries":[]}'
assert_exit "empty entries fails" 1 node "$CHECK_SCRIPT" --drizzle-dir "$FIX4"

# ── 5. Negative: duplicate idx ────────────────────────────────────────
FIX5="$TMP_ROOT/dup-idx"
make_fixture "$FIX5"
printf 'SELECT 1;\n' >"$FIX5/0000_a.sql"
printf 'SELECT 2;\n' >"$FIX5/0001_b.sql"
write_journal "$FIX5" '{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {"idx": 0, "version": "7", "when": 1, "tag": "0000_a", "breakpoints": true},
    {"idx": 0, "version": "7", "when": 2, "tag": "0001_b", "breakpoints": true}
  ]
}'
assert_exit "duplicate idx fails" 1 node "$CHECK_SCRIPT" --drizzle-dir "$FIX5"

# ── 6. Ambiguous CLI input ────────────────────────────────────────────
assert_exit "unknown flag fails closed (exit 2)" 2 node "$CHECK_SCRIPT" --nope
assert_exit "missing --drizzle-dir value fails closed (exit 2)" 2 node "$CHECK_SCRIPT" --drizzle-dir

# ── 7. Orphan SQL: warn by default, fail under --strict ───────────────
FIX7="$TMP_ROOT/orphan"
make_fixture "$FIX7"
printf 'SELECT 1;\n' >"$FIX7/0000_init.sql"
printf 'SELECT 9;\n' >"$FIX7/0009_orphan.sql"
write_journal "$FIX7" '{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {"idx": 0, "version": "7", "when": 1, "tag": "0000_init", "breakpoints": true}
  ]
}'
assert_exit "orphan warns but passes (default)" 0 node "$CHECK_SCRIPT" --drizzle-dir "$FIX7"
assert_exit "orphan fails under --strict" 1 node "$CHECK_SCRIPT" --strict --drizzle-dir "$FIX7"

# ── 8. Prefix collision under --strict ────────────────────────────────
FIX8="$TMP_ROOT/collision"
make_fixture "$FIX8"
printf 'SELECT 1;\n' >"$FIX8/0001_one.sql"
printf 'SELECT 2;\n' >"$FIX8/0001_two.sql"
write_journal "$FIX8" '{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {"idx": 0, "version": "7", "when": 1, "tag": "0001_one", "breakpoints": true}
  ]
}'
assert_exit "prefix collision fails under --strict" 1 node "$CHECK_SCRIPT" --strict --drizzle-dir "$FIX8"

# ── 9. Missing drizzle directory ──────────────────────────────────────
assert_exit "missing dir fails" 1 node "$CHECK_SCRIPT" --drizzle-dir "$TMP_ROOT/does-not-exist"

# ── 10. Regression: real repo drizzle (structural) when present ───────
REPO_DRIZZLE="${SCRIPT_DIR}/../web/drizzle"
if [[ -d "$REPO_DRIZZLE" ]]; then
  assert_exit "repo drizzle structural check" 0 node "$CHECK_SCRIPT" --drizzle-dir "$REPO_DRIZZLE"
else
  echo "SKIP  repo drizzle structural check (web/drizzle not present in this checkout)"
fi

echo
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
exit 0
