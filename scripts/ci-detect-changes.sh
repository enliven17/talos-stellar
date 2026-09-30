#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# ci-detect-changes.sh — Classify changed files into Talos packages
#
# Reads BASE_SHA / HEAD_SHA from the environment (or CLI args) and
# produces a GitHub Actions-compatible JSON matrix on stdout.
#
# Usage:
#   BASE_SHA=abc123 HEAD_SHA=def456 ./scripts/ci-detect-changes.sh
#   ./scripts/ci-detect-changes.sh <base_sha> <head_sha>
#   ./scripts/ci-detect-changes.sh --all   # full matrix, no git access
#
# Exit codes:
#   0 — a matrix was written to stdout (normal, degraded, or empty)
#
# Failure semantics (fail closed, fail safe — never skip silently):
#   - Missing, malformed, or unresolvable SHAs, git failures, and
#     exhausted retries degrade to the FULL package matrix (ALL) with a
#     ::error::/::warning:: annotation on stderr. The script still
#     exits 0 so downstream jobs run everything instead of nothing:
#     a broken detector must never result in a silently green run.
#   - An empty diff (base == head, or no changed files) emits an empty
#     matrix `{"include":[]}`.
#   - Unclassified paths fail closed to ALL packages. Path values are
#     never echoed in diagnostics (privacy-safe); only counts are.
#
# Environment knobs:
#   DETECT_MAX_DIFF_ATTEMPTS          positive int, default 3
#   DETECT_DIFF_RETRY_BACKOFF_SECONDS non-negative number, default 1
#   Malformed values fall back to the defaults with a warning.
#
# The script only inspects file paths — it never executes code from the
# PR and uses no external dependencies beyond bash, git, and sleep.
# Diagnostics never include secrets, tokens, payment proofs, or the
# raw SHA/path inputs that may be attacker-controlled.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail
export LC_ALL=C

readonly SCRIPT_LABEL="ci-detect-changes"
readonly ALL_PACKAGES_JSON='{"include":[{"package":"web"},{"package":"sdk"},{"package":"prime-agent"},{"package":"contracts"}]}'
readonly EMPTY_MATRIX_JSON='{"include":[]}'

DIFF_TMP=""

cleanup() {
  if [[ -n "${DIFF_TMP}" ]]; then
    rm -f "${DIFF_TMP}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log_error()   { printf '::error::%s: %s\n'   "${SCRIPT_LABEL}" "$*" >&2; }
log_warning() { printf '::warning::%s: %s\n' "${SCRIPT_LABEL}" "$*" >&2; }
log_notice()  { printf '::notice::%s: %s\n'  "${SCRIPT_LABEL}" "$*" >&2; }

# Emit the full matrix and exit successfully (degraded-but-safe mode).
emit_all_packages() {
  log_notice "Failing closed: emitting the full package matrix."
  printf '%s\n' "${ALL_PACKAGES_JSON}"
  exit 0
}

# ── Validate retry configuration (explicit, fail-safe) ────────────────
DETECT_MAX_DIFF_ATTEMPTS="${DETECT_MAX_DIFF_ATTEMPTS:-3}"
DETECT_DIFF_RETRY_BACKOFF_SECONDS="${DETECT_DIFF_RETRY_BACKOFF_SECONDS:-1}"

if [[ ! "${DETECT_MAX_DIFF_ATTEMPTS}" =~ ^[1-9][0-9]*$ ]]; then
  log_warning "DETECT_MAX_DIFF_ATTEMPTS must be a positive integer; using the default of 3."
  DETECT_MAX_DIFF_ATTEMPTS=3
fi

if [[ ! "${DETECT_DIFF_RETRY_BACKOFF_SECONDS}" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  log_warning "DETECT_DIFF_RETRY_BACKOFF_SECONDS must be a non-negative number; using the default of 1."
  DETECT_DIFF_RETRY_BACKOFF_SECONDS=1
fi

# ── SHA resolution ────────────────────────────────────────────────────
# Accepts full/short hex SHAs or plain ref names. Anything else is
# rejected before it ever reaches git, so option/revision injection
# via BASE_SHA/HEAD_SHA is not possible. Input values are never echoed.
# Returns 0 when the value resolves to a commit; 1 otherwise.
resolve_sha() {
  local label="$1"
  local value="$2"

  if [[ -z "${value}" ]]; then
    log_error "${label} is required (pass it positionally or set the ${label} environment variable)."
    return 1
  fi

  if [[ ! "${value}" =~ ^([0-9a-fA-F]{7,64}|[A-Za-z0-9._/][A-Za-z0-9._/-]*)$ ]]; then
    log_error "${label} is malformed; refusing to expand it (input value is not echoed for privacy-safety)."
    return 1
  fi

  if ! git cat-file -e "${value}^{commit}" 2>/dev/null; then
    log_error "${label} does not resolve to a commit in this repository (input value is not echoed for privacy-safety)."
    return 1
  fi

  return 0
}

# ── Collect changed files (with retry) ────────────────────────────────
# Writes NUL-separated changed paths into DIFF_TMP.
# Returns 0 on success; 1 after the retry budget is exhausted.
collect_changed_files() {
  local attempt=1
  local rc=0

  while :; do
    rc=0
    # -z            → NUL-delimited output (safe for spaces/newlines/quotes)
    # quotePath off → non-ASCII paths stay literal instead of being
    #                 quoted into unclassifiable escape sequences
    # triple-dot    → diff from the merge-base, matching PR semantics
    git -c core.quotePath=false diff --name-only -z "${BASE_SHA}...${HEAD_SHA}" \
      > "${DIFF_TMP}" 2>/dev/null || rc=$?

    if [[ "${rc}" -eq 0 ]]; then
      return 0
    fi

    if [[ "${attempt}" -ge "${DETECT_MAX_DIFF_ATTEMPTS}" ]]; then
      log_error "git diff failed after ${DETECT_MAX_DIFF_ATTEMPTS} attempt(s) (exit code ${rc}); retry budget exhausted."
      return 1
    fi

    log_warning "git diff attempt ${attempt}/${DETECT_MAX_DIFF_ATTEMPTS} failed (exit code ${rc}); retrying."
    attempt=$((attempt + 1))
    sleep "${DETECT_DIFF_RETRY_BACKOFF_SECONDS}"
  done
}

# ── Explicit full-matrix request ──────────────────────────────────────
case "${1:-}" in
  --all|-a)
    log_notice "--all requested explicitly: emitting the full package matrix."
    printf '%s\n' "${ALL_PACKAGES_JSON}"
    exit 0
    ;;
esac

# ── Resolve SHAs from args or environment ─────────────────────────────
if [[ "$#" -gt 2 ]]; then
  log_error "Expected at most 2 positional arguments (BASE_SHA HEAD_SHA); got ${#}. Use --all for the full matrix."
  emit_all_packages
fi

BASE_SHA="${1:-${BASE_SHA:-}}"
HEAD_SHA="${2:-${HEAD_SHA:-}}"

BASE_OK=0
HEAD_OK=0
resolve_sha "BASE_SHA" "${BASE_SHA}" && BASE_OK=1
resolve_sha "HEAD_SHA" "${HEAD_SHA}" && HEAD_OK=1

if [[ "${BASE_OK}" -eq 0 || "${HEAD_OK}" -eq 0 ]]; then
  emit_all_packages
fi

# ── Diff changed files ────────────────────────────────────────────────
DIFF_TMP="$(mktemp "${TMPDIR:-/tmp}/${SCRIPT_LABEL}.XXXXXX")" || {
  log_error "Unable to create a temporary file for the diff output."
  emit_all_packages
}

if ! collect_changed_files; then
  emit_all_packages
fi

# ── Classify each file (NUL-delimited, handles any path bytes) ────────
WEB=false
SDK=false
AGENT=false
CONTRACTS=false
SHARED=false

CHANGED_COUNT=0
UNKNOWN_COUNT=0

while IFS= read -r -d '' file || [[ -n "${file}" ]]; do
  [[ -z "${file}" ]] && continue
  CHANGED_COUNT=$((CHANGED_COUNT + 1))

  case "${file}" in
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
    # npm lockfile at the root affects the JS toolchain the same way
    # pnpm-lock.yaml does when it is ever committed.
    package-lock.json)
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
      UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1))
      ;;
  esac
done < "${DIFF_TMP}"

# ── No changed files → empty matrix (nothing to check) ────────────────
if [[ "${CHANGED_COUNT}" -eq 0 ]]; then
  printf '%s\n' "${EMPTY_MATRIX_JSON}"
  exit 0
fi

if [[ "${UNKNOWN_COUNT}" -gt 0 ]]; then
  # Privacy-safe: report the count only, never the offending paths.
  log_warning "${UNKNOWN_COUNT} of ${CHANGED_COUNT} changed path(s) were unclassified; failing closed to ALL packages."
fi

# ── If shared config changed, run all packages ──
if [[ "${SHARED}" == "true" ]]; then
  WEB=true
  SDK=true
  AGENT=true
  CONTRACTS=true
fi

# ── Build JSON matrix ────────────────────────────────────────────────
INCLUDES=""

if [[ "${WEB}" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"web\"},"
fi
if [[ "${SDK}" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"sdk\"},"
fi
if [[ "${AGENT}" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"prime-agent\"},"
fi
if [[ "${CONTRACTS}" == "true" ]]; then
  INCLUDES="${INCLUDES}{\"package\":\"contracts\"},"
fi

# Strip trailing comma
INCLUDES="${INCLUDES%,}"

log_notice "Selected packages: ${INCLUDES}"

printf '{"include":[%s]}\n' "${INCLUDES}"
