#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# ci-detect-changes.test.sh — Test suite for ci-detect-changes.sh
#
# Creates lightweight temporary git repos with synthetic commits,
# runs the detection script, and validates the JSON output.
#
# Coverage: positive, negative, boundary, and regression cases for the
# changed-path CI detection hardened in issue #625 (missing, malformed,
# boundary, retry, and dependency-failure inputs).
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

# Assert the JSON matrix is valid single-line JSON with exactly one matrix
assert_valid_single_line_json() {
  local json="$1"
  [[ "$(echo "$json" | wc -l | tr -d ' ')" -eq 1 ]] &&
    [[ "$(echo "$json" | grep -c '"include":')" -eq 1 ]]
}

# Assert stderr output does not leak raw input values (privacy-safety)
assert_stderr_redacts_input() {
  local secret="$1"
  shift
  local stderr="$1"
  shift
  local token
  for token in "$@"; do
    [[ -z "$token" ]] && continue
    if printf '%s' "$stderr" | grep -qF -- "$token"; then
      return 1
    fi
  done
  # The secret value must never appear in stderr either
  if printf '%s' "$stderr" | grep -qF -- "$secret"; then
    return 1
  fi
  return 0
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

# ── Test 13: Missing SHA → ALL (fail-closed) ──
echo ""
echo "Test 13: Missing SHA"
RESULT=$(BASE_SHA="" HEAD_SHA="" bash "$DETECT_SCRIPT" 2>/dev/null) || true
run_test "missing SHA → ALL (fail-closed)" assert_all_packages "$RESULT"

# ── Test 14: Invalid SHA → ALL (fail-closed) ──
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

# ── Test 20: --all flag → ALL without git access (regression: #625) ──
echo ""
echo "Test 20: --all flag (no git access required)"
RESULT=$(
  cd /tmp
  bash "$DETECT_SCRIPT" --all 2>/dev/null
) || true
run_test "--all → ALL (works outside a repo)" assert_all_packages "$RESULT"

# ── Test 21: Malformed SHA (shell metacharacters) → ALL, redacted ──
echo ""
echo "Test 21: Malformed SHA with metacharacters"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  EVIL='abc;$(rm -rf /tmp/should-not-run)'
  STDERR_FILE=$(mktemp)
  RESULT=$(BASE_SHA="$EVIL" HEAD_SHA="$BASE" bash "$DETECT_SCRIPT" 2>"$STDERR_FILE") || true
  STDERR=$(cat "$STDERR_FILE")
  rm -f "$STDERR_FILE"
  [[ -d /tmp/should-not-run ]] && rmdir /tmp/should-not-run 2>/dev/null || true
  assert_all_packages "$RESULT" &&
    assert_stderr_redacts_input "$EVIL" "$STDERR" "abc;\$(" &&
    [[ "$RESULT" != *"should-not-run"* ]]
) && run_test "malformed SHA → ALL + stderr redacts input" true || run_test "malformed SHA → ALL + stderr redacts input" false
cd "$ORIG_DIR"

# ── Test 22: SHA that looks like an option is rejected ──
echo ""
echo "Test 22: Revision-injection attempt (--output)"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  # The value starts with '-' and would be parsed as a git option if
  # passed through unvalidated. The regex must reject it.
  STDERR_FILE=$(mktemp)
  RESULT=$(BASE_SHA="--output=/tmp/pwned" HEAD_SHA="$BASE" bash "$DETECT_SCRIPT" 2>"$STDERR_FILE") || true
  STDERR=$(cat "$STDERR_FILE")
  rm -f "$STDERR_FILE"
  [[ ! -e /tmp/pwned ]]
  assert_all_packages "$RESULT" &&
    assert_stderr_redacts_input "--output=/tmp/pwned" "$STDERR" "--output"
) && run_test "option-like SHA rejected (no revision injection)" true || run_test "option-like SHA rejected (no revision injection)" false
cd "$ORIG_DIR"

# ── Test 23: Too many positional args → ALL (explicit error) ──
echo ""
echo "Test 23: Too many positional arguments"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  STDERR_FILE=$(mktemp)
  RESULT=$(bash "$DETECT_SCRIPT" "$BASE" "$BASE" "$BASE" 2>"$STDERR_FILE") || true
  STDERR=$(cat "$STDERR_FILE")
  rm -f "$STDERR_FILE"
  assert_all_packages "$RESULT" &&
    grep -q "Expected at most 2 positional arguments" <<<"$STDERR"
) && run_test "3 positional args → explicit error + ALL" true || run_test "3 positional args → explicit error + ALL" false
cd "$ORIG_DIR"

# ── Test 24: package-lock.json at root → ALL ──
echo ""
echo "Test 24: package-lock.json (npm lockfile)"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "package-lock.json" "npm lockfile update"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_all_packages "$RESULT"
) && run_test "package-lock.json → ALL" true || run_test "package-lock.json → ALL" false
cd "$ORIG_DIR"

# ── Test 25: Filenames with spaces survive (NUL-delimited parsing) ──
# NOTE: add_commit splits on spaces, so the spaced path is created inline.
echo ""
echo "Test 25: Filenames with spaces"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  mkdir -p "packages/sdk/src"
  echo "change" > "packages/sdk/src/my file with spaces.ts"
  git add "packages/sdk/src/my file with spaces.ts"
  git commit -q -m "spaces change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "contracts" &&
    assert_not_has_package "$RESULT" "prime-agent"
) && run_test "paths with spaces classify correctly" true || run_test "paths with spaces classify correctly" false
cd "$ORIG_DIR"

# ── Test 26: Unicode filename → not unclassified into ALL (regression) ──
echo ""
echo "Test 26: Unicode filename"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "packages/sdk/src/ünïcödé.ts" "unicode change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "contracts" &&
    assert_not_has_package "$RESULT" "prime-agent"
) && run_test "unicode paths classify correctly (quotePath off)" true || run_test "unicode paths classify correctly (quotePath off)" false
cd "$ORIG_DIR"

# ── Test 27: Non-ASCII filename at root → fail closed with count only ──
echo ""
echo "Test 27: Non-ASCII unclassified path reports count, not the path"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "ünïcödé-∂oc.md" "unicode root change"
  HEAD=$(git rev-parse HEAD)
  STDERR_FILE=$(mktemp)
  RESULT=$(BASE_SHA="$BASE" HEAD_SHA="$HEAD" bash "$DETECT_SCRIPT" 2>"$STDERR_FILE") || true
  STDERR=$(cat "$STDERR_FILE")
  rm -f "$STDERR_FILE"
  assert_all_packages "$RESULT" &&
    grep -q "unclassified" <<<"$STDERR" &&
    ! grep -q "ünïcödé" <<<"$STDERR"
) && run_test "unclassified paths → count-only warning (privacy-safe)" true || run_test "unclassified paths → count-only warning (privacy-safe)" false
cd "$ORIG_DIR"

# ── Test 28: Retry config — malformed knobs fall back to defaults ──
echo ""
echo "Test 28: Malformed retry env vars"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx" "web change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(DETECT_MAX_DIFF_ATTEMPTS="not-a-number" DETECT_DIFF_RETRY_BACKOFF_SECONDS="banana" \
    BASE_SHA="$BASE" HEAD_SHA="$HEAD" bash "$DETECT_SCRIPT" 2>/dev/null)
  assert_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "sdk"
) && run_test "malformed retry knobs → defaults, normal output" true || run_test "malformed retry knobs → defaults, normal output" false
cd "$ORIG_DIR"

# ── Test 29: Retry budget — valid config respected on success path ──
echo ""
echo "Test 29: Retry env vars accepted on success path"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "contracts/talos_registry/src/lib.rs" "contracts change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(DETECT_MAX_DIFF_ATTEMPTS=5 DETECT_DIFF_RETRY_BACKOFF_SECONDS=0 \
    BASE_SHA="$BASE" HEAD_SHA="$HEAD" bash "$DETECT_SCRIPT" 2>/dev/null)
  assert_has_package "$RESULT" "contracts"
) && run_test "valid retry knobs → normal classification" true || run_test "valid retry knobs → normal classification" false
cd "$ORIG_DIR"

# ── Test 30: Ref names are accepted as SHAs (boundary: not just hex) ──
echo ""
echo "Test 30: Ref names (HEAD) accepted as SHAs"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx" "web change"
  RESULT=$(BASE_SHA="$BASE" HEAD_SHA="HEAD" bash "$DETECT_SCRIPT" 2>/dev/null)
  assert_has_package "$RESULT" "web" &&
    assert_not_has_package "$RESULT" "sdk"
) && run_test "ref names (HEAD) resolve as SHAs" true || run_test "ref names (HEAD) resolve as SHAs" false
cd "$ORIG_DIR"

# ── Test 31: Dependency failure — 'git' missing from PATH after SHA check ──
echo ""
echo "Test 31: git diff unavailable → ALL after retries"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx" "web change"
  HEAD=$(git rev-parse HEAD)
  # Shim 'git' so SHA resolution (cat-file) still works against the
  # real repo but the diff call fails — exercising the retry loop only.
  SHIM_DIR=$(mktemp -d)
  cat > "$SHIM_DIR/git" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == "cat-file" ]]; then
    exec "$(command -v -p git || command -v git)" "$@"
  fi
done
exit 128
EOF
  chmod +x "$SHIM_DIR/git"
  RESULT=$(PATH="$SHIM_DIR:$PATH" DETECT_MAX_DIFF_ATTEMPTS=2 DETECT_DIFF_RETRY_BACKOFF_SECONDS=0 \
    BASE_SHA="$BASE" HEAD_SHA="$HEAD" bash "$DETECT_SCRIPT" 2>/dev/null) || true
  rm -rf "$SHIM_DIR"
  assert_all_packages "$RESULT"
) && run_test "git diff failing (exit 128) → retries then ALL" true || run_test "git diff failing (exit 128) → retries then ALL" false
cd "$ORIG_DIR"

# ── Test 32: Exhausted retries emit error annotation mentioning budget ──
echo ""
echo "Test 32: Error annotation mentions retry budget"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx" "web change"
  HEAD=$(git rev-parse HEAD)
  # Shim 'git' so cat-file (SHA resolution) works but diff always fails.
  SHIM_DIR=$(mktemp -d)
  cat > "$SHIM_DIR/git" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  if [[ "$arg" == "cat-file" ]]; then
    exec "$(command -v -p git || command -v git)" "$@"
  fi
done
exit 1
EOF
  chmod +x "$SHIM_DIR/git"
  STDERR_FILE=$(mktemp)
  RESULT=$(PATH="$SHIM_DIR:$PATH" DETECT_MAX_DIFF_ATTEMPTS=2 DETECT_DIFF_RETRY_BACKOFF_SECONDS=0 \
    BASE_SHA="$BASE" HEAD_SHA="$HEAD" bash "$DETECT_SCRIPT" 2>"$STDERR_FILE") || true
  STDERR=$(cat "$STDERR_FILE")
  rm -rf "$SHIM_DIR" "$STDERR_FILE"
  assert_all_packages "$RESULT" &&
    grep -q "retry budget exhausted" <<<"$STDERR" &&
    grep -q "::error::" <<<"$STDERR"
) && run_test "exhausted retries → ::error:: with budget message" true || run_test "exhausted retries → ::error:: with budget message" false
cd "$ORIG_DIR"

# ── Test 33: Matrix is single-line valid JSON (workflow parser safety) ──
echo ""
echo "Test 33: Output is single-line JSON"
(
  create_repo
  BASE=$(git rev-parse HEAD)
  add_commit "web/src/app/page.tsx packages/sdk/src/index.ts" "multi change"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_valid_single_line_json "$RESULT"
) && run_test "output is single-line JSON" true || run_test "output is single-line JSON" false
cd "$ORIG_DIR"

# ── Test 34: Deleted file paths still classify (boundary: rename/delete) ──
echo ""
echo "Test 34: Deleted + renamed files classify"
(
  create_repo
  add_commit "packages/sdk/src/old.ts" "seed file"
  BASE=$(git rev-parse HEAD)
  git mv packages/sdk/src/old.ts packages/sdk/src/new.ts
  git commit -q -m "rename sdk file"
  HEAD=$(git rev-parse HEAD)
  RESULT=$(run_detect "$BASE" "$HEAD")
  assert_has_package "$RESULT" "sdk" &&
    assert_not_has_package "$RESULT" "web"
) && run_test "renamed file → sdk only" true || run_test "renamed file → sdk only" false
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
