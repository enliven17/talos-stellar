#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# secret-scan.test.sh — Test suite for secret-scan.sh
#
# Creates temporary git repos, stages fixtures, runs the scan script,
# and validates exit codes and redacted output (issue #636).
#
# Usage:
#   bash scripts/secret-scan.test.sh
#
# Exit codes:
#   0 — all tests passed
#   1 — one or more tests failed
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCAN_SCRIPT="${SCRIPT_DIR}/secret-scan.sh"
REPO_CONFIG="$(cd "${SCRIPT_DIR}/.." && pwd)/.gitleaks.toml"

# Fake secret assembled at runtime from base64 so THIS committed test file
# itself does not contain a contiguous plaintext pattern for the positive
# fixture. The b64 constant still trips generic-api-key (gitleaks base64-
# decodes matches), so it is sanctioned here with gitleaks:allow.
SECRET_B64='WnQ3S3AyTng5Unc0VmI2WWM4TGQwRmgzSm01UXMxQWU=' # gitleaks:allow

PASS=0
FAIL=0
TOTAL=0
ORIG_DIR="$(pwd)"

# ── Helpers ───────────────────────────────────────────────────────────

# Create a temp git repo with a base commit and the real scan config.
# Changes directory INTO the new repo. Caller must cd back.
create_repo() {
  local tmpdir
  tmpdir=$(mktemp -d)
  cd "$tmpdir"
  git init -q
  git config user.email "test@test.com"
  git config user.name "Test"
  cp "$REPO_CONFIG" .gitleaks.toml
  echo "base" > README.md
  git add README.md .gitleaks.toml
  git commit -q -m "base commit"
}

# Stage a file with content on stdin: stage_file <path>
stage_file() {
  local path="$1"
  mkdir -p "$(dirname "$path")"
  cat > "$path"
  git add "$path"
}

# Run the scan script in the current repo; print combined output.
# Returns the script's exit code via global SCAN_RC.
run_scan() {
  local output
  local rc=0
  output=$(bash "$SCAN_SCRIPT" 2>&1) || rc=$?
  SCAN_OUTPUT="$output"
  SCAN_RC=$rc
  return 0
}

# Build the fake secret at runtime.
fake_secret() {
  printf '%s' "$SECRET_B64" | base64 -d
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
echo "  secret-scan.sh — test suite"
echo "════════════════════════════════════════════════════════"
echo ""

# ── Test 1: Missing input — nothing staged → pass trivially ──
echo "Test 1: nothing staged → pass trivially"
(
  create_repo
  run_scan
  [[ $SCAN_RC -eq 0 ]] && grep -qi "nothing staged" <<<"$SCAN_OUTPUT"
) && run_test "nothing staged → exit 0" true || run_test "nothing staged → exit 0" false
cd "$ORIG_DIR"

# ── Test 2: Positive — staged fake secret is caught, output redacted ──
echo ""
echo "Test 2: positive — staged secret caught, value redacted"
(
  create_repo
  SECRET="$(fake_secret)"
  stage_file "app.js" <<EOF
module.exports = {};
const config = { api_key: "${SECRET}" };
EOF
  run_scan
  [[ $SCAN_RC -eq 1 ]] &&
    grep -q "app.js:2:generic-api-key" <<<"$SCAN_OUTPUT" &&
    ! grep -Fq "$SECRET" <<<"$SCAN_OUTPUT" &&
    grep -qi "FAILED" <<<"$SCAN_OUTPUT"
) && run_test "fake secret → exit 1, file:line:rule only" true || run_test "fake secret → exit 1, file:line:rule only" false
cd "$ORIG_DIR"

# ── Test 3: Negative — clean staged commit passes ──
echo ""
echo "Test 3: negative — clean staged file passes"
(
  create_repo
  stage_file "src/index.ts" <<'EOF'
export function greet(name: string): string {
  return `hello ${name}`;
}
EOF
  run_scan
  [[ $SCAN_RC -eq 0 ]] && grep -qi "no secrets" <<<"$SCAN_OUTPUT"
) && run_test "clean file → exit 0" true || run_test "clean file → exit 0" false
cd "$ORIG_DIR"

# ── Test 4: Boundary — allowlisted path (dist/) ignored ──
echo ""
echo "Test 4: boundary — allowlisted dist/ path ignored"
(
  create_repo
  SECRET="$(fake_secret)"
  stage_file "dist/app.js" <<EOF
var key = "${SECRET}";
EOF
  run_scan
  [[ $SCAN_RC -eq 0 ]]
) && run_test "dist/ path allowlisted → exit 0" true || run_test "dist/ path allowlisted → exit 0" false
cd "$ORIG_DIR"

# ── Test 5: Boundary — inline gitleaks:allow comment ignored ──
echo ""
echo "Test 5: boundary — # gitleaks:allow comment ignored"
(
  create_repo
  SECRET="$(fake_secret)"
  stage_file "docs/example.ts" <<EOF
// sanctioned example: ${SECRET} # gitleaks:allow
export const note = "see line above";
EOF
  run_scan
  [[ $SCAN_RC -eq 0 ]]
) && run_test "gitleaks:allow line → exit 0" true || run_test "gitleaks:allow line → exit 0" false
cd "$ORIG_DIR"

# ── Test 6: Malformed config → fail closed ──
echo ""
echo "Test 6: malformed .gitleaks.toml → fail closed"
(
  create_repo
  stage_file "src/app.ts" <<'EOF'
export const ok = 1;
EOF
  echo "this is [not valid toml" > .gitleaks.toml
  git add .gitleaks.toml
  run_scan
  [[ $SCAN_RC -eq 1 ]] &&
    grep -qi "failing closed" <<<"$SCAN_OUTPUT" &&
    ! grep -qi "no secrets detected" <<<"$SCAN_OUTPUT"
) && run_test "malformed config → fail closed" true || run_test "malformed config → fail closed" false
cd "$ORIG_DIR"

# ── Test 7: Missing config → fail closed ──
echo ""
echo "Test 7: missing .gitleaks.toml → fail closed"
(
  create_repo
  stage_file "src/app.ts" <<'EOF'
export const ok = 1;
EOF
  rm .gitleaks.toml
  run_scan
  [[ $SCAN_RC -eq 1 ]] &&
    grep -qi "missing scan config" <<<"$SCAN_OUTPUT" &&
    ! grep -qi "no secrets detected" <<<"$SCAN_OUTPUT"
) && run_test "missing config → fail closed" true || run_test "missing config → fail closed" false
cd "$ORIG_DIR"

# ── Test 8: gitleaks not installed → fail closed with install help ──
echo ""
echo "Test 8: gitleaks not on PATH → fail closed with install instructions"
(
  create_repo
  stage_file "src/app.ts" <<'EOF'
export const ok = 1;
EOF
  # Restricted PATH: essential tools only, no gitleaks.
  fakebin="$(mktemp -d)"
  for cmd in git mktemp mkdir rm dirname cat sed bash; do
    src="$(command -v "$cmd" 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$fakebin/$cmd"
  done
  SCAN_OUTPUT="$(PATH="$fakebin" bash "$SCAN_SCRIPT" 2>&1)" && SCAN_RC=0 || SCAN_RC=$?
  rm -rf "$fakebin"
  [[ $SCAN_RC -eq 1 ]] &&
    grep -qi "gitleaks is not installed" <<<"$SCAN_OUTPUT" &&
    grep -qi "brew install gitleaks" <<<"$SCAN_OUTPUT" &&
    ! grep -qi "no secrets detected" <<<"$SCAN_OUTPUT"
) && run_test "scanner missing → fail closed + install help" true || run_test "scanner missing → fail closed + install help" false
cd "$ORIG_DIR"

# ── Test 9: Scanner crash (exit≠0, no report) → fail closed ──
echo ""
echo "Test 9: scanner crash → fail closed, never treated as clean"
(
  create_repo
  stage_file "src/app.ts" <<'EOF'
export const ok = 1;
EOF
  # Stub gitleaks that crashes without producing a report.
  fakebin="$(mktemp -d)"
  for cmd in git mktemp mkdir rm dirname cat sed bash; do
    src="$(command -v "$cmd" 2>/dev/null || true)"
    [[ -n "$src" ]] && ln -sf "$src" "$fakebin/$cmd"
  done
  printf '#!/bin/sh\necho "simulated crash" >&2\nexit 2\n' > "$fakebin/gitleaks"
  chmod +x "$fakebin/gitleaks"
  SCAN_OUTPUT="$(PATH="$fakebin" bash "$SCAN_SCRIPT" 2>&1)" && SCAN_RC=0 || SCAN_RC=$?
  rm -rf "$fakebin"
  [[ $SCAN_RC -eq 1 ]] &&
    grep -qi "scanner failed" <<<"$SCAN_OUTPUT" &&
    grep -qi "failing closed" <<<"$SCAN_OUTPUT" &&
    ! grep -qi "no secrets detected" <<<"$SCAN_OUTPUT"
) && run_test "scanner crash → fail closed" true || run_test "scanner crash → fail closed" false
cd "$ORIG_DIR"

# ── Test 10: Regression — committed scan files themselves are clean ──
echo ""
echo "Test 10: regression — this test file + script stage cleanly"
(
  create_repo
  # Stage the real scan implementation and this test file: their content
  # must not contain detectable secrets (fixtures are base64-assembled).
  cp "$SCAN_SCRIPT" secret-scan.sh
  cp "${SCRIPT_DIR}/secret-scan.test.sh" secret-scan.test.sh
  git add secret-scan.sh secret-scan.test.sh
  run_scan
  [[ $SCAN_RC -eq 0 ]]
) && run_test "scan tooling files stage cleanly → exit 0" true || run_test "scan tooling files stage cleanly → exit 0" false
cd "$ORIG_DIR"

# ── Test 11: Regression — existing local check suite still green ──
echo ""
echo "Test 11: regression — ci-detect-changes suite still passes"
if bash "${SCRIPT_DIR}/ci-detect-changes.test.sh" >/dev/null 2>&1; then
  run_test "ci-detect-changes.test.sh still green" true
else
  run_test "ci-detect-changes.test.sh still green" false
fi

# ── Test 12: Wiring — package.json exposes the single entry point ──
echo ""
echo "Test 12: wiring — package.json secrets:check entry point"
if node -e '
  const pkg = require(process.argv[1]);
  const s = pkg.scripts && pkg.scripts["secrets:check"];
  if (!s || !s.includes("secret-scan.sh")) process.exit(1);
' "${ORIG_DIR}/package.json" 2>/dev/null; then
  run_test "pnpm run secrets:check wired to scripts/secret-scan.sh" true
else
  run_test "pnpm run secrets:check wired to scripts/secret-scan.sh" false
fi

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
