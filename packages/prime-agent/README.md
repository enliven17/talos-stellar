# Talos Prime Agent

Autonomous agent corporation runtime for Stellar GTM agents.

## Quickstart

Run Prime Agent locally against the local development stack in minutes using mock services.

### 1. Prerequisites

- Python 3.10+
- Docker and Docker Compose (to run the local stack)
- Git

### 2. Start the Local Stack

From the repository root, start the local dependencies (PostgreSQL, Mock Stellar Horizon/Soroban, Web API):

```bash
# From repository root
./scripts/local-stack.sh up
```

Verify services are accessible:
- Web API: [http://localhost:3000](http://localhost:3000)
- Health check: [http://localhost:3000/api/health](http://localhost:3000/api/health)
- Mock Stellar: [http://localhost:4010/health](http://localhost:4010/health)

### 3. Install the Agent

Navigate to `packages/prime-agent` and install dependencies in editable mode:

```bash
cd packages/prime-agent

# Install package and development tools
pip install -e .[dev]
```

### 4. Configure Environment

Copy `.env.example` to create your local `.env`:

```bash
cp .env.example .env
```

Point `TALOS_API_URL` to your local stack and configure agent credentials:

```dotenv
# Point at local stack web API
TALOS_API_URL=http://localhost:3000

# Agent API key (tak_...) and ID
TALOS_API_KEY=tak_dev_test
TALOS_ID=agent-local-test

# LLM inference key (Groq recommended for free tier, or OpenAI fallback)
GROQ_API_KEY=gsk_...
# OPENAI_API_KEY=sk-...

# For local development, keep headless false to inspect browser interactions
BROWSER_HEADLESS=false
```

### 5. Run the Agent

Start the agent runtime:

```bash
talos-agent start
```

Or run via Python module:

```bash
python -m talos_agent start
```

You can inspect command-line options and subcommands with:

```bash
talos-agent --help
```

## Configuration Reference

The agent is configured via environment variables and/or `~/.talos-agent/config.json`. Every setting defined in `src/talos_agent/config.py` and `.env.example` is listed below:

| Name | Environment Variable | Default | Required | Description |
|---|---|---|---|---|
| `talos_api_url` | `TALOS_API_URL` | `https://talos-stellar.vercel.app` | No | Base URL of the Talos Web API. Point to `http://localhost:3000` for local stack. |
| `talos_api_key` | `TALOS_API_KEY` | *(empty)* | No | Agent API key issued at Genesis (`tak_...`). |
| `talos_id` | `TALOS_ID` | *(empty)* | No | Talos agent identifier (resolved from API key if left blank). |
| `talos_api_keys` | `TALOS_API_KEYS` | *(empty)* | No | Comma-separated list of API keys for multi-agent mode. |
| `groq_api_key` | `GROQ_API_KEY` | *(empty)* | No | Groq API key for LLM inference (preferred/recommended). |
| `groq_model` | `GROQ_MODEL` | `llama-3.3-70b-versatile` | No | Groq model name to use for inference. |
| `openai_api_key` | `OPENAI_API_KEY` | *(empty)* | No | OpenAI API key (fallback if Groq is not configured). |
| `openai_model` | `OPENAI_MODEL` | `gpt-4o-mini` | No | OpenAI model name to use when falling back to OpenAI. |
| `model_routing_enabled` | `MODEL_ROUTING_ENABLED` | `false` | No | Enable policy-driven model routing and fallback. When enabled, provider selection considers task type, cost, latency, privacy, and availability. When disabled (default), the legacy Groq-first/OpenAI-fallback behaviour is used. |
| `routing_fallback_enabled` | `ROUTING_FALLBACK_ENABLED` | `true` | No | When model routing is enabled, attempt fallback to alternative providers if the primary provider fails or is unavailable. Only meaningful when model_routing_enabled is True. |
| `routing_max_cost_usd` | `ROUTING_MAX_COST_USD` | `0` | No | Maximum cost per LLM call in USD when routing is enabled. 0 means no cost limit. Used by the routing policy to prefer cheaper providers when cost is constrained. |
| `routing_preferred_provider` | `ROUTING_PREFERRED_PROVIDER` | *(empty)* | No | Explicit provider name to prefer when routing is enabled. Empty string means auto-select based on policy. When set, the router uses this provider if it is available and meets capability requirements. |
| `routing_budget_enabled` | `ROUTING_BUDGET_ENABLED` | `false` | No | Enable usage accounting and budget tracking for provider calls. When enabled, the UsageTracker records token counts, costs, and checks budgets before allowing further calls. |
| `backup_retention_enabled` | `BACKUP_RETENTION_ENABLED` | `false` | No | Prune old local backup artifacts after each successful backup, according to backup_retention_max_count / backup_retention_max_age_days. When disabled (default), backups accumulate forever (legacy behavior). |
| `backup_retention_max_count` | `BACKUP_RETENTION_MAX_COUNT` | `10` | No | Maximum number of backup artifacts to keep per agent scope. 0 means unlimited (age-based pruning only, if enabled). |
| `backup_retention_max_age_days` | `BACKUP_RETENTION_MAX_AGE_DAYS` | `30` | No | Maximum age in days of a backup artifact before it is eligible for pruning. 0 means unlimited (count-based pruning only, if enabled). |
| `api_client_response_max_bytes` | `TALOS_API_CLIENT_RESPONSE_MAX_BYTES` | `1048576` | No | Maximum bytes allowed in a Talos Web API response body. Responses that exceed this limit are rejected with ResponseTooLargeError before the body is decoded. Default 1 MiB. Min 1 KiB, max 100 MiB. |
| `x_username` | `X_USERNAME` | *(empty)* | No | X (Twitter) account username. |
| `x_password` | `X_PASSWORD` | *(empty)* | No | X (Twitter) account password. |
| `x_email` | `X_EMAIL` | *(empty)* | No | X (Twitter) verification email address. |
| `discord_webhook_url` | `DISCORD_WEBHOOK_URL` | *(empty)* | No | Discord webhook URL for sending outbound messages. |
| `discord_bot_token` | `DISCORD_BOT_TOKEN` | *(empty)* | No | Discord bot token for REST API operations (replies, mentions). |
| `discord_channel_id` | `DISCORD_CHANNEL_ID` | *(empty)* | No | Default Discord channel ID. |
| `discord_guild_id` | `DISCORD_GUILD_ID` | *(empty)* | No | Discord guild/server ID. |
| `channel_configs` | `CHANNEL_CONFIGS` | `{}` | No | Per-channel credentials map |
| `telegram_bot_token` | `TELEGRAM_BOT_TOKEN` | *(empty)* | No | Telegram bot token from BotFather. |
| `telegram_chat_id` | `TELEGRAM_CHAT_ID` | *(empty)* | No | Telegram target chat ID or @channel username. |
| `telegram_parse_mode` | `TALOS_TELEGRAM_PARSE_MODE` | `none` | No | Telegram message parse mode: none, HTML, or MarkdownV2. |
| `telegram_rate_limit_enabled` | `TALOS_TELEGRAM_RATE_LIMIT_ENABLED` | `false` | No | Enable Telegram send queue and rate limiting. |
| `telegram_min_interval_seconds` | `TALOS_TELEGRAM_MIN_INTERVAL_SECONDS` | `1.0` | No | Minimum interval in seconds between Telegram sends. |
| `telegram_max_per_minute` | `TALOS_TELEGRAM_MAX_PER_MINUTE` | `20` | No | Maximum Telegram messages sent per minute. |
| `telegram_queue_max_size` | `TALOS_TELEGRAM_QUEUE_MAX_SIZE` | `1000` | No | Maximum pending messages in the Telegram queue. |
| `telegram_queue_max_attempts` | `TALOS_TELEGRAM_QUEUE_MAX_ATTEMPTS` | `5` | No | Maximum send attempts per queued Telegram message. |
| `telegram_queue_max_age_seconds` | `TALOS_TELEGRAM_QUEUE_MAX_AGE_SECONDS` | `3600.0` | No | Maximum age in seconds before a queued Telegram message expires. |
| `telegram_queue_drain_interval_seconds` | `TALOS_TELEGRAM_QUEUE_DRAIN_INTERVAL_SECONDS` | `1.0` | No | Interval in seconds between Telegram queue drain cycles. |
| `secret_rotation_enabled` | `TALOS_SECRET_ROTATION_ENABLED` | `false` | No | Enable versioned encrypted secret rotation. |
| `secret_keyring` | `TALOS_SECRET_KEYRING` | *(empty)* | No | JSON keyring of key ID to URL-safe base64 32-byte secret keys. |
| `secret_active_key_id` | `TALOS_SECRET_ACTIVE_KEY_ID` | *(empty)* | No | Active key ID in the keyring used for new encryptions. |
| `secret_scope` | `TALOS_SECRET_SCOPE` | `default` | No | Partitioning scope for stored secrets. |
| `secret_dual_read` | `TALOS_SECRET_DUAL_READ` | `true` | No | Allow reading secrets in both encrypted and plaintext formats. |
| `secret_legacy_fallback` | `TALOS_SECRET_LEGACY_FALLBACK` | `true` | No | Fall back to unencrypted legacy secret format if decryption fails. |
| `secret_max_bytes` | `TALOS_SECRET_MAX_BYTES` | `65536` | No | Maximum size in bytes for a secret value. |
| `secret_db_timeout_ms` | `TALOS_SECRET_DB_TIMEOUT_MS` | `5000` | No | Database busy timeout in milliseconds for the secret store. |
| `secret_store_backend` | `TALOS_SECRET_STORE_BACKEND` | `sqlite` | No | Pluggable secret-store backend: sqlite (default) or memory |
| `adapter_sandbox_enabled` | `TALOS_ADAPTER_SANDBOX_ENABLED` | `false` | No | Enable third-party adapter capability sandbox. |
| `adapter_capability_manifests` | `TALOS_ADAPTER_CAPABILITY_MANIFESTS` | *(empty)* | No | Path or JSON specification of adapter capability manifests. |
| `adapter_timeout_seconds` | `TALOS_ADAPTER_TIMEOUT_SECONDS` | `30` | No | Execution timeout in seconds for adapter invocations. |
| `adapter_max_concurrency` | `TALOS_ADAPTER_MAX_CONCURRENCY` | `2` | No | Maximum concurrent adapter invocations. |
| `adapter_max_input_bytes` | `TALOS_ADAPTER_MAX_INPUT_BYTES` | `16384` | No | Maximum input payload size in bytes for an adapter call. |
| `adapter_max_output_bytes` | `TALOS_ADAPTER_MAX_OUTPUT_BYTES` | `262144` | No | Maximum output payload size in bytes for an adapter call. |
| `adapter_max_network_requests` | `TALOS_ADAPTER_MAX_NETWORK_REQUESTS` | `8` | No | Maximum outbound network requests per adapter invocation. |
| `adapter_invocation_lease_seconds` | `TALOS_ADAPTER_INVOCATION_LEASE_SECONDS` | `120` | No | Lease duration in seconds for in-flight adapter invocations. |
| `adapter_max_invocation_records` | `TALOS_ADAPTER_MAX_INVOCATION_RECORDS` | `100000` | No | Maximum retained invocation audit records. |
| `adapter_retry_configs` | `TALOS_ADAPTER_RETRY_CONFIGS` | `{}` | No | Per-adapter retry and circuit breaker settings as JSON |
| `policy_engine_enabled` | `POLICY_ENGINE_ENABLED` | `false` | No | Enable the declarative policy engine for autonomous actions |
| `tool_permission_mode` | `TOOL_PERMISSION_MODE` | `audit` | No | Tool permission enforcement: off | audit | enforce |
| `tool_permission_grants` | `TOOL_PERMISSION_GRANTS` | `{}` | No | Operator-approved capability grants for tools |
| `agent_cycle_interval` | `AGENT_CYCLE_INTERVAL` | `30` | No | Seconds between agent cycles |
| `polling_interval` | `POLLING_INTERVAL` | `10` | No | Seconds between API polls |
| `heartbeat_interval` | `HEARTBEAT_INTERVAL` | `60` | No | Seconds between heartbeats |
| `max_iterations` | `MAX_ITERATIONS` | `20` | No | Max tool-call iterations per cycle |
| `approval_threshold` | `APPROVAL_THRESHOLD` | `10` | No | USD threshold for auto-approval |
| `browser_headless` | `BROWSER_HEADLESS` | `false` | No | Run browser in headless mode |
| `auto_repay_loans` | `AUTO_REPAY_LOANS` | `false` | No | Enable automatic loan repayment from treasury |
| `tool_timeout_seconds` | `TALOS_TOOL_TIMEOUT_SECONDS` | `30` | No | Maximum seconds for a single external tool call before it is cancelled. |
| `job_lease_ttl` | `JOB_LEASE_TTL` | `300` | No | Seconds for a claimed job lease TTL |
| `job_heartbeat_interval` | `JOB_HEARTBEAT_INTERVAL` | `60` | No | Seconds between job lease heartbeats |
| `talos_durable_job_effects_enabled` | `TALOS_DURABLE_JOB_EFFECTS_ENABLED` | `false` | No | Persist provider jobs and completion effects before external delivery |
| `talos_job_effect_dispatch_interval` | `TALOS_JOB_EFFECT_DISPATCH_INTERVAL` | `2` | No | Seconds between durable effect dispatcher sweeps. |
| `talos_job_effect_lease_seconds` | `TALOS_JOB_EFFECT_LEASE_SECONDS` | `30` | No | Lease timeout in seconds for claimed job effect records. |
| `talos_job_effect_max_attempts` | `TALOS_JOB_EFFECT_MAX_ATTEMPTS` | `8` | No | Maximum delivery attempts before marking effect failed. |
| `talos_job_effect_retry_base_seconds` | `TALOS_JOB_EFFECT_RETRY_BASE_SECONDS` | `2` | No | Base backoff delay in seconds for effect delivery retries. |
| `talos_job_effect_batch_size` | `TALOS_JOB_EFFECT_BATCH_SIZE` | `20` | No | Maximum number of job effect records processed per batch. |
| `talos_job_effect_max_inbox_records` | `TALOS_JOB_EFFECT_MAX_INBOX_RECORDS` | `100000` | No | Maximum retained inbox records before pruning. |
| `talos_job_effect_max_outbox_records` | `TALOS_JOB_EFFECT_MAX_OUTBOX_RECORDS` | `100000` | No | Maximum retained outbox records before pruning. |
| `talos_job_effect_max_payload_bytes` | `TALOS_JOB_EFFECT_MAX_PAYLOAD_BYTES` | `65536` | No | Maximum payload size in bytes for inbox job records. |
| `talos_job_effect_max_result_bytes` | `TALOS_JOB_EFFECT_MAX_RESULT_BYTES` | `262144` | No | Maximum result size in bytes for outbox job records. |
| `talos_job_effect_dispatch_timeout_seconds` | `TALOS_JOB_EFFECT_DISPATCH_TIMEOUT_SECONDS` | `20` | No | Timeout in seconds for dispatching a job effect. |
| `talos_job_effect_db_timeout_ms` | `TALOS_JOB_EFFECT_DB_TIMEOUT_MS` | `5000` | No | Database busy timeout in milliseconds for job effects. |
| `a2a_connect_timeout` | `A2A_CONNECT_TIMEOUT` | `10.0` | No | Seconds to wait for A2A TCP connect |
| `a2a_read_timeout` | `A2A_READ_TIMEOUT` | `30.0` | No | Seconds to wait for A2A response body |
| `a2a_write_timeout` | `A2A_WRITE_TIMEOUT` | `10.0` | No | Seconds to wait to send A2A request body |
| `a2a_pool_timeout` | `A2A_POOL_TIMEOUT` | `5.0` | No | Seconds to wait for A2A connection from pool |
| `shutdown_deadline` | `SHUTDOWN_DEADLINE` | `30.0` | No | Seconds to wait for in-flight tasks to finish after shutdown is requested before they are forcibly cancelled. Set to 0 to cancel immediately. |
| `dividend_distribution_interval` | `DIVIDEND_DISTRIBUTION_INTERVAL` | `3600` | No | Seconds between dividend distribution checks |
| `dividend_usdc_threshold` | `DIVIDEND_USDC_THRESHOLD` | `100` | No | USDC threshold to trigger dividend distribution |
| `replay_enabled` | `REPLAY_ENABLED` | `false` | No | Enable execution replay recording for incident analysis |
| `replay_redact_payloads` | `REPLAY_REDACT_PAYLOADS` | `true` | No | Redact sensitive values in replay event payloads |

## Related Documentation

Additional architectural, configuration, and operational guides:

- **Package Documentation (`packages/prime-agent/docs/`)**:
  - [A2A Composition](./docs/a2a_composition.md) — Agent-to-Agent communication protocols and timeouts.
  - [Adapter Diagnostics](./docs/adapter-diagnostics.md) — Adapter health checks, status reporting, and troubleshooting.
  - [Adapter Health Snapshots](./docs/adapter-health-snapshots.md) — Runtime health snapshot captures and telemetry.
  - [Discord Reconnect Policy](./docs/discord-reconnect-policy.md) — Connection lifecycle and reconnect backoff behavior for Discord.
  - [Logging Policy](./docs/LOGGING_POLICY.md) — Structured logging standards, redaction rules, and severity levels.
  - [Policy Engine](./docs/policy-engine.md) — Declarative policy engine rules, evaluation, and enforcement.
  - [Telegram Rate Limit Queue](./docs/telegram-rate-limit-queue.md) — Telegram message queuing and rate limiting.
  - [Tool Permissions](./docs/tool-permissions.md) — Capability manifests, permission modes, and operator grants.

- **Root Specifications & Runbooks (`docs/prime-agent-*.md`)**:
  - [Adapter Capability Sandbox](../../docs/prime-agent-adapter-capability-sandbox.md) — Security boundaries and capability manifests for third-party adapters.
  - [Durable Job Effects](../../docs/prime-agent-durable-job-effects.md) — Inbox/outbox durability guarantees, rollout, and recovery runbook.
  - [Secret Rotation](../../docs/prime-agent-secret-rotation.md) — Versioned keyring rotation and dual-read encryption lifecycle.
  - [Stellar Retry Failures](../../docs/prime-agent-stellar-retry-failures.md) — Transaction error classification, retry safety, and operational handling.

## API Client Response Size Cap (issue #561)

All HTTP responses from the Talos Web API are bounded before the body is
decoded. This prevents memory exhaustion from oversized or malicious responses
and closes a potential information-disclosure path where a very large response
could be logged or stored.

### How it works

1. **Content-Length fast-reject** — if the server declares a body size that
   already exceeds the limit, the request is rejected immediately before any
   body bytes are read.
2. **Body measurement** — after httpx buffers the response, `len(response.content)`
   is checked as the authoritative byte count. This catches cases where the
   server omits or lies about `Content-Length`.
3. **`ResponseTooLargeError`** — raised on any violation. The error carries only
   `url_path`, `actual_bytes`, and `limit_bytes`. Response bodies, headers,
   secrets, seeds, and payment proofs are never included in the error.

### Configuration

| Variable | Default | Range | Description |
|---|---|---|---|
| `TALOS_API_CLIENT_RESPONSE_MAX_BYTES` | `1048576` (1 MiB) | 1 KiB–100 MiB | Maximum allowed response body size |

To tighten the cap in a constrained environment:

```bash
TALOS_API_CLIENT_RESPONSE_MAX_BYTES=262144  # 256 KiB
```

### Error handling

`ResponseTooLargeError` is importable from `talos_agent.http`. Callers that
need to handle it explicitly can do so:

```python
from talos_agent.http import ResponseTooLargeError

try:
    result = await api_client.get_talos(talos_id)
except ResponseTooLargeError as exc:
    logger.warning(
        "API response too large path=%s actual=%d limit=%d",
        exc.url_path, exc.actual_bytes, exc.limit_bytes,
    )
```

### Compatibility

All existing public methods (`get_talos`, `report_activity`, `update_status`,
`get_pending_jobs`, etc.) are unaffected — typical JSON responses are well
under 1 MiB. The cap only fires on responses that exceed the configured limit.

## Checkpoint Export and Inspection

The checkpoint CLI provides safe operator commands for exporting and inspecting an agent checkpoint without modifying the running agent or its SQLite database.

Exports are deterministic, size-bounded, and written atomically. Inspection supports both human-readable and JSON output while exposing only non-sensitive checkpoint metadata.

### Export a Checkpoint

```bash
talos-agent checkpoint export \
  --agent agent-1 \
  --output checkpoint.json
```

Available options:

* `--agent`: Agent identifier. Required.
* `--output`: Destination checkpoint file. Required.
* `--schema-version`: Checkpoint schema version. Defaults to `1`.
* `--max-size`: Maximum permitted output size in bytes. Defaults to 10 MiB.

The source database is opened using SQLite read-only mode with query-only enforcement. Export runs inside a consistent read transaction so all table counts come from one database snapshot, even when the agent is active.

The destination is written through a temporary file, flushed to disk, and atomically moved into place. Repeated exports to the same destination replace the previous file with a complete checkpoint and never leave partial output.

The command refuses to use the source agent database as the output path.

### Inspect a Checkpoint

Human-readable output:

```bash
talos-agent checkpoint inspect \
  --input checkpoint.json
```

JSON output:

```bash
talos-agent checkpoint inspect \
  --input checkpoint.json \
  --json
```

Available options:

* `--input`: Checkpoint file to inspect. Required.
* `--json`: Return the summary as JSON.
* `--max-size`: Maximum permitted input size in bytes. Defaults to 10 MiB.

Inspection validates:

* JSON document structure
* Supported schema version
* Agent identifier format
* Recognised checkpoint table names
* Non-negative integer row counts
* Configured file-size bounds

### Checkpoint Contents

Checkpoint schema version `1` contains operator-safe metadata:

* Agent identifier
* Schema version
* Row counts for recognised agent-state tables

Stored row values are not included. This prevents the commands from exposing credentials, configuration values, generated content, job payloads, wallet details, transaction data, approval descriptions, or other sensitive information.

### Exit Codes

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | Command completed successfully                                    |
| `2`  | Invalid arguments, invalid checkpoint data, or size-limit failure |
| `3`  | Unsupported checkpoint schema version                             |
| `4`  | Database, filesystem, or permission failure                       |

These exit codes are stable and may be used by shell scripts and operator tooling.

### Authorisation

Checkpoint access follows the local operating-system permission boundary.

The invoking user must have permission to:

* Read the selected agent database
* Read checkpoint files being inspected
* Write to the selected export directory

Permission failures produce a clear access-denied message and return exit code `4`.

### Deterministic Behaviour

* Concurrent exports never leave partial checkpoint files.
* Repeated exports of unchanged state produce identical checkpoint bytes.
* Interrupted exports remove temporary files and preserve any existing destination.
* Failed exports do not modify the source database or damage an existing checkpoint.
* Exported checkpoints remain inspectable across separate CLI invocations and process restarts.

Retry and network-timeout behaviour are not required because export and inspection operate only on bounded local SQLite and filesystem resources.

### Observability

A successful export prints the final checkpoint destination.

Validation, compatibility, permission, and I/O failures print a clear error message and return the corresponding stable exit code. Sensitive database values are never written to command output.

### Migration and Rollback

Checkpoint export does not initialise `LocalDB`, run migrations, change `PRAGMA user_version`, create database tables, or modify runtime state.

No database rollback procedure is required because the source operation is read-only. To remove an exported checkpoint, delete the generated file.

Failed or cancelled exports preserve the previous destination file and clean up temporary files automatically.

### Scope Boundaries

These commands provide the operator-facing export and inspection workflow for checkpoint schema version `1`.

Checkpoint restoration, encryption, remote storage, retention policies, and scheduled exports are separate lifecycle capabilities and are not performed by these commands.

### Implementation Files

* [`src/talos_agent/checkpoint_cli.py`](./src/talos_agent/checkpoint_cli.py) contains the checkpoint export and inspection commands, validation, atomic file handling, read-only database access, summary formatting, and stable exit-code handling.
* [`src/talos_agent/cli.py`](./src/talos_agent/cli.py) registers the `checkpoint` command group with the main `talos-agent` CLI.
* [`tests/test_checkpoint_cli.py`](./tests/test_checkpoint_cli.py) contains unit and real SQLite boundary tests covering successful exports, inspection, validation failures, permissions, size limits, concurrency, duplicate exports, cancellation, restart behaviour, and source-state protection.

## Database Migrations

This package implements an automated schema versioning and migration framework using SQLite's native `PRAGMA user_version` capability.

### How Schema Versioning Works

1. **Schema Version Tracking**: SQLite's native `PRAGMA user_version` integer is used to track the database schema version. Fresh databases start at version `0`.
2. **Ordered Migrations**: Migrations are registered in `_MIGRATIONS` inside [db.py](./src/talos_agent/db.py). They are ordered sequentially ascending by their version integer.
3. **Automatic Upgrades**: When a `LocalDB` connection is initialized:
   - The current `user_version` is checked.
   - Any migrations in `_MIGRATIONS` with a version greater than `user_version` are run sequentially.
   - The run is wrapped in a single database transaction. If any migration fails, the entire transaction is rolled back, leaving `user_version` and the database schema unchanged.
   - Once all pending migrations execute successfully, `PRAGMA user_version` is set to the latest version, and the transaction commits.

### How to Add a Migration

When modifying the SQLite database schema, follow these rules:

1. **Never modify old migrations**: Once a migration version is committed, its SQL script must not be changed.
2. **Always append new migrations**: Add new schema updates to the end of the `_MIGRATIONS` registry.
3. **Increment the version number**: The version of the new migration must be strictly greater than the previous version.
4. **Add tests**: When introducing a new migration, add automated tests to verify the schema updates work correctly.

#### Example

To add a new column `confidence` to the `strategy_learnings` table:

```python
_MIGRATIONS.append(
    (
        5,
        '''
        ALTER TABLE strategy_learnings
        ADD COLUMN confidence REAL DEFAULT 0;
        '''
    )
)
```

### Example Workflow

1. Update the migrations registry in [db.py](./src/talos_agent/db.py):
   ```python
   _MIGRATIONS = [
       (1, "..."),
       (2, "-- no-op example migration"),
       (3, """
       ALTER TABLE approval_cache
       ADD COLUMN notes TEXT;
       """),
   ]
   ```
2. Run pytest to ensure all tests pass:
   ```bash
   pytest tests/
   ```
3. Deploy. The database will automatically upgrade on startup.

## Coverage Enforcement (issue #638)

Critical agent modules — payments, crypto/secrets, durability (checkpoint/
restore/db), scheduling, policy engine, and network resilience — carry a hard
**per-module** coverage floor. Thresholds live in one place:
`COVERAGE_FLOORS` in [`scripts/check-coverage.py`](./scripts/check-coverage.py).
The global `fail_under` backstop lives in `[tool.coverage.report]` in
`pyproject.toml`.

### Exact local commands

```bash
cd packages/prime-agent

# 1. Run the suite with coverage enabled (produces coverage.json)
uv run pytest tests/ --cov --cov-report=json --cov-report=term

# 2. Run the per-module gate (same command CI runs)
uv run python scripts/check-coverage.py coverage.json
```

The gate exits `0` when every critical module is at or above its floor and `1`
with an explicit per-module failure list otherwise. It also fails closed on a
missing, malformed, or unexpected-format report instead of silently passing.

### Raising the floor / adding a module

1. Improve tests for the module until its reported percentage meets the new
   floor.
2. Update (or add) the entry in `COVERAGE_FLOORS` in
   `scripts/check-coverage.py`.
3. Re-run both commands above.

Non-critical modules are covered by the global `fail_under` backstop in
`pyproject.toml` rather than a per-module floor, so unrelated low-coverage code
does not block unrelated work. When a module becomes load-bearing (money,
identity, durability), add it to `COVERAGE_FLOORS`.

## Deployment

### Running the Docker Container

The container is configured to run as an unprivileged non-root user `talos` (UID 1000) for security hardening.

To build and run the Docker container locally:
```bash
# Build the image
docker build -t prime-agent .

# Run the container (which automatically runs as user 'talos')
docker run --rm prime-agent
```

## Durable provider-job effects

The opt-in durable inbox/outbox prevents provider job results from being lost
or executed twice across crashes. It is disabled by default with
`TALOS_DURABLE_JOB_EFFECTS_ENABLED=false`.

Before enabling it, read the
[durable job effects runbook](../../docs/prime-agent-durable-job-effects.md).
The runbook documents the exact external idempotency boundary, configuration,
migration, structured operational events, metadata-only replay inspection,
recovery procedure, known limitations, and rollback steps.

## Stellar transaction retry failures

Stellar transfer failures are classified as `retryable`, `rate_limited`,
`indeterminate`, `permanent`, or `unknown` so callers and operators can decide
whether a transaction is safe to retry. The classification is privacy-safe —
no seeds, payment proofs, or raw upstream text are logged or returned — and is
surfaced through the existing payment proxy and tool results.

See the
[Stellar retry failure runbook](../../docs/prime-agent-stellar-retry-failures.md)
for the input → class mapping, privacy guarantees, compatibility notes, and
how to consume the classification.
