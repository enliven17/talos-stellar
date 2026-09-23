#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# ci-detect-changes.sh — Classify changed files into Talos packages
#
# Reads BASE_SHA / HEAD_SHA from the environment (or CLI args) and
# produces a GitHub Actions-compatible JSON matrix on stdout.
#
# Exit codes:
#   0 — matrix written to stdout
#   1 — fatal error (invalid SHAs, git failure, etc.)
#
# Usage:
#   BASE_SHA=abc123 HEAD_SHA=def456 ./scripts/ci-detect-changes.sh
#   ./scripts/ci-detect-changes.sh <base_sha> <head_sha>
#
# The script only inspects file paths — it never executes code from the
# PR and uses no external dependencies beyond bash and git.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Resolve SHAs from args or environment ─────────────────────────────
BASE_SHA="${1:-${BASE_SHA:-}}"
HEAD_SHA="${2:-${HEAD_SHA:-}}"

if [[ -z "$BASE_SHA" || -z "$HEAD_SHA" ]]; then
  echo "::error::ci-detect-changes: BASE_SHA and HEAD_SHA are required." >&2
  echo '{"include":[{"package":"web"},{"package":"sdk"},{"package":"prime-agent"},{"package":"contracts"}]}'
  exit 1
fi

# ── Validate SHAs ─────────────────────────────────────────────────────
if ! git cat-file -t "$BASE_SHA" &>/dev/null; then
  echo "::warning::ci-detect-changes: BASE_SHA '$BASE_SHA' is not a valid object — falling back to ALL." >&2
  echo '{"include":[{"package":"web"},{"package":"sdk"},{"package":"prime-agent"},{"package":"contracts"}]}'
  exit 0
fi

if ! git cat-file -t "$HEAD_SHA" &>/dev/null; then
  echo "::warning::ci-detect-changes: HEAD_SHA '$HEAD_SHA' is not a valid object — falling back to ALL." >&2
  echo '{"include":[{"package":"web"},{"package":"sdk"},{"package":"prime-agent"},{"package":"contracts"}]}'
  exit 0
fi

# ── Diff changed files ───────────────────────────────────────────────
# Use triple-dot diff to get files changed between base and head.
CHANGED_FILES=$(git diff --name-only "$BASE_SHA...$HEAD_SHA" 2>/dev/null || true)

if [[ -z "$CHANGED_FILES" ]]; then
  # No changed files detected — empty matrix (no packages to check).
  echo '{"include":[]}'
  exit 0
fi

# ── Classify each file ───────────────────────────────────────────────
WEB=false
SDK=false
AGENT=false
CONTRACTS=false
SHARED=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  case "$file" in
    # ── Web ──
    web/*)
      WEB=true
      ;;

    # ── SDK ──
    packages/sdk/*)
      SDK=true
      ;;

    # ── Prime Agent ──
    packages/prime-agent/*)
      AGENT=true
      ;;

    # ── Shared / infrastructure (triggers ALL packages) ──
    #    (Specific paths must come BEFORE directory wildcards)
    .github/*)
      SHARED=true
      ;;
    pnpm-lock.yaml)
      SHARED=true
      ;;
    pnpm-workspace.yaml)
      SHARED=true
      ;;
    package.json)
      SHARED=true
      ;;
    scripts/*)
      SHARED=true
      ;;
    # contracts/package.json is a workspace member used for vitest
    # fixtures — it affects both contracts and the JS toolchain.
    # Must come BEFORE the contracts/* wildcard.
    contracts/package.json)
      SHARED=true
      ;;
    # ── Contracts ──
    contracts/*)
      CONTRACTS=true
      ;;

    # ── Unknown / unclassified → fail closed (ALL) ──
    *)
      SHARED=true
      ;;
  esac
done <<< "$CHANGED_FILES"

# ── If shared config changed, run all packages ──
if [[ "$SHARED" == "true" ]]; then
  WEB=true
  SDK=true
  AGENT=true
  CONTRACTS=true
fi

# ── Build JSON matrix ────────────────────────────────────────────────
INCLUDES=""

if [[ "$WEB" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"web\"},"
fi
if [[ "$SDK" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"sdk\"},"
fi
if [[ "$AGENT" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"prime-agent\"},"
fi
if [[ "$CONTRACTS" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"contracts\"},"
fi

# Strip trailing comma
INCLUDES="${INCLUDES%,}"

echo "{\"include\":[${INCLUDES}]}"
