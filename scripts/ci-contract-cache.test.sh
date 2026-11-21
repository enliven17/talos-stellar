#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# ci-contract-cache.test.sh — Test suite for ci-contract-cache.sh
#
# Covers the issue #635 cache behaviors with focused cases:
#   positive  — a valid restored cache entry validates as a hit and the
#               built artifacts pass verification
#   negative  — malformed/corrupted cache entries are detected, wiped,
#               and classified as a miss without failing the job; invalid
#               or missing artifacts fail verification closed
#   boundary  — changing a contract build input changes the cache key
#               hash, so stale entries can never be reused
#   regression— the cold → build → verify → warm cycle a CI job performs,
#               plus wiring checks that every workflow which builds wasm
#               artifacts uses these helpers
#
# Retry/dependency-failure behavior (continue-on-error on the
# actions/cache steps) lives in the workflow YAML and is asserted by the
# wiring tests below.
#
# Usage:
#   bash scripts/ci-contract-cache.test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE_SCRIPT="${SCRIPT_DIR}/ci-contract-cache.sh"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PASS=0
FAIL=0
TOTAL=0

# ── Helpers ───────────────────────────────────────────────────────────

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

# Run a cache-script subcommand, capturing stdout+stderr and exit code.
# Sets RC and OUT. Never trips set -e.
run_cache() {
  local rc=0
  OUT=$(bash "$CACHE_SCRIPT" "$@" 2>&1) || rc=$?
  RC=$rc
}

# Same, but with GITHUB_OUTPUT pointed at a temp file (as GitHub Actions
# does) so tests can assert on the step outputs the workflows consume.
run_cache_gh() {
  local ghout="$1"
  shift
  local rc=0
  OUT=$(GITHUB_OUTPUT="$ghout" bash "$CACHE_SCRIPT" "$@" 2>&1) || rc=$?
  RC=$rc
}

# Create a temp dir with a valid fake wasm artifact (wasm magic + payload).
make_valid_dir() {
  local dir="$1"
  mkdir -p "$dir"
  printf '\0asm\1\0\0\0payload' >"$dir/talos_registry.wasm"
  printf '\0asm\1\0\0\0payload' >"$dir/talos_name_service.wasm"
}

# Create a minimal contracts fixture tree for key-hash tests.
make_contracts_fixture() {
  local dir="$1"
  mkdir -p "$dir/src" "$dir/.cargo"
  printf '[workspace]\nmembers = []\n' >"$dir/Cargo.toml"
  printf '[[package]]\nname = "fixture"\nversion = "0.1.0"\n' >"$dir/Cargo.lock"
  printf 'pub fn build_input() {}\n' >"$dir/src/lib.rs"
  printf '[profile.release]\nopt-level = "z"\n' >>"$dir/Cargo.toml"
  printf '[target.wasm32-unknown-unknown]\nrunner = "true"\n' >"$dir/.cargo/config.toml"
  printf '[features]\nwhatever = []\n' >"$dir/soroban-config.toml"
}

assert_eq() {
  [ "$1" = "$2" ]
}

assert_contains() {
  case "$1" in
  *"$2"*) return 0 ;;
  *) return 1 ;;
  esac
}

# ── Test cases ────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ci-contract-cache.sh — test suite"
echo "════════════════════════════════════════════════════════"
echo ""

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ── key-hash: dependency-failure / ambiguous input fails closed ──
echo "key-hash — fail-closed on missing/ambiguous input"

run_cache key-hash
run_test "key-hash with no argument → exit 1" assert_eq "$RC" 1

run_cache key-hash "$TMP/does-not-exist" "$TMP"
run_test "key-hash with two arguments → exit 1" assert_eq "$RC" 1

run_cache key-hash "$TMP/does-not-exist"
run_test "key-hash missing contracts dir → exit 1 (fail closed)" assert_eq "$RC" 1

mkdir -p "$TMP/no-lock"
printf '[workspace]\n' >"$TMP/no-lock/Cargo.toml"
run_cache key-hash "$TMP/no-lock"
run_test "key-hash without Cargo.lock → exit 1 (fail closed)" assert_eq "$RC" 1

mkdir -p "$TMP/no-src"
printf '[workspace]\n' >"$TMP/no-src/Cargo.toml"
printf 'lock\n' >"$TMP/no-src/Cargo.lock"
run_cache key-hash "$TMP/no-src"
run_test "key-hash without *.rs sources → exit 1 (fail closed)" assert_eq "$RC" 1

run_cache bogus-cmd
run_test "unknown subcommand → exit 1" assert_eq "$RC" 1

echo ""
echo "key-hash — valid input"

make_contracts_fixture "$TMP/fx1"
run_cache key-hash "$TMP/fx1"
KEY1="$OUT"
run_test "key-hash on valid fixture → exit 0, 64-hex output" \
  bash -c "[ '$RC' -eq 0 ] && printf '%s' '$KEY1' | grep -Eq '^[0-9a-f]{64}$'"

run_cache key-hash "$TMP/fx1"
run_test "key-hash is deterministic for identical inputs" assert_eq "$KEY1" "$OUT"

# ── boundary: changed input ⇒ changed key ⇒ cache miss ──
echo ""
echo "boundary — changed contract input invalidates the key"

printf 'pub fn build_input() { /* edited */ }\n' >"$TMP/fx1/src/lib.rs"
run_cache key-hash "$TMP/fx1"
KEY2="$OUT"
run_test "editing a source file changes the key hash" \
  bash -c "[ '$RC' -eq 0 ] && [ '$KEY1' != '$KEY2' ]"
run_test "both key hashes are distinct valid keys (guard accepts new key)" \
  bash -c "printf '%s\n%s\n' '$KEY1' '$KEY2' | grep -Eq '^[0-9a-f]{64}$' && [ '$KEY1' != '$KEY2' ]"

# Lockfile change (dependency bump) also invalidates.
run_cache key-hash "$TMP/fx1"
cp "$TMP/fx1/Cargo.lock" "$TMP/fx1/Cargo.lock.bak"
printf '[[package]]\nname = "fixture"\nversion = "0.2.0"\n' >"$TMP/fx1/Cargo.lock"
run_cache key-hash "$TMP/fx1"
KEY3="$OUT"
run_test "editing Cargo.lock changes the key hash" \
  bash -c "[ '$RC' -eq 0 ] && [ '$KEY2' != '$KEY3' ]"

# Generated code under target/ must NOT affect the key (it is build
# output, not a build input) — keeps the key stable across rebuilds.
run_cache key-hash "$TMP/fx1"
mkdir -p "$TMP/fx1/target/debug/build/fixture-out"
printf 'fn generated() {}\n' >"$TMP/fx1/target/debug/build/fixture-out/output.rs"
run_cache key-hash "$TMP/fx1"
run_test "target/ build output does not change the key hash" assert_eq "$KEY3" "$OUT"

# ── validate: positive (cache hit) ──
echo ""
echo "validate — positive: usable restored cache"

make_valid_dir "$TMP/hit"
GITHUB_OUTPUT_FILE="$TMP/gh_output_hit"
: >"$GITHUB_OUTPUT_FILE"
run_cache_gh "$GITHUB_OUTPUT_FILE" validate "$TMP/hit"
run_test "valid artifacts → exit 0" assert_eq "$RC" 0
run_test "valid artifacts → cache_status=hit, cache_usable=true" \
  bash -c "grep -q 'cache_status=hit' '$GITHUB_OUTPUT_FILE' && grep -q 'cache_usable=true' '$GITHUB_OUTPUT_FILE'"
run_test "valid artifacts are left in place (not wiped)" \
  bash -c "[ -s '$TMP/hit/talos_registry.wasm' ] && [ -s '$TMP/hit/talos_name_service.wasm' ]"
run_test "validate output is privacy-safe (file names only, no contents)" \
  bash -c "! printf '%s' '$OUT' | grep -q 'payload'"

# ── validate: negative (missing / cold cache) ──
echo ""
echo "validate — negative: cold/missing cache is a graceful miss"

run_cache validate "$TMP/never-existed"
run_test "missing directory → exit 0 (cold cache, not a failure)" assert_eq "$RC" 0
run_test "missing directory → cache_status=miss" assert_contains "$OUT" "cache_status=miss"

mkdir -p "$TMP/emptydir"
run_cache validate "$TMP/emptydir"
run_test "empty directory → exit 0, cache_status=miss" \
  bash -c "[ '$RC' -eq 0 ] && printf '%s' '$OUT' | grep -q 'cache_status=miss'"

# ── validate: negative (malformed / corrupted entry) ──
echo ""
echo "validate — negative: corrupted cache entry treated as a miss"

mkdir -p "$TMP/corrupt-empty"
printf '\0asm\1\0\0\0' >"$TMP/corrupt-empty/good.wasm"
: >"$TMP/corrupt-empty/zero.wasm"
run_cache validate "$TMP/corrupt-empty"
run_test "zero-byte *.wasm → exit 0 (does not fail the job)" assert_eq "$RC" 0
run_test "zero-byte *.wasm → cache_status=corrupt" assert_contains "$OUT" "cache_status=corrupt"
run_test "corrupted entry wiped so the rebuild starts clean" \
  bash -c "[ ! -e '$TMP/corrupt-empty' ]"
run_test "corruption warning logged" assert_contains "$OUT" "::warning::"

mkdir -p "$TMP/corrupt-magic"
printf 'this is not wasm at all' >"$TMP/corrupt-magic/talos_registry.wasm"
run_cache validate "$TMP/corrupt-magic"
run_test "wrong-magic *.wasm → exit 0, cache_status=corrupt" \
  bash -c "[ '$RC' -eq 0 ] && printf '%s' '$OUT' | grep -q 'cache_status=corrupt'"
run_test "wrong-magic entry wiped" bash -c "[ ! -e '$TMP/corrupt-magic' ]"

mkdir -p "$TMP/corrupt-mixed"
printf '\0asm\1\0\0\0' >"$TMP/corrupt-mixed/ok.wasm"
printf 'garbage' >"$TMP/corrupt-mixed/bad.wasm"
run_cache validate "$TMP/corrupt-mixed"
run_test "one bad artifact among good ones → whole entry treated as corrupt" \
  bash -c "[ '$RC' -eq 0 ] && printf '%s' '$OUT' | grep -q 'cache_status=corrupt' && [ ! -e '$TMP/corrupt-mixed' ]"

# ── validate: ambiguous input fails closed ──
echo ""
echo "validate — ambiguous input fails closed"

run_cache validate
run_test "validate with no argument → exit 1" assert_eq "$RC" 1

printf 'not a dir' >"$TMP/a-file"
run_cache validate "$TMP/a-file"
run_test "validate with a regular file path → exit 1 (fail closed)" assert_eq "$RC" 1

# ── verify: positive ──
echo ""
echo "verify — positive: built artifacts pass the gate"

make_valid_dir "$TMP/verify-ok"
run_cache verify "$TMP/verify-ok"
run_test "valid artifacts → verify exit 0" assert_eq "$RC" 0
run_test "verify reports artifact count" assert_contains "$OUT" "verified 2 contract artifact(s)"

# ── verify: negative ──
echo ""
echo "verify — negative: missing/invalid artifacts fail closed"

run_cache verify "$TMP/verify-missing"
run_test "missing artifact dir → verify exit 1 (fail closed)" assert_eq "$RC" 1
run_test "missing artifact dir → actionable ::error:: message" assert_contains "$OUT" "::error::"

mkdir -p "$TMP/verify-empty"
run_cache verify "$TMP/verify-empty"
run_test "empty artifact dir → verify exit 1" assert_eq "$RC" 1

mkdir -p "$TMP/verify-zero"
: >"$TMP/verify-zero/talos_registry.wasm"
run_cache verify "$TMP/verify-zero"
run_test "zero-byte artifact → verify exit 1" assert_eq "$RC" 1

mkdir -p "$TMP/verify-magic"
printf 'nope' >"$TMP/verify-magic/talos_registry.wasm"
run_cache verify "$TMP/verify-magic"
run_test "non-wasm artifact → verify exit 1" assert_eq "$RC" 1

run_cache verify
run_test "verify with no argument → exit 1 (fail closed)" assert_eq "$RC" 1

# ── regression: full cold → build → verify → warm cycle ──
echo ""
echo "regression — cold → build → verify → warm cycle (as CI runs it)"

COLD="$TMP/cycle"
GH_CYCLE="$TMP/gh_cycle"
# 1. cold restore → miss
: >"$GH_CYCLE"
run_cache_gh "$GH_CYCLE" validate "$COLD"
STEP1=$RC
STEP1_STATUS=$(grep -o 'cache_status=[a-z]*' "$GH_CYCLE" | head -1 || true)
# 2. simulate the build producing artifacts
make_valid_dir "$COLD"
# 3. post-build verify gate
run_cache verify "$COLD"
STEP3=$RC
# 4. next run: same entry now validates as a hit
: >"$GH_CYCLE"
run_cache_gh "$GH_CYCLE" validate "$COLD"
STEP4=$RC
STEP4_STATUS=$(grep -o 'cache_status=[a-z]*' "$GH_CYCLE" | head -1 || true)
run_test "cycle: cold cache → miss, exit 0" \
  bash -c "[ '$STEP1' -eq 0 ] && [ '$STEP1_STATUS' = 'cache_status=miss' ]"
run_test "cycle: build output passes verify" assert_eq "$STEP3" 0
run_test "cycle: rebuilt entry validates as a hit" \
  bash -c "[ '$STEP4' -eq 0 ] && [ '$STEP4_STATUS' = 'cache_status=hit' ]"

# ── regression: workflows stay wired to the helpers ──
echo ""
echo "regression — workflow wiring (cache steps present where wasm is built)"

wired() {
  local wf="$1"
  local path="${REPO_ROOT}/.github/workflows/${wf}"
  [ -f "$path" ] || return 1
  grep -q 'ci-contract-cache.sh key-hash' "$path" &&
    grep -q 'ci-contract-cache.sh validate' "$path" &&
    grep -q 'ci-contract-cache.sh verify' "$path" &&
    grep -q 'actions/cache/restore@v4' "$path" &&
    grep -q 'actions/cache/save@v4' "$path" &&
    grep -q 'continue-on-error: true' "$path"
}

nonfatal_restore_save() {
  # flaky restore/save must not fail the job: both cache steps carry
  # continue-on-error: true near their restore/save usage
  local wf="$1"
  local path="${REPO_ROOT}/.github/workflows/${wf}"
  awk '
    /uses: actions\/cache\/(restore|save)@v4/ { want=1; next }
    want && /continue-on-error: true/ { found=1; want=0 }
    want && /^      - name:/ { want=0 }
    END { exit(found ? 0 : 1) }
  ' "$path"
}

run_test "contracts-ci.yml wired (guard/restore/validate/build/verify/save)" wired "contracts-ci.yml"
run_test "ci.yml wired (cross-package matrix contracts job)" wired "ci.yml"
run_test "release-publish.yml wired (release automation)" wired "release-publish.yml"
run_test "sbom-provenance.yml wired (security checks)" wired "sbom-provenance.yml"
run_test "contracts-ci.yml restore/save are non-fatal (continue-on-error)" nonfatal_restore_save "contracts-ci.yml"
run_test "ci.yml restore/save are non-fatal (continue-on-error)" nonfatal_restore_save "ci.yml"
run_test "release-publish.yml restore/save are non-fatal" nonfatal_restore_save "release-publish.yml"
run_test "sbom-provenance.yml restore/save are non-fatal" nonfatal_restore_save "sbom-provenance.yml"

# Cache paths must stay scoped to the wasm build output — never the whole
# working tree, .env, or config files.
scoped_paths() {
  local wf path
  for wf in contracts-ci.yml ci.yml release-publish.yml sbom-provenance.yml; do
    path="${REPO_ROOT}/.github/workflows/${wf}"
    grep -A5 'uses: actions/cache/\(restore\|save\)@v4' "$path" | grep -q 'contracts/target/wasm32-unknown-unknown/release' || return 1
    # no cache step may reference .env or a bare wildcard over the repo
    ! grep -A5 'uses: actions/cache/\(restore\|save\)@v4' "$path" | grep -Eq 'path: (\*|\.env|\./)' || return 1
  done
  return 0
}
run_test "cached paths scoped to contracts/target/.../release only" scoped_paths

# ── Summary ───────────────────────────────────────────────────────────
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
