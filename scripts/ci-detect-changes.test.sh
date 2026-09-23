#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# ci-detect-changes.test.sh — Test suite for ci-detect-changes.sh
#
# Creates lightweight temporary git repos with synthetic commits,
# runs the detection script, and validates the JSON output.
#
# Usage:
#   bash scripts/ci-detect-changes.test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECT_SCRIPT="${SCRIPT_DIR}/ci-detect-changes.sh"

PASS=0
FAIL=0
TOTAL=0
ORIG_DIR="$(pwd)"

# ── Helpers ───────────────────────────────────────────────────────────

# Create a temp git repo with a base commit.
# Changes directory INTO the new repo. Caller must cd back.
create_repo() {
  local tmpdir
  tmpdir=$(mktemp -d)
  cd "$tmpdir"
  git init -q
  git config user.email "test@test.com"
  git config user.name "Test"
  echo "base" > README.md
  git add README.md
  git commit -q -m "base commit"
}

# Create a commit that touches the given file paths (space-separated)
add_commit() {
  local paths="$1"
  local msg="${2:-test commit}"
  for p in $paths; do
    mkdir -p "$(dirname "$p")"
    echo "change: $p" > "$p"
    git add "$p"
  done
  git commit -q -m "$msg"
}

# Run the detect script and capture stdout + exit code
run_detect() {
  local base="$1"
  local head="$2"
  local output
  local rc=0
  output=$(BASE_SHA="$base" HEAD_SHA="$head" bash "$DETECT_SCRIPT" 2>/dev/null) || rc=$?
  echo "$output"
  return $rc
}

# Assert the JSON matrix contains a specific package
assert_has_package() {
  local json="$1"
  local pkg="$2"
  if echo "$json" | grep -q "\"package\":\"${pkg}\""; then
    return 0
  fi
  return 1
}

# Assert the JSON matrix does NOT contain a specific package
assert_not_has_package() {
  local json="$1"
  local pkg="$2"
  if echo "$json" | grep -q "\"package\":\"${pkg}\""; then
    return 1
  fi
  return 0
}

# Assert the JSON matrix is empty (no includes)
assert_empty_matrix() {
  local json="$1"
  if echo "$json" | grep -q '"include":\[\]'; then
    return 0
  fi
  return 1
}

# Assert the JSON matrix has all 4 packages
assert_all_packages() {
  local json="$1"
  assert_has_package "$json" "web" &&
    assert_has_package "$json" "sdk" &&
    assert_has_package "$json" "prime-agent" &&
    assert_has_package "$json" "contracts"
}

# Run a test case
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
echo "  ci-detect-changes.sh — test suite"
echo "════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Web-only change ──
echo "Test 1: Web-only change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx" "web change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "prime-agent" &&
    assert_not_has_package "$RESULT" "contracts"
) && run_test "web-only → web" true || run_test "web-only → web" false
cd "$ORIG_DIR"

# ── Test 2: SDK-only change ──
echo ""
echo "Test 2: SDK-only change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "packages/sdk/src/index.ts" "sdk change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "prime-agent" &&
    assert_not_has_package "$RESULT" "contracts"
) && run_test "sdk-only → sdk" true || run_test "sdk-only → sdk" false
cd "$ORIG_DIR"

# ── Test 3: Prime-agent-only change ──
echo ""
echo "Test 3: Prime-agent-only change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "packages/prime-agent/src/talos_agent/main.py" "agent change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "prime-agent" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "contracts"
) && run_test "prime-agent-only → prime-agent" true || run_test "prime-agent-only → prime-agent" false
cd "$ORIG_DIR"

# ── Test 4: Contracts-only change ──
echo ""
echo "Test 4: Contracts-only change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "contracts/talos_registry/src/lib.rs" "contracts change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "contracts" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "prime-agent"
) && run_test "contracts-only → contracts" true || run_test "contracts-only → contracts" false
cd "$ORIG_DIR"

# ── Test 5: Web + SDK change ──
echo ""
echo "Test 5: Web + SDK change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx packages/sdk/src/index.ts" "web+sdk change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "web" &&
    assert_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "prime-agent" &&
    assert_not_has_package "$RESULT" "contracts"
) && run_test "web+sdk → web, sdk" true || run_test "web+sdk → web, sdk" false
cd "$ORIG_DIR"

# ── Test 6: SDK + Contracts change ──
echo ""
echo "Test 6: SDK + Contracts change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "packages/sdk/src/types.ts contracts/talos_name_service/src/lib.rs" "sdk+contracts change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "sdk" &&
    assert_has_package "$RESULT" "contracts" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "prime-agent"
) && run_test "sdk+contracts → sdk, contracts" true || run_test "sdk+contracts → sdk, contracts" false
cd "$ORIG_DIR"

# ── Test 7: Root package.json (shared config) ──
echo ""
echo "Test 7: Root package.json change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "package.json" "root config change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "package.json → ALL" true || run_test "package.json → ALL" false
cd "$ORIG_DIR"

# ── Test 8: .github change → ALL ──
echo ""
echo "Test 8: .github change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit ".github/workflows/deploy.yml" "ci change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test ".github/workflows/* → ALL" true || run_test ".github/workflows/* → ALL" false
cd "$ORIG_DIR"

# ── Test 9: Unknown/unclassified file → ALL (fail-closed) ──
echo ""
echo "Test 9: Unknown/unclassified file"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "random-file.txt unknown/module/foo.ts" "unknown change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "unknown paths → ALL (fail-closed)" true || run_test "unknown paths → ALL (fail-closed)" false
cd "$ORIG_DIR"

# ── Test 10: pnpm-lock.yaml → ALL ──
echo ""
echo "Test 10: pnpm-lock.yaml change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "pnpm-lock.yaml" "lockfile update"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "pnpm-lock.yaml → ALL" true || run_test "pnpm-lock.yaml → ALL" false
cd "$ORIG_DIR"

# ── Test 11: scripts/ change → ALL ──
echo ""
echo "Test 11: scripts/ change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "scripts/deploy.sh" "script change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "scripts/* → ALL" true || run_test "scripts/* → ALL" false
cd "$ORIG_DIR"

# ── Test 12: Root README change (unclassified) → ALL ──
echo ""
echo "Test 12: Root README change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "README.md" "docs change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "README.md (root) → ALL (fail-closed)" true || run_test "README.md (root) → ALL (fail-closed)" false
cd "$ORIG_DIR"

# ── Test 13: Missing SHA → ALL ──
echo ""
echo "Test 13: Missing SHA"
RESULT=$(BASE_SHA="" HEAD_SHA="" bash "$DETECT_SCRIPT" 2>/dev/null) || true
run_test "missing SHA → ALL (fail-closed)" assert_all_packages "$RESULT"

# ── Test 14: Invalid SHA → ALL ──
echo ""
echo "Test 14: Invalid SHA"
RESULT=$(BASE_SHA="0000000000000000000000000000000000000000" HEAD_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" bash "$DETECT_SCRIPT" 2>/dev/null) || true
run_test "invalid SHA → ALL (fail-closed)" assert_all_packages "$RESULT"

# ── Test 15: Empty diff (identical SHAs) → empty matrix ──
echo ""
echo "Test 15: Empty diff (identical SHAs)"
(
  create_repo
  SAME=$(git rev-parse HEAD)
  RESULT=$(run_detect "$SAME" "$SAME")
  assert_empty_matrix "$RESULT"
) && run_test "identical SHAs → empty matrix" true || run_test "identical SHAs → empty matrix" false
cd "$ORIG_DIR"

# ── Test 16: contracts/package.json → ALL (workspace member) ──
echo ""
echo "Test 16: contracts/package.json"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "contracts/package.json" "contracts package.json change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "contracts/package.json → ALL" true || run_test "contracts/package.json → ALL" false
cd "$ORIG_DIR"

# ── Test 17: pnpm-workspace.yaml → ALL ──
echo ""
echo "Test 17: pnpm-workspace.yaml"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "pnpm-workspace.yaml" "workspace config change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "pnpm-workspace.yaml → ALL" true || run_test "pnpm-workspace.yaml → ALL" false
cd "$ORIG_DIR"

# ── Test 18: Changes across all packages → ALL ──
echo ""
echo "Test 18: Changes across all packages"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx packages/sdk/src/index.ts packages/prime-agent/src/talos_agent/main.py contracts/talos_registry/src/lib.rs" "all packages change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "all packages changed → ALL" true || run_test "all packages changed → ALL" false
cd "$ORIG_DIR"

# ── Test 19: contracts subdir change → contracts only ──
echo ""
echo "Test 19: contracts subdirectory change"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "contracts/talos_registry/src/lib.rs" "contract src change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "contracts" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "prime-agent"
) && run_test "contracts/talos_registry/* → contracts only" true || run_test "contracts/talos_registry/* → contracts only" false
cd "$ORIG_DIR"

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
