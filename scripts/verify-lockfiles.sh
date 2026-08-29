#!/usr/bin/env bash
#
# verify-lockfiles.sh — detect manifest <-> lockfile drift across the
# maintained packages of the Talos monorepo before merge or deployment.
#
# Every maintained package is verified with its own package manager:
#
#   Node (pnpm workspace)      root pnpm-lock.yaml        vs every package.json
#   Node (web, standalone)     web/pnpm-lock.yaml         vs web/package.json
#   Node (sdk, standalone npm) packages/sdk/package-lock.json  vs package.json
#   Python (uv)                packages/prime-agent/uv.lock
#   Rust  (cargo)              contracts/Cargo.lock
#
# Output is actionable and deliberately never prints secrets or .env values.
#
# This file can be sourced by other scripts (e.g. the fixture test
# scripts/test-lockfile-fixture.sh) to reuse verify_node_pkg / verify_python_pkg /
# verify_rust_pkg against arbitrary directories.
#
# Usage:
#   scripts/verify-lockfiles.sh            # offline, deterministic checks
#   scripts/verify-lockfiles.sh --frozen   # also run `pnpm install --frozen-lockfile`
#   scripts/verify-lockfiles.sh --help
#
# Exit code is non-zero when any maintained package's lockfile is stale.
# This is the local command the CI workflow invokes (see
# .github/workflows/lockfile-drift-ci.yml); run it before opening a PR.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Sourced mode (fixture/reuse) exports functions but does not run main().
VERIFY_SOURCED=0
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  VERIFY_SOURCED=1
fi

declare -i FAILURES=0
declare -i CHECKED=0
FROZEN=0

log() { printf '%s\n' "$*"; }
err() { printf '::error::%s\n' "$*" >&2; }
ok()  { printf '✓ %s\n' "$*"; }
bad() { printf '✗ %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: scripts/verify-lockfiles.sh [--frozen] [-h|--help]

  (no flags)  Run offline, deterministic drift checks for every maintained
              package (does not require network, does not mutate files).

  --frozen    Additionally run the authoritative `pnpm install --frozen-lockfile`
              and guard against working-tree mutations (requires network).

  -h --help   Show this help.

Exit status is 0 when every maintained lockfile is in sync, non-zero otherwise.
EOF
}

# ---------------------------------------------------------------------------
# Toolchain version guards (documented versions live in CONTRIBUTING.md).
# ---------------------------------------------------------------------------
guard_node() {
  local major
  major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
  if [ "${major:-0}" -lt 20 ]; then
    err "Node.js >= 20 required for lockfile verification (found $(node -v)). See CONTRIBUTING.md."
    return 1
  fi
  ok "Node.js $(node -v) (>=20 satisfied)"
  return 0
}

guard_pnpm() {
  if ! command -v pnpm >/dev/null 2>&1; then
    if [ "$FROZEN" -eq 1 ]; then
      err "pnpm is required for --frozen verification. Install it (see CONTRIBUTING.md): corepack enable / npm i -g pnpm"
      return 1
    fi
    ok "pnpm not installed (only needed for --frozen)"
    return 0
  fi
  local major
  major="$(pnpm --version 2>/dev/null | cut -d. -f1)"
  if [ "${major:-0}" -lt 9 ]; then
    err "pnpm >= 9 required (found $(pnpm --version)). See CONTRIBUTING.md."
    return 1
  fi
  ok "pnpm $(pnpm --version) (>=9 satisfied)"
  return 0
}

guard_uv() {
  command -v uv >/dev/null 2>&1 || { err "uv is required to verify Python lockfiles. See CONTRIBUTING.md."; return 1; }
  return 0
}

guard_cargo() {
  command -v cargo >/dev/null 2>&1 || { err "cargo is required to verify Rust lockfiles. See CONTRIBUTING.md."; return 1; }
  return 0
}

# ---------------------------------------------------------------------------
# Node package verification. args: <manifest(abs)> <lock(abs)> <importer> <label>
# Uses the deterministic, offline check-node-lock.js comparison.
# ---------------------------------------------------------------------------
verify_node_pkg() {
  local manifest="$1" lockfile="$2" importer="$3" label="$4" tmp
  tmp="$(mktemp)"
  CHECKED=$((CHECKED + 1))
  # shellcheck disable=SC2086
  if node --no-warnings "$ROOT/scripts/check-node-lock.js" \
      --manifest "$manifest" \
      --lock     "$lockfile" \
      --package  "$importer" >/dev/null 2>"$tmp"; then
    ok "$label — $(basename "$(dirname "$manifest")")/$(basename "$manifest") in sync with $(basename "$lockfile")"
    rm -f "$tmp"
    return 0
  fi
  bad "$label — drift detected"
  sed 's/^/    /' "$tmp" >&2
  rm -f "$tmp"
  err "Fix: run your package manager install (e.g. 'pnpm install' / 'npm install') and commit the updated lockfile for $label."
  FAILURES=$((FAILURES + 1))
  return 1
}

# Python package verification via uv against a project directory.
verify_python_pkg() {
  local dir="$1" label="$2" out rc
  out="$(mktemp)"
  CHECKED=$((CHECKED + 1))
  (cd "$dir" && timeout 120 uv lock --check --offline) >"$out" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "$label — $(basename "$dir")/uv.lock up to date"
    rm -f "$out"
    return 0
  fi
  bad "$label — drift detected"
  sed 's/^/    /' "$out" >&2
  rm -f "$out"
  err "Fix: run '(cd $dir && uv lock)' and commit the updated uv.lock."
  FAILURES=$((FAILURES + 1))
  return 1
}

# Rust package verification via cargo against a project directory.
# `cargo metadata --locked` validates Cargo.lock against the current manifests.
# The `--no-deps`/`--offline` flags are deliberately NOT used: `--no-deps`
# would skip dependency resolution and silently miss version drift, and the
# real workspace needs the registry cache to resolve transitive deps.
verify_rust_pkg() {
  local dir="$1" label="$2" out rc
  out="$(mktemp)"
  CHECKED=$((CHECKED + 1))
  (cd "$dir" && timeout 180 cargo metadata --locked --format-version 1) >"$out" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ]; then
    ok "$label — $(basename "$dir")/Cargo.lock up to date and locked"
    rm -f "$out"
    return 0
  fi
  bad "$label — drift detected"
  sed 's/^/    /' "$out" >&2
  rm -f "$out"
  err "Fix: run '(cd $dir && cargo generate-lockfile)' (or 'cargo update') and commit the updated Cargo.lock."
  FAILURES=$((FAILURES + 1))
  return 1
}

# ---------------------------------------------------------------------------
# Main: run every maintained package of the monorepo.
# ---------------------------------------------------------------------------
run_main() {
  for arg in "$@"; do
    case "$arg" in
      --frozen) FROZEN=1 ;;
      -h|--help) usage; exit 0 ;;
      *) log "unknown option: $arg"; usage; exit 2 ;;
    esac
  done

  log "Talos lockfile drift verification (root: $ROOT)"
  log ""

  guard_node
  guard_pnpm
  guard_uv
  guard_cargo
  log ""

  # Node packages (workspace root lockfile covers web, contracts, packages/sdk).
  verify_node_pkg "$ROOT/package.json"              "$ROOT/pnpm-lock.yaml"            "."            "workspace root"
  verify_node_pkg "$ROOT/web/package.json"          "$ROOT/pnpm-lock.yaml"            "web"          "web (workspace)"
  verify_node_pkg "$ROOT/contracts/package.json"    "$ROOT/pnpm-lock.yaml"            "contracts"    "contracts (workspace)"
  verify_node_pkg "$ROOT/packages/sdk/package.json" "$ROOT/pnpm-lock.yaml"            "packages/sdk" "sdk (workspace)"
  # Standalone per-package lockfiles that are tracked in the repo.
  verify_node_pkg "$ROOT/web/package.json"          "$ROOT/web/pnpm-lock.yaml"        "."            "web (standalone)"
  verify_node_pkg "$ROOT/packages/sdk/package.json" "$ROOT/packages/sdk/package-lock.json" ""        "sdk (npm)"
  log ""

  # Python packages. packages/openclaw has no committed uv.lock, so nothing to verify.
  verify_python_pkg "$ROOT/packages/prime-agent" "prime-agent"

  # Rust contracts.
  verify_rust_pkg "$ROOT/contracts" "contracts"

  log ""

  if [ "$FROZEN" -eq 1 ]; then
    log "Running authoritative 'pnpm install --frozen-lockfile' at workspace root..."
    if (cd "$ROOT" && timeout 300 pnpm install --frozen-lockfile) >&2; then
      ok "pnpm --frozen-lockfile resolved cleanly"
    else
      bad "pnpm --frozen-lockfile failed"
      FAILURES=$((FAILURES + 1))
    fi
    if git -C "$ROOT" diff --quiet --exit-code -- pnpm-lock.yaml web/pnpm-lock.yaml packages/sdk/package-lock.json; then
      ok "no lockfile mutation after frozen install"
    else
      bad "frozen install mutated tracked lockfiles — commit the changes instead."
      git -C "$ROOT" diff --stat -- pnpm-lock.yaml web/pnpm-lock.yaml packages/sdk/package-lock.json
      FAILURES=$((FAILURES + 1))
    fi
    log ""
  fi

  log "Verified $CHECKED lockfile(s)."

  if [ "$FAILURES" -gt 0 ]; then
    err "$FAILURES package(s) have stale lockfiles. Fix them locally and re-run before merging."
    exit 1
  fi

  log "All maintained lockfiles are in sync."
  exit 0
}

if [ "$VERIFY_SOURCED" -eq 0 ]; then
  run_main "$@"
fi
