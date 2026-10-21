# ── Sensitive-field matchers ──────────────────────────────────────────────────
# Delegated to the canonical redact module — kept here as re-exports for
# backward compatibility with callers that import from telemetry.


def _redact_if_sensitive(label: str, value: object) -> object:
    """Return ``"[REDACTED]"`` if *label* indicates a sensitive field."""
    if _is_sensitive_key(label):
        return "[REDACTED]"
    return value
EOF \
echo "=== conflict marker check ===" && \
grep -n "<<<<<<<\|=======\|>>>>>>>" packages/prime-agent/src/talos_agent/telemetry.py && \
echo "(no output above = clean)" && \
echo "=== git add ===" && \
git add packages/prime-agent/src/talos_agent/telemetry.py && \
echo "=== git rebase --continue (GIT_EDITOR=cat) ===" && \
GIT_EDITOR='cat' git rebase --continue 2>&1
