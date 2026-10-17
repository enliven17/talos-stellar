# Operational Metrics

This is the canonical definition set for repository and runtime operational
signals. A metric may be calculated from GitHub Actions metadata, local-stack
health checks, or privacy-safe structured logs; this document does not add a
second runtime exporter. Operators may aggregate the listed source events into
the metric names below.

## Contract

- Metric names use lowercase `snake_case` and end in `_total` for counters,
  `_seconds` for durations, and `_bytes` for sizes.
- Counters increase on each matching event. Rates and error ratios are derived
  by the monitoring system, not emitted as mutable application state.
- Dimensions are bounded enums or package names. Never use IDs, URLs, paths,
  request bodies, wallet addresses, key material, payment proofs, or error
  messages as dimensions.
- Missing or malformed source data is `unknown` and must fail the check or
  alert evaluation closed; it must not be treated as zero or success.
- Retries are counted per attempt. Exhaustion is counted once per operation.
- A dependency failure is recorded as a failed signal with its dependency
  name only; raw responses and credentials are excluded.

## Definitions

| Metric | Type / unit | Source | Dimensions | Definition and operational use |
|---|---|---|---|---|
| `ci_workflow_runs_total` | counter | GitHub Actions workflow result | `workflow`, `status` | One completed workflow run. Alert on unexpected `failure` or `cancelled` status. |
| `ci_workflow_duration_seconds` | gauge / seconds | GitHub Actions run metadata | `workflow` | Wall-clock duration from run start to completion. Missing timestamps are invalid. |
| `ci_package_checks_total` | counter | Cross-package CI matrix | `package`, `check`, `status` | One package check (web, sdk, prime-agent, or contracts) and its result. |
| `local_stack_health_checks_total` | counter | `pnpm stack:up` health probes | `service`, `status` | One health probe for Postgres, web, mock Stellar, or optional agent. A timeout is `failure`. |
| `benchmark_runs_total` | counter | `web/src/area/devx` benchmark events | `suite`, `status` | One benchmark suite run. `failed` includes threshold failures and runner errors. |
| `benchmark_duration_seconds` | gauge / seconds | Benchmark result artifact | `suite`, `label` | Measured suite or case duration. Artifact parse failures are invalid, not zero. |
| `benchmark_threshold_violations_total` | counter | Benchmark result artifact | `suite`, `metric`, `severity` | One threshold violation; `severity` is `warn` or `fail`. |
| `db_transaction_retry_attempts_total` | counter | `db_transaction_retry_attempt` log event | `domain` | One retryable transaction attempt after the initial attempt. |
| `db_transaction_retry_exhausted_total` | counter | `db_transaction_retry_exhausted` log event | `domain` | One transaction that exhausted its retry budget. This is an error signal. |
| `job_events_total` | counter | `web/src/lib/jobs/metrics.ts` events | `event`, `queue` | One job lifecycle transition. Do not aggregate raw job IDs as labels. |
| `job_duration_seconds` | gauge / seconds | `job_completed` log event | `queue` | Completion duration for a job. Missing or negative durations are invalid. |
| `outbox_events_total` | counter | `web/src/lib/outbox/metrics.ts` events | `event`, `event_type` | One outbox lifecycle transition, including retries and dead letters. |
| `backup_operations_total` | counter | Backup/restore operational log events | `operation`, `status` | One backup, restore, or status operation. Artifact bytes and passphrases are never recorded. |
| `release_artifact_verifications_total` | counter | Artifact verification workflow | `component`, `status` | One signature, SBOM, or provenance verification result. Missing attestations fail closed. |
| `secret_scan_runs_total` | counter | `pnpm run secrets:check` | `status` | One secret scan. Missing config, missing scanner, and scanner crashes are `failure`. |

## Recommended derived signals

These are queries over the definitions above, not additional metrics:

- **CI failure rate:** failed `ci_workflow_runs_total` divided by completed
  runs over the same workflow and time window.
- **Retry exhaustion rate:** `db_transaction_retry_exhausted_total` divided by
  transaction attempts. Alert before exhaustion becomes user-visible.
- **Outbox dead-letter rate:** `outbox_events_total{event="outbox_event_dead_letter"}`
  divided by written events.
- **Release verification failure:** any failed
  `release_artifact_verifications_total` blocks publication or rollout.
- **Secret-scan health:** any failed `secret_scan_runs_total` blocks the
  change; scanner absence is not a clean result.

## Local verification

Run the definition and privacy contract check from the repository root:

```bash
pnpm metrics:check
```

The check is deliberately dependency-light and fails closed when the document
is missing, malformed, duplicated, contains unbounded dimensions, or omits a
required operational domain.