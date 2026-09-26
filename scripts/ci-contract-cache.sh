#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# ci-contract-cache.sh — Safe contract-artifact caching helpers for CI
#
# Used by the workflows that build Soroban wasm artifacts
# (.github/workflows/contracts-ci.yml, ci.yml, release-publish.yml,
# sbom-provenance.yml) — issue #635. The cache is an optimization only:
# the wasm build always runs in these jobs; these helpers make the cache
# boundary explicit, verifiable, and locally testable.
#
# Subcommands:
#   key-hash <contracts-dir>
#       Print the strong content hash used as the cache key input:
#       sha256 over the sorted per-file digests of every file that can
#       affect the wasm build (sources, Cargo.toml manifests, Cargo.lock,
#       soroban-config.toml, .cargo/config.toml). Fails closed (exit 1,
#       actionable ::error::) when the contracts directory, required
#       inputs, or source files are missing — refusing to derive an
#       overly broad key that could serve stale artifacts.
#   validate <artifact-dir>
#       Classify restored cache content right after the actions/cache
#       restore step:
#         miss    — cold cache / nothing restored → full rebuild populates
#         hit     — every top-level *.wasm is non-empty with the wasm
#                   magic (00 61 73 6d) → safe to rebuild incrementally on
#         corrupt — any *.wasm is empty or malformed → wipe the directory
#                   so the build falls back to a full rebuild
#       Always exits 0 for miss/corrupt (a bad cache entry is a miss, not
#       a job failure). Exits 1 only on ambiguous input (missing/invalid
#       arguments). Writes cache_status / cache_usable to $GITHUB_OUTPUT
#       when set.
#   verify <artifact-dir>
#       Post-build gate: at least one non-empty top-level *.wasm with the
#       WebAssembly magic bytes. Fails the job with an actionable
#       ::error:: when artifacts are missing or invalid, so a run can
#       never go green with stale/missing artifacts (this is the
#       fail-closed path for cache backend outages and failed builds).
#
# Failure behavior summary (issue #635):
#   missing (cold cache)     → validate reports miss → full rebuild →
#                              workflows save the new entry afterwards
#   malformed/corrupted      → validate wipes + warns → rebuild (exit 0)
#   boundary (input change)  → key-hash changes → new cache key → miss →
#                              rebuild (restore-keys only prefix-match the
#                              same OS + toolchain, then cargo rebuilds)
#   flaky restore/save       → handled in the workflows via
#                              continue-on-error + ::warning::; build and
#                              verify still run
#   dependency/ambiguous     → key-hash and verify fail closed with an
#                              explicit ::error:: (never a silent success
#                              with broad keys or missing artifacts)
#
# Privacy: logs only counts and file names — never file contents,
# environment values, seeds, keys, or other sensitive material. Only the
# build output directory is ever cached; .env/config files are not.
#
# Local reproduction of this behavior (also wired into CI):
#   bash scripts/ci-contract-cache.test.sh
#
# Exit codes: 0 — success, or graceful miss/corrupt classification
#             1 — fail-closed (ambiguous input, missing key inputs,
#                 failed artifact verification)
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") {key-hash <contracts-dir>|validate <artifact-dir>|verify <artifact-dir>}" >&2
}

err() {
  echo "::error::ci-contract-cache: $*" >&2
}

# True when the file is non-empty and starts with the WebAssembly binary
# magic bytes 00 61 73 6d ("\0asm").
has_wasm_magic() {
  local file="$1"
  local bytes
  [ -s "$file" ] || return 1
  bytes=$(od -An -tx1 -N4 "$file" | tr -d ' \n')
  [ "$bytes" = "0061736d" ]
}

# Print top-level *.wasm paths in a directory (the same non-recursive
# glob every consumer of these artifacts already uses, e.g.
# contracts/target/wasm32-unknown-unknown/release/*.wasm).
# Sets the global array _WASM_FILES.
list_wasm() {
  local dir="$1"
  _WASM_FILES=()
  shopt -s nullglob
  _WASM_FILES=("$dir"/*.wasm)
  shopt -u nullglob
}

# ── key-hash ──────────────────────────────────────────────────────────
cmd_key_hash() {
  if [ "$#" -ne 1 ]; then
    err "key-hash requires exactly the contracts directory (e.g. 'contracts')."
    usage
    exit 1
  fi
  local root="$1"
  if [ ! -d "$root" ]; then
    err "contracts directory '$root' not found — cannot derive a cache key. Check out the repository before computing cache key inputs."
    exit 1
  fi

  # Required key inputs: without these the hash would be broad/incomplete
  # and could serve stale artifacts — fail closed instead.
  local req
  for req in Cargo.toml Cargo.lock; do
    if [ ! -f "$root/$req" ]; then
      err "required cache key input '$root/$req' is missing — refusing to derive an overly broad cache key that could serve stale contract artifacts."
      exit 1
    fi
  done

  # Digest every build-relevant input with stable repo-relative paths so
  # the hash is independent of the absolute workspace location (forks,
  # runners). Exclude target/ (generated build code is not a source
  # input). Sorted → order-independent.
  local listing
  listing=$(
    cd "$root"
    find . -type f \
      \( -name '*.rs' -o -name 'Cargo.toml' -o -name 'Cargo.lock' \
         -o -name 'soroban-config.toml' -o -path './.cargo/config.toml' \) \
      ! -path './target/*' \
      | LC_ALL=C sort \
      | while IFS= read -r f; do sha256sum "$f"; done
  )

  if [ -z "$listing" ]; then
    err "no contract build inputs matched under '$root' — refusing to derive an overly broad cache key."
    exit 1
  fi
  if ! printf '%s\n' "$listing" | grep -q 'Cargo\.lock$'; then
    err "Cargo.lock was not hashed under '$root' — refusing to derive an incomplete cache key."
    exit 1
  fi
  if ! printf '%s\n' "$listing" | grep -q '\.rs$'; then
    err "no contract source files (*.rs) found under '$root' — refusing to derive an incomplete cache key."
    exit 1
  fi

  printf '%s\n' "$listing" | sha256sum | cut -d' ' -f1
}

# ── validate ──────────────────────────────────────────────────────────
cmd_validate() {
  if [ "$#" -ne 1 ]; then
    err "validate requires exactly one artifact directory argument."
    usage
    exit 1
  fi
  local dir="$1"
  # Ambiguous input fails closed: a non-directory in the artifact path
  # position means the workflow wiring is wrong — never guess.
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    err "artifact path '$dir' exists but is not a directory — ambiguous input, failing closed."
    exit 1
  fi

  local status usable
  if [ ! -d "$dir" ]; then
    status="miss"
    usable="false"
    echo "::notice::contract artifact cache: cold cache (nothing restored at '$dir') — full rebuild will populate it"
  else
    local files=()
    list_wasm "$dir"
    files=("${_WASM_FILES[@]+"${_WASM_FILES[@]}"}")
    if [ "${#files[@]}" -eq 0 ]; then
      status="miss"
      usable="false"
      echo "::notice::contract artifact cache: no *.wasm in restored '$dir' — treating as a miss; full rebuild will populate it"
    else
      local bad=0
      local bad_names=()
      local f
      for f in "${files[@]}"; do
        if ! has_wasm_magic "$f"; then
          bad=$((bad + 1))
          bad_names+=("$(basename "$f")")
        fi
      done
      if [ "$bad" -gt 0 ]; then
        # Malformed/corrupted entry → treat as a miss, not a failure:
        # wipe so cargo performs a full rebuild, warn, and continue.
        status="corrupt"
        usable="false"
        echo "::warning::contract artifact cache: corrupted entry at '$dir' (${bad}/${#files[@]} invalid *.wasm: ${bad_names[*]}) — treated as a cache miss; wiping and rebuilding. Job continues."
        rm -rf "$dir"
      else
        status="hit"
        usable="true"
        echo "::notice::contract artifact cache: validated ${#files[@]} artifact(s) restored at '$dir'"
      fi
    fi
  fi

  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    {
      echo "cache_status=${status}"
      echo "cache_usable=${usable}"
    } >>"$GITHUB_OUTPUT"
  fi
  echo "cache_status=${status} cache_usable=${usable}"
  return 0
}

# ── verify ────────────────────────────────────────────────────────────
cmd_verify() {
  if [ "$#" -ne 1 ]; then
    err "verify requires exactly one artifact directory argument."
    usage
    exit 1
  fi
  local dir="$1"
  if [ -e "$dir" ] && [ ! -d "$dir" ]; then
    err "artifact path '$dir' exists but is not a directory — ambiguous input, failing closed."
    exit 1
  fi
  if [ ! -d "$dir" ]; then
    err "contract artifact verification failed: build output directory '$dir' does not exist. The wasm build did not run or failed — check the build step logs. Failing closed rather than passing with missing artifacts."
    exit 1
  fi

  local files=()
  list_wasm "$dir"
  files=("${_WASM_FILES[@]+"${_WASM_FILES[@]}"}")
  if [ "${#files[@]}" -eq 0 ]; then
    err "contract artifact verification failed: no *.wasm files in '$dir'. The wasm build produced nothing — check the build step logs. Failing closed rather than passing with missing artifacts."
    exit 1
  fi

  local bad=0
  local f
  for f in "${files[@]}"; do
    if ! has_wasm_magic "$f"; then
      err "contract artifact verification failed: '$(basename "$f")' is empty or not a WebAssembly binary. Rebuild from a clean state (delete '$dir') and check the build step logs."
      bad=$((bad + 1))
    fi
  done
  if [ "$bad" -gt 0 ]; then
    exit 1
  fi
  echo "verified ${#files[@]} contract artifact(s) in '$dir'"
}

# ── entrypoint ────────────────────────────────────────────────────────
if [ "$#" -lt 1 ]; then
  err "missing subcommand."
  usage
  exit 1
fi

SUBCMD="$1"
shift
case "$SUBCMD" in
  key-hash) cmd_key_hash "$@" ;;
  validate) cmd_validate "$@" ;;
  verify) cmd_verify "$@" ;;
  *)
    err "unknown subcommand '$SUBCMD'."
    usage
    exit 1
    ;;
esac
