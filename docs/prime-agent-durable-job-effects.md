# Prime Agent durable job effects

Status: implementation design and operator runbook for issue #226.

## Goal and boundary

The durable job-effect path protects provider-side commerce jobs: the Prime
Agent receives a job, claims its remote fencing lease, computes a result, and
submits that result to the Talos Web API. When enabled, the local SQLite
database becomes the durable source of truth for the job inbox and result
outbox.

```text
Web API pending job
  -> bounded durable inbox
  -> remote fenced claim
  -> result prepared atomically with one outbox effect
  -> leased outbox dispatcher
  -> POST /api/jobs/{id}/result
  -> GET /api/jobs/{id}/result reconciliation
  -> inbox completed + outbox succeeded
```

This change does not attempt to make arbitrary Python side effects exactly
once. External exactly-once completion depends on the Web API's durable job
identity, fencing-token check, completed-state uniqueness, and result
reconciliation. A receiver without an idempotent or reconcilable contract can
only provide at-least-once delivery.

The Web API completion update compares the job ID, fencing token, and
`status='pending'` in the same transaction that records revenue. Concurrent
completion requests therefore have one winner; a loser receives `409` and the
agent reconciles the already-completed result with `GET`.

## Data model and invariants

Migration 7 adds:

- `job_inbox`: one row per `(owner_talos_id, job_id)`, including a canonical,
  size-bounded request payload, its SHA-256 digest, processing state, fencing
  token, and lease metadata.
- `job_effect_outbox`: one row per stable effect key. For job completion the
  key is derived from the Talos owner and job ID. The canonical, size-bounded
  result and its digest are persisted before network I/O.
- indexes for bounded status and retry scans.

The following invariants are enforced in SQLite transactions:

1. Re-delivering the same job and payload is idempotent.
2. Reusing a job ID with a different payload is rejected.
3. Preparing the same result creates one effect and is idempotent.
4. Preparing a different result for an existing effect is rejected.
5. Only one process can hold an outbox dispatch lease at a time.
6. A stale lease owner cannot complete or reschedule an effect.
7. Inbox completion and outbox success are committed atomically.
8. A lost POST response is reconciled with GET before the effect is retried.

SQLite `BEGIN IMMEDIATE`, compare-and-swap updates, durable lease owner IDs,
fencing tokens, `synchronous=FULL`, and foreign-key enforcement provide
cross-process correctness and crash-consistent commits. Process-local locks
are not used for shared state.

## Configuration

The feature is disabled by default.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `TALOS_DURABLE_JOB_EFFECTS_ENABLED` | `false` | Enables the inbox/outbox path. |
| `TALOS_JOB_EFFECT_DISPATCH_INTERVAL` | `2` | Seconds between outbox scans. |
| `TALOS_JOB_EFFECT_LEASE_SECONDS` | `30` | Dispatcher lease duration. |
| `TALOS_JOB_EFFECT_MAX_ATTEMPTS` | `8` | Attempts before an effect becomes dead-lettered. |
| `TALOS_JOB_EFFECT_RETRY_BASE_SECONDS` | `2` | Exponential retry base. |
| `TALOS_JOB_EFFECT_BATCH_SIZE` | `20` | Maximum effects claimed per scan. |
| `TALOS_JOB_EFFECT_MAX_INBOX_RECORDS` | `100000` | Hard inbox capacity. |
| `TALOS_JOB_EFFECT_MAX_OUTBOX_RECORDS` | `100000` | Hard outbox capacity. |
| `TALOS_JOB_EFFECT_MAX_PAYLOAD_BYTES` | `65536` | Maximum canonical job payload size. |
| `TALOS_JOB_EFFECT_MAX_RESULT_BYTES` | `262144` | Maximum canonical result size. |
| `TALOS_JOB_EFFECT_DISPATCH_TIMEOUT_SECONDS` | `20` | Timeout for one result delivery attempt. |
| `TALOS_JOB_EFFECT_DB_TIMEOUT_MS` | `5000` | Maximum SQLite lock wait. |
| `JOB_LEASE_TTL` | `300` | Remote fenced lease duration, bounded to 600 seconds. |
| `JOB_HEARTBEAT_INTERVAL` | `60` | Remote lease heartbeat interval. |

Configuration values have additional hard upper bounds in `Settings`.

## State transitions and recovery

Inbox states are `received`, `claimed`, `effect_pending`, `completed`, and
`conflict`. Outbox states are `pending`, `dispatching`, `succeeded`,
`retryable`, `indeterminate`, `conflict`, and `dead`.

On restart, `dispatching` rows with expired leases become eligible for
reconciliation. The dispatcher first asks the Web API for the job result:

- the same completed result marks the effect succeeded without another POST;
- a different completed result marks a conflict and never overwrites it;
- a pending remote job allows the same stable effect to be retried;
- an unavailable remote state leaves the effect indeterminate for a later
  bounded retry.

Duplicate delivery and duplicate tool calls return the existing durable state.
After `TALOS_JOB_EFFECT_MAX_ATTEMPTS`, automatic dispatch stops at `dead`.

## Security and observability

- Job IDs, Talos IDs, service names, and serialized JSON have strict type,
  character, and byte limits.
- Inbox payloads and outbox results are required for crash recovery and are
  stored in the local SQLite database. The database file is restricted to its
  owner (`0600`) on supported platforms; operators must also encrypt the
  underlying volume when payload confidentiality at rest is required.
- CLI inspection never prints payloads, results, digests, credentials, or
  exception messages.
- Structured events contain only IDs, state, attempt count, and stable error
  codes. They never contain job payloads, result bodies, API keys, or user
  content.
- Replay requests use compare-and-swap attempt checks, an explicit Talos scope,
  and the owner-only local database permission boundary. The local CLI does not
  provide an additional remote-authentication layer.
- Capacity, scan batch, payload, result, lease, retry, and attempt bounds
  prevent unbounded resource use.

Operational events:

- `job_inbox_transition`
- `job_effect_transition`
- `job_effect_reconciled`
- `job_effect_dispatch_failed`
- `job_effect_capacity_rejected`

Useful states to alert on are `indeterminate`, `conflict`, and `dead`.

## Replay inspection

Inspection is metadata-only:

```bash
uv run talos-agent jobs inspect --talos-id "$TALOS_ID" --status indeterminate
uv run talos-agent jobs inspect --talos-id "$TALOS_ID" --status dead --json
```

An operator can requeue a `retryable`, `indeterminate`, or `dead` effect after
checking the receiver:

```bash
uv run talos-agent jobs retry EFFECT_ID \
  --talos-id "$TALOS_ID" \
  --expected-attempt 8
```

The expected attempt makes duplicate operator delivery idempotent and rejects
stale decisions.

## Rollout, compatibility, and rollback

1. Back up the agent database.
2. Deploy with `TALOS_DURABLE_JOB_EFFECTS_ENABLED=false`. Migration 7 is
   additive and legacy tools continue unchanged.
3. Enable the feature on one agent and watch transition/error counts.
4. Verify duplicate fulfillment, restart reconciliation, and dead-letter
   inspection before widening rollout.

To roll back, set `TALOS_DURABLE_JOB_EFFECTS_ENABLED=false` and restart. The
legacy in-memory claim and direct-submit path is restored. Do not delete inbox
or outbox rows until all non-terminal effects have been reconciled. If another
pending PR adds migration 7 first, rebase this change and renumber its additive
migration before merge; no data rewrite is otherwise required.

## Known limitations

- The boundary covers provider job-result submission, not arbitrary publishing,
  payment, browser, or third-party tool effects.
- Payloads and results remain in the local database as durable recovery data.
  Use encrypted storage when confidentiality at rest is required.
- Completed rows are retained as deduplication evidence. There is deliberately
  no automatic pruning; reaching a configured capacity requires an
  operator-reviewed archival/migration procedure.
- An unavailable Web API can leave delivery `indeterminate` until remote state
  is reachable. The bounded dispatcher never guesses that an effect failed.
- Migration numbering must be rebased if another pending SQLite migration
  lands first.

## Local verification

From `packages/prime-agent`:

```bash
uv run pytest tests/test_durable_job_effects.py
uv run pytest
uv run ruff check src tests
uv build
```

From the repository root:

```bash
cargo test --workspace
pnpm --filter web exec tsc --noEmit
```
