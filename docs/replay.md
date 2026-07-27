# Execution Replay (Issue #235)

Deterministic replay lets maintainers re-run a recorded agent decision cycle
using stored inputs, **without** re-invoking live tools or external APIs.  
It is intended for incident analysis, regression testing, and verifying that
a code change does not alter existing decision logic.

---

## How it works

1. **Recording** — When `replay_enabled = true` (env `REPLAY_ENABLED=true`),
   every `agent_cycle_task` execution:
   - Creates a `replay_sessions` row keyed by the cycle UUID.
   - Persists a sequence of `ReplayEvent` rows: context snapshot,
     completion, and error (if any).
   - Sensitive payload keys are redacted at write time (see below).

2. **Replay** — `talos-agent replay run <session-id>` loads the stored events
   and drives `ReplayRunner.run_with_stubs()`, which walks the event list and
   returns each recorded payload as a stub rather than executing the live tool.
   Any structural difference (missing/extra payload keys, wrong event count)
   is flagged in a divergence report.

3. **Divergence detection** — The runner compares the replayed event sequence
   against the recorded one.  Differences are human-readable strings collected
   in `ReplayResult.divergence_report`.  Exit code is non-zero when diverged.

---

## Configuration

Add to `.env` (or export as env vars):

```env
# Enable replay recording (default: false)
REPLAY_ENABLED=true

# Redact sensitive payload values (default: true — keep this on in production)
REPLAY_REDACT_PAYLOADS=true
```

---

## CLI

```bash
# List recent sessions (all agents)
talos-agent replay list

# Filter by Talos ID
talos-agent replay list --talos-id <talos-id> --limit 10

# Inspect full event log (JSON)
talos-agent replay show <session-id>

# Re-run with stubs and print divergence report
talos-agent replay run <session-id>

# Write report to a file
talos-agent replay run <session-id> --output report.json
```

---

## Redaction

Any payload key whose name contains one of the following fragments
(case-insensitive) is replaced with `"[REDACTED]"` before being written to
the DB:

`key`, `secret`, `token`, `password`, `api_key`, `private`

This means the on-disk DB never stores raw credentials.  Only non-sensitive
context metadata (post counts, timestamps, job counts, message counts) is
preserved in plaintext.

To inspect a session that was recorded with redaction, the `[REDACTED]`
markers appear in `talos-agent replay show` output.

---

## Database schema (migration 7)

Two new SQLite tables are added automatically on startup:

```sql
replay_sessions (session_id PK, talos_id, agent_version, started_at, ended_at, status)
replay_events   (id, session_id FK, event_id, event_type, payload JSON, redacted, recorded_at)
```

Both tables are append-only from the agent's perspective; the CLI only reads.

**Rollback**: disable `REPLAY_ENABLED` (the default).  The tables persist but
no new rows are written.  The tables can be dropped manually without affecting
any other agent functionality.

---

## Version pinning

`agent_version` (from `talos_agent.__version__`) is stored in each session
header.  A session replayed against a newer agent version will show divergence
if the event structure has changed, giving an early warning before a release.

---

## Operational signals

| Log event | When |
|---|---|
| `replay_event_recorded` | Each event persisted |
| `replay_run_complete` | `ReplayRunner.run_with_stubs()` finishes |
| `replay_record_error` | DB write failed (non-fatal, cycle continues) |

All log events use structlog at `DEBUG` / `INFO` level with `session_id` bound.

---

## Known limitations

- Only `agent_cycle_task` events are recorded; other tasks (polling, heartbeat,
  dividend distribution) are not captured.
- The replay runner does not re-invoke the LLM; it replays the *recorded*
  tool call sequence.  If the LLM would have made a different decision with a
  different model version, that is not detectable without a live replay.
- Payload redaction is shallow (top-level keys only).

---

## Local verification steps

```bash
cd packages/prime-agent

# 1. Run all tests (must be 320 passed)
uv run pytest tests/ -v

# 2. Check specific replay tests
uv run pytest tests/test_replay.py -v

# 3. Lint
uv run ruff check src tests

# 4. Smoke-test the CLI (uses default DB path)
uv run talos-agent replay list
```
