#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
# secret-scan.sh — Local secret scanning for contribution checks
#
# Scans STAGED changes (git index versions) with gitleaks. This is the
# single source of truth for local secret scanning; package.json exposes
# it as `pnpm run secrets:check`.
#
# Behavior contract (issue #636):
#   - Nothing staged            → pass trivially (exit 0)
#   - Secret found              → fail (exit 1), print file:line:rule ONLY
#                                  (never the secret value or line content)
#   - Missing/malformed config  → fail closed with actionable error
#   - gitleaks missing/crashes  → fail closed with install/debug instructions;
#                                  never report "no secrets found"
#
# Exit codes:
#   0 — clean (or nothing staged)
#   1 — findings, or any fail-closed condition
#
# Usage:
#   bash scripts/secret-scan.sh
#   pnpm run secrets:check
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

fail_closed() {
  echo "secret-scan: $1" >&2
  shift
  for line in "$@"; do
    echo "$line" >&2
  done
  exit 1
}

# ── Must run inside a git repository ──────────────────────────────────
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  fail_closed "not inside a git repository." \
    "Run this from a checkout of talos-stellar."
fi
cd "$REPO_ROOT"

# ── Collect staged file paths (exclude deletions), NUL-delimited ─────
staged=()
while IFS= read -r -d '' f; do
  staged+=("$f")
done < <(git diff --cached --diff-filter=d --name-only -z)

# ── Missing input: nothing staged → pass trivially ───────────────────
if [[ ${#staged[@]} -eq 0 ]]; then
  echo "secret-scan: nothing staged — passing trivially."
  exit 0
fi

# ── Config must exist (fail closed) ──────────────────────────────────
CONFIG="$REPO_ROOT/.gitleaks.toml"
if [[ ! -f "$CONFIG" ]]; then
  fail_closed "missing scan config: .gitleaks.toml" \
    "Restore it from the repository (git checkout -- .gitleaks.toml)." \
    "Refusing to report \"no secrets found\" without a config (fail closed)."
fi

# ── Scanner must be installed (fail closed) ──────────────────────────
if ! command -v gitleaks >/dev/null 2>&1; then
  fail_closed "gitleaks is not installed (or not on PATH)." \
    "Refusing to report \"no secrets found\" without a scanner (fail closed)." \
    "Install:" \
    "  macOS:          brew install gitleaks" \
    "  Linux/Windows:  https://github.com/gitleaks/gitleaks/releases" \
    "  Go:             go install github.com/gitleaks/gitleaks/v8@latest" \
    "Then re-run: pnpm run secrets:check"
fi

# ── Extract staged file versions into a temp tree ────────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SCAN_ROOT="$TMP/staged"
REPORT="$TMP/report.txt"
STDERR_LOG="$TMP/stderr.log"
TMPL="$TMP/report.tmpl"

# Report template prints ONLY file:line:rule — never Match/Line/Secret,
# so findings are redacted by construction (plus gitleaks --redact).
# NOTE: no trailing newline after {{end}} — it would emit a stray "\n" on
# clean scans and make an empty findings report look non-empty.
printf '%s' '{{range .}}{{.File}}:{{.StartLine}}:{{.RuleID}}{{"\n"}}{{end}}' > "$TMPL"

mkdir -p "$SCAN_ROOT"
for f in "${staged[@]}"; do
  mkdir -p "$SCAN_ROOT/$(dirname "$f")"
  # Index version of the staged path (works for new and modified files).
  git show ":$f" > "$SCAN_ROOT/$f" 2>/dev/null || {
    fail_closed "failed to read staged version of: $f" \
      "Re-stage the file (git add) and re-run: pnpm run secrets:check"
  }
done

# ── Run gitleaks (capture exit status; do not let set -e abort) ─────
set +e
(
  cd "$SCAN_ROOT" &&
    gitleaks dir . \
      --config "$CONFIG" \
      --no-banner \
      --redact \
      --report-format template \
      --report-template "$TMPL" \
      --report-path "$REPORT"
) >"$STDERR_LOG" 2>&1
STATUS=$?
set -e

# ── Interpret result ─────────────────────────────────────────────────
# Non-empty report = findings (gitleaks exits 1 for both leaks and some
# errors, so the report distinguishes them).
if [[ -s "$REPORT" ]]; then
  echo "secret-scan: FAILED — potential secrets detected in staged changes:" >&2
  while IFS= read -r line; do
    [[ -n "$line" ]] && echo "  $line" >&2
  done < "$REPORT"
  echo "" >&2
  echo "Values are never printed (output is redacted)." >&2
  echo "Fix: remove the secret; load it from the environment or a secrets manager." >&2
  echo "Sanctioned false positive: add a trailing '# gitleaks:allow' comment on that line (see CONTRIBUTING.md)." >&2
  exit 1
fi

if [[ "$STATUS" -ne 0 ]]; then
  echo "secret-scan: scanner failed (exit $STATUS) — failing closed (NOT treated as \"no secrets found\")." >&2
  if [[ -s "$STDERR_LOG" ]]; then
    # gitleaks config/parse errors only; --redact keeps any scanner output safe.
    sed 's/^/  /' "$STDERR_LOG" >&2
  fi
  echo "Check that .gitleaks.toml is valid and gitleaks is current: gitleaks version" >&2
  echo "Re-run: pnpm run secrets:check" >&2
  exit 1
fi

echo "secret-scan: no secrets detected in ${#staged[@]} staged file(s)."
exit 0
