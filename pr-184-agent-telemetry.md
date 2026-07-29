# #184 feat(agent): expose privacy-safe runtime telemetry

Closes #184

## Summary

Adds a `TelemetryCollector` that gathers scheduler task metrics, queue
depth, circuit-breaker states, content performance, and policy-engine
counters — all labeled with bounded, non-secret dimensions. Prompts,
API keys, signatures, and wallet secrets are excluded by design; the
collector redacts any sensitive keys that could slip through.

Exposed via:
- A new `talos-agent telemetry` CLI command (human-readable summary + `--json` flag)
- A periodic `telemetry_log` scheduler task that logs a JSON snapshot every
  30 minutes via structlog.

## Changes

### Telemetry module (`packages/prime-agent/src/talos_agent/telemetry.py`)

New file containing:

- **`TelemetryCollector`** — synchronous collector that reads from the
  local SQLite DB and in-memory circuit-breaker registry.
- **`TelemetryReport`** — dataclass with typed fields:
  - `tasks` — per-scheduler-task metrics (run count, last run, retry
    attempts, terminal state, remaining backoff seconds)
  - `queues` — commerce_queue / activity_log / approval_cache depth
  - `circuit_breakers` — per-provider state, failures, successes
  - `adapters` — adapter health (via external probe results)
  - `content_performance` — 7-day post/impression/engagement summary
  - `policy_metrics` — evaluation/deny/escalation counters
- **Privacy guards**:
  - `_is_sensitive_key()` — returns `True` for labels containing
    `api_key`, `secret`, `signature`, `prompt`, `password`, `token`,
    `wallet_secret`, `private_key`
  - `_redact_if_sensitive()` — replaces matching values with `[REDACTED]`
  - All circuit-breaker provider names are checked; adapter names
    are also redacted if sensitive.

### CLI (`packages/prime-agent/src/talos_agent/cli.py`)

- New `talos-agent telemetry [--json]` command.
- Human-readable output with color-coded states (green=healthy/closed,
  yellow=degraded/half_open, red=open/timeout/terminal).
- JSON output via `--json` flag, safe for dashboards or log pipelines.

### Scheduler (`packages/prime-agent/src/talos_agent/scheduler.py`)

- Added `telemetry_log_task()` — runs every 30 minutes, collects a
  snapshot via `TelemetryCollector`, and logs it via structlog:
  ```json
  {
    "event": "telemetry_snapshot",
    "tasks": [{"name": "agent_cycle", "last_run": "...", "retries": 0}, ...],
    "queues": [{"name": "commerce_queue", "pending": 3, "total": 15}, ...],
    "posts_7d": 5,
    "impressions_7d": 1200,
    "circuit_breakers": [{"provider": "groq", "state": "closed"}, ...],
    "policy_evaluations": 42
  }
  ```

### Tests (`packages/prime-agent/tests/test_telemetry.py`)

- **Positive tests**: metadata, all 8 scheduler tasks present, queue depth,
  content performance, circuit breaker metrics, policy metrics, retry state,
  schedule runs, JSON serialization, `to_dict` cleanup.
- **Negative tests**: sensitive provider names skipped, adapter health
  redaction, `_is_sensitive_key` for various inputs.
- **Privacy test**: `report.to_json()` — confirms `api_key`, `signature`,
  and `wallet_secret` do not appear in the JSON output.

## Privacy guarantee

No prompts, API keys, signatures, wallet secrets, or other sensitive data
appear in the telemetry output. The collector:

1. Reads only aggregate counters and metadata from the local DB.
2. Skips any circuit-breaker provider whose name matches a sensitive pattern.
3. Redacts any adapter detail containing sensitive substrings.
4. Excludes raw tool outputs, LLM responses, and user payloads by design
   (those are not stored in the tables this collector reads).

## Out of scope

Production deployment, live secret changes, or unrelated refactors.
