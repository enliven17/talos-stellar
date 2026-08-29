#!/usr/bin/env bash
#
# test-lockfile-fixture.sh — CI fixture that exercises the lockfile-drift
# detector on BOTH the passing and failing paths, without touching the real
# repo lockfiles and without network.
#
# It sources scripts/verify-lockfiles.sh and drives the same
# verify_{node,python,rust}_pkg functions against small synthetic packages
# created in a temp dir:
#
#   - Node (pnpm lock)  : manifest specifier vs lockfile importer
#   - Python (uv)       : uv.lock vs pyproject.toml (local path dependency)
#   - Rust  (cargo)     : Cargo.lock vs Cargo.toml (local path dependency)
#
# For each tool it asserts:
#   1. a clean package PASSES (exit 0)
#   2. a deliberately-drifted package FAILS with a non-zero exit
# The whole suite exits non-zero if any expectation is violated.
#
# Usage: bash scripts/test-lockfile-fixture.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/verify-lockfiles.sh"   # provides verify_node_pkg etc. + ROOT

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

declare -i ASSERT_FAILED=0

# Run a verify_* function in a subshell so the shared globals (FAILURES/
# CHECKED) don't leak between checks; echo its exit code.
run_check() {
  set -- "$@"
  # shellcheck disable=SC2034
  ( FAILURES=0; CHECKED=0; "$@" >/dev/null 2>"$WORK/check.err"; echo "$?" )
}

expect_pass() {
  local name="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    echo "PASS  $name"
  else
    echo "FAIL  $name (expected pass, got exit $rc)"
    sed 's/^/      /' "$WORK/check.err"
    ASSERT_FAILED=$((ASSERT_FAILED + 1))
  fi
}

expect_fail() {
  local name="$1" rc="$2"
  if [ "$rc" -ne 0 ]; then
    echo "PASS  $name (drift correctly rejected, exit $rc)"
  else
    echo "FAIL  $name (expected failure, got exit 0)"
    ASSERT_FAILED=$((ASSERT_FAILED + 1))
  fi
}

echo "== Node (pnpm) fixture =="
mkdir -p "$WORK/node"
cat > "$WORK/node/package.json" <<'JSON'
{ "name": "nodefix", "version": "1.0.0", "dependencies": { "left-pad": "^1.3.0" } }
JSON
cat > "$WORK/node/pnpm-lock.yaml" <<'YAML'
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      left-pad:
        specifier: ^1.3.0
        version: 1.3.0

packages:

  left-pad@1.3.0:
    resolution: {integrity: sha512-fake}
YAML
rc="$(run_check verify_node_pkg "$WORK/node/package.json" "$WORK/node/pnpm-lock.yaml" "." "node pass")"
expect_pass "node clean (in sync)" "$rc"
# Deliberate drift: bump the specifier in the manifest without touching the lock.
node -e '
const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
p.dependencies["left-pad"]="^2.0.0";fs.writeFileSync(process.argv[1],JSON.stringify(p,null,2)+"\n");
' "$WORK/node/package.json"
rc="$(run_check verify_node_pkg "$WORK/node/package.json" "$WORK/node/pnpm-lock.yaml" "." "node fail")"
expect_fail "node drift (rejected)" "$rc"

echo "== Python (uv) fixture =="
mkdir -p "$WORK/pylib" "$WORK/pyapp"
cat > "$WORK/pylib/pyproject.toml" <<'TOML'
[project]
name = "pylib"
version = "0.1.0"
requires-python = ">=3.10"
TOML
cat > "$WORK/pyapp/pyproject.toml" <<TOML
[project]
name = "pyapp"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["pylib @ file://$WORK/pylib"]
TOML
( cd "$WORK/pyapp" && uv lock --offline >/dev/null 2>&1 )
rc="$(run_check verify_python_pkg "$WORK/pyapp" "py pass")"
expect_pass "uv clean (in sync)" "$rc"
# Drift: bump pylib's version; uv.lock is now stale.
cat > "$WORK/pylib/pyproject.toml" <<'TOML'
[project]
name = "pylib"
version = "0.2.0"
requires-python = ">=3.10"
TOML
rc="$(run_check verify_python_pkg "$WORK/pyapp" "py fail")"
expect_fail "uv drift (rejected)" "$rc"

echo "== Rust (cargo) fixture =="
# A tiny cargo workspace (mirrors contracts/: a workspace root with members).
mkdir -p "$WORK/crates/src" "$WORK/crates/member/src"
cat > "$WORK/crates/Cargo.toml" <<'TOML'
[workspace]
resolver = "2"
members = ["member"]
TOML
printf 'pub fn x() {}\n' > "$WORK/crates/src/lib.rs"
cat > "$WORK/crates/member/Cargo.toml" <<'TOML'
[package]
name = "talos-member"
version = "0.1.0"
edition = "2021"
TOML
printf 'pub fn x() {}\n' > "$WORK/crates/member/src/lib.rs"
( cd "$WORK/crates" && cargo generate-lockfile --offline >/dev/null 2>&1 )
rc="$(run_check verify_rust_pkg "$WORK/crates" "rs pass")"
expect_pass "cargo clean (in sync)" "$rc"
# Drift: bump a workspace member's version; Cargo.lock is now stale.
cat > "$WORK/crates/member/Cargo.toml" <<'TOML'
[package]
name = "talos-member"
version = "0.2.0"
edition = "2021"
TOML
rc="$(run_check verify_rust_pkg "$WORK/crates" "rs fail")"
expect_fail "cargo drift (rejected)" "$rc"

echo ""
if [ "$ASSERT_FAILED" -gt 0 ]; then
  echo "FIXTURE FAILED: $ASSERT_FAILED expectation(s) not met."
  exit 1
fi
echo "FIXTURE PASSED: all passing and failing paths behave as expected."
