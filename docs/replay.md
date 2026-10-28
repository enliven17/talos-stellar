# Deterministic Execution Replay

Replay lets maintainers re-run a recorded agent decision from sanitised inputs without repeating external side effects.  It is useful for incident analysis, LLM regression testing, and validating that a code change doesn't change agent behaviour.

## How it works

```
Live cycle                     Replay cycle
──────────────────             ──────────────────────────────────
EventCapture instruments       ReplayStore loads recorded events
agent_loop calls and           StubRegistry queues recorded results
stores redacted events    →    agent_loop re-runs (real LLM call)
→ ReplayStore persists         Tool calls return recorded results
                               check_divergence compares decisions
```

The **LLM call is real** during replay — the model re-reasons from the same sanitised context.  Only tool execution is replaced by recorded results so no side effects (network, DB writes, on-chain transactions) occur.

## Enabling recording

Recording is disabled by default.  Enable it by setting `REPLAY_ENABLED=true` in your `.env`:

```ini
# packages/prime-agent/.env
REPLAY_ENABLED=true            # Enable event capture
REPLAY_MAX_EVENTS=500          # Max events per cycle (default: 500)
REPLAY_MAX_PAYLOAD_BYTES=65536 # Max bytes per event payload (default: 64 KB)
REPLAY_KEEP_SESSIONS=100       # Sessions to retain; oldest pruned (default: 100)
```

The agent records every cycle automatically when enabled.  Sessions are stored in the same SQLite database as the rest of the agent state.

## CLI commands

### List sessions

```bash
uv run talos-agent replay list
uv run talos-agent replay list --talos-id <ID> --status complete --limit 50
```

### Inspect a session

```bash
uv run talos-agent replay show <CYCLE_ID>
uv run talos-agent replay show <CYCLE_ID> --events          # show all events
uv run talos-agent replay show <CYCLE_ID> --events --kind tool_call
```

### Run a replay

```bash
uv run talos-agent replay run <CYCLE_ID>
uv run talos-agent replay run <CYCLE_ID> --json-output      # machine-readable
```

The command exits with:
- `0` — no divergence (replay matched original)
- `1` — replay failed (session not found, LLM error, etc.)
- `2` — divergence detected

### Prune old sessions

```bash
uv run talos-agent replay prune --keep-last 50
uv run talos-agent replay prune --keep-last 50 --talos-id <ID>
```

## Operational signals

All replay operations emit structured log events via `structlog`:

| Event | Fields | Meaning |
|---|---|---|
| `replay_session_saved` | `cycle_id`, `events`, `dropped` | Session persisted after cycle |
| `replay_flush_error` | `cycle_id`, `error` | Failed to write session (non-fatal) |
| `replay_cycle_start` | `cycle_id` | Replay run begins |
| `replay_events_loaded` | `cycle_id`, `count` | Events loaded from store |
| `replay_stubs_built` | `cycle_id`, `tool_count` | Stub registry ready |
| `replay_loop_complete` | `cycle_id`, `message_count` | Re-execution finished |
| `replay_loop_error` | `cycle_id`, `error` | Re-execution failed |
| `replay_divergence_check` | `cycle_id`, `has_divergence`, `diff_count` | Divergence result |
| `replay_version_mismatch` | `recorded`, `running` | Version gap warning |

## Security and redaction

All event payloads are recursively redacted before storage:

- Any mapping key matching `api_key`, `secret`, `password`, `token`, `credential`, `private_key`, `webhook`, `auth`, `bearer`, `master_key`, `session`, `cookie`, `authorization`, and related fragments has its value replaced with `[REDACTED]`.
- String values matching Stellar secret key format (`S…` 56 chars), `ENC::…` envelopes, JWTs, Bearer auth headers, and Talos API key prefixes (`tak_`, `cpk_`) are replaced regardless of key name.
- Redaction is recursive to any depth (capped at 64 levels).
- Payloads exceeding `REPLAY_MAX_PAYLOAD_BYTES` are replaced with a truncation marker rather than stored at full size.

Redaction happens **before** any data is written to SQLite.  The raw un-redacted payloads are never persisted.

## Resource limits

| Limit | Default | Setting |
|---|---|---|
| Events per cycle | 500 | `REPLAY_MAX_EVENTS` |
| Bytes per event payload | 64 KB | `REPLAY_MAX_PAYLOAD_BYTES` |
| Sessions retained per agent | 100 | `REPLAY_KEEP_SESSIONS` |
| Event load limit for replay | 1000 | `--max-events` (future flag) |

Excess events are silently dropped (the `dropped_events` counter in the session row records how many were lost).

## Version pinning

The `agent_version` field in the session row records the running `__version__` at recording time.  If the running version at replay time differs, a warning is printed:

```
⚠ Version mismatch: recorded='0.1.0', running='0.2.0'. Tool behaviour may differ.
```

The replay still proceeds — the operator decides whether the version gap is acceptable for their analysis.

## Concurrency and restart safety

- Each agent cycle creates its own `EventCapture` instance; there is no shared mutable state between concurrent cycles.
- Sessions start in `recording` status and are only marked `complete` or `error` after the cycle finishes.  A crashed agent leaves orphaned `recording` sessions which are visible in `replay list --status recording`.
- `flush_capture` uses `INSERT OR IGNORE` so re-flushing the same capture (e.g. after a retry) is idempotent.
- `start_session` uses `ON CONFLICT DO NOTHING` for the same reason.

## Migration

The replay tables (`replay_sessions`, `replay_events`) are created automatically by `ReplayStore._ensure_schema()` the first time the store is instantiated.  This is called from both the scheduler (when `REPLAY_ENABLED=true`) and the CLI commands.  No manual migration step is needed.

## Rollback

To disable replay without losing existing data:

1. Set `REPLAY_ENABLED=false` in `.env` (or remove the variable).
2. Restart the agent.

No data is deleted.  Existing sessions remain queryable via the CLI.  To reclaim disk space, run `replay prune`.

To remove all replay data:

```sql
-- Connect to the agent SQLite DB directly
DELETE FROM replay_events;
DELETE FROM replay_sessions;
```

## Known limitations

- **Tool schemas are not stored in full.**  During replay the LLM sees minimal tool descriptions (name only).  This may cause slightly different reasoning if the model uses tool descriptions heavily in its decision.
- **Non-deterministic LLM outputs.**  Even with identical inputs the LLM may produce different outputs.  Some divergence is expected and normal.
- **Browser / external state.**  If the original decision depended on live browser state not captured in tool results, the replay will diverge.
- **Max-events truncation.**  If `REPLAY_MAX_EVENTS` was exceeded during recording, the replay will have fewer tool stubs available.  Any extra tool calls will return `{"stub_exhausted": true}` rather than real recorded results.
