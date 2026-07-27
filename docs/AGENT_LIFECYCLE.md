# Governed Agent Lifecycle

Covers the lifecycle state machine, the durable provisioning worker, and the
operator console that surfaces both.

## 1. States

| State | Kind | Meaning |
|---|---|---|
| `proposed` | proposed | Awaiting governance approval. Nothing allocated. |
| `provisioning` | transient | A durable job is allocating wallet, credentials, services, runtime. |
| `active` | settled | Accepting new work. |
| `paused` | settled | Not accepting new work; in-flight jobs drain. |
| `retiring` | transient | Draining outstanding work before retirement. |
| `retired` | terminal | Final. No further transitions. |
| `recovery_pending` | attention | Recovery requested; needs a governance approval to re-provision. |
| `failed` | attention | Provisioning failed and completed steps were compensated. |

The transition table lives in [`web/src/lib/governance/lifecycle.ts`](../web/src/lib/governance/lifecycle.ts)
and is the only place transitions are defined. Failure edges
(`provisioning`/`retiring`/`recovery_pending` → `failed`) are system-only.

### Actions and authorization

| Action | From → To | Required role | Governance approval |
|---|---|---|---|
| `create` | — → `proposed` | creator, operator, governance | no |
| `activate` | `proposed` → `provisioning` | governance, operator | **yes** |
| `activate` | `provisioning` → `active` | system | no |
| `activate` | `paused` → `active` | operator, governance | no |
| `pause` | `active` → `paused` | operator, governance, system | no |
| `retire` | `active`/`paused` → `retiring` | governance | **yes** |
| `retire` | `retiring` → `retired` | system | no |
| `recover` | `failed` → `recovery_pending` | operator, governance | no |
| `recover` | `recovery_pending` → `provisioning` | governance, operator | **yes** |

Roles are derived from the agent record: `creatorPublicKey` grants
creator+operator, `walletPublicKey` grants operator, `treasuryPublicKey` grants
governance. Governance approval is read from an **approved** `tls_approvals` row,
never from a client-supplied flag.

### Error codes

Stable and part of the API contract — clients branch on them.

`LIFECYCLE_UNKNOWN_ACTION` (400) · `LIFECYCLE_UNKNOWN_STATE` (400) ·
`LIFECYCLE_INVALID_TRANSITION` (409) · `LIFECYCLE_TERMINAL_STATE` (409) ·
`LIFECYCLE_UNAUTHORIZED` (403) · `LIFECYCLE_APPROVAL_REQUIRED` (403) ·
`LIFECYCLE_PREREQUISITE_FAILED` (422) · `LIFECYCLE_INVALID_PAYLOAD` (400) ·
`LIFECYCLE_CONFLICT` (409)

## 2. API

```
GET  /api/talos/:id/lifecycle?viewer=G...&limit=25&before=<sequence>
POST /api/talos/:id/lifecycle
```

`GET` returns the current state, `allowedActions` for the viewer, the latest
durable run with per-step progress, pending proposals, and a keyset-paginated
event page. `observedAt` is always present so clients can render staleness
rather than presenting an old snapshot as current.

`POST` body:

```jsonc
{
  "action": "retire",
  "payload": { "reason": "...", "proposalId": "...", "confirmed": true, "drainJobs": true },
  "address": "G...",          // the signer
  "message": "talos:<id>:lifecycle:retire:<ts>",  // must contain the agent id
  "signature": "<base64 ed25519>"
}
```

Durable actions return `202` with a `jobId`; the client polls `GET` for
progress. Inline actions return `200` with the settled state.

Request bodies are capped at 16 KiB. The signed message must contain the agent
id, which prevents a signature collected for one agent from being replayed
against another.

## 3. Durable provisioning

Approved `activate` / `retire` / `recover` become a row in
`tls_provisioning_jobs` and are executed step by step by
[`provisioning.ts`](../web/src/lib/governance/provisioning.ts).

Activation steps: `wallet` → `credentials` → `services` → `runtime`.
Retirement steps: `runtime` → `services` → `credentials`.

| Concern | Handling |
|---|---|
| Duplicate submission | Unique `(talosId, idempotencyKey)`; a resubmission returns the original run. |
| Duplicate execution | A lease + monotonic fencing token; a worker that loses its lease stops rather than writing. |
| Restart | All state is on the row. `findResumableJobs()` returns runs that are pending or whose lease expired. |
| Retry | Per-step attempts up to `PROVISIONING_MAX_STEP_ATTEMPTS`; a step that already completed replays from its persisted output instead of re-running. |
| Timeout | Each step runs under `PROVISIONING_STEP_TIMEOUT_MS` with an `AbortSignal`. |
| Partial failure | On exhaustion, completed steps are compensated in reverse order. A compensation that fails is recorded on the step and does not abort the remaining ones. |
| Cancellation | Pause cancels queued jobs; in-flight leases are always allowed to drain. |

Retirement steps compensate to a no-op on purpose: restarting a runtime that
governance told us to retire would contradict the decision. Re-provisioning goes
through `recover`.

### Effects boundary

The side-effecting implementations are injected via `ProvisioningEffects`
([`effects.ts`](../web/src/lib/governance/effects.ts)), so the durability logic
is testable without a wallet, an RPC endpoint, or a running agent. Each `run` is
convergent — it checks for the effect before applying it — which is what makes a
retry after an ambiguous failure safe.

**Known limitation:** `releaseWallet` unlinks the wallet but does not sweep a
funded account. A compensated run can leave residual balance requiring manual
reconciliation; the `provisioning.wallet_released` log line flags this.

## 4. Events

Canonical names are defined in
[`events.ts`](../web/src/lib/governance/events.ts) and follow the same
compatibility rules as `contracts/EVENTS.md`: additive changes are a minor bump;
a breaking change introduces a new name and retires the old one, never reusing
its meaning.

`(talosId, sequence)` is the replay cursor — strictly monotonic, never
reordered. A consumer resumes from the last sequence it committed. Appends are
idempotent per `idempotencyKey`, and the unique index on `(talosId, sequence)`
is what makes concurrent appenders safe: the loser re-reads the tip and retries.

`detail` is redacted through `lib/redact` and truncated at 4 KiB before it is
written, so the log is safe to expose to the public read policy.

## 5. Configuration

| Variable | Default | Effect |
|---|---|---|
| `PROVISIONING_LEASE_TTL_MS` | `60000` | How long a worker owns a run before it is reclaimable. |
| `PROVISIONING_STEP_TIMEOUT_MS` | `30000` | Per-step wall-clock budget. |
| `PROVISIONING_MAX_STEP_ATTEMPTS` | `3` | Attempts before a run fails and compensates. |

Raise the lease TTL above the step timeout; a TTL shorter than a step means a
run is reclaimed while its owner is still working.

## 6. Observability

Structured log events (via `lib/logger`), none of which carry payloads:

- `lifecycle.transition` — an inline transition was applied.
- `provisioning.step_failed` — includes step, attempt count, and whether retries are exhausted.
- `provisioning.compensation_failed` — **page-worthy**; manual reconciliation is needed.
- `provisioning.wallet_released` — a wallet was unlinked during compensation.
- `lifecycle.unhandled` — an unexpected error in a lifecycle route.

The `tls_lifecycle_events` table is the audit trail; query it by
`(talosId, sequence)` for a complete transition history.

## 7. Migration and rollback

Migration `0014_add_agent_lifecycle.sql` is purely additive — two new tables, no
changes to existing columns or constraints. It can be applied ahead of the
application deploy, and rolling the application back does not require rolling
the schema back.

The legacy `tls_talos.status` column keeps working. `toLifecycleState()` maps
unknown legacy values to `active` (the historical default), and
`toLegacyStatus()` collapses transient and failure states onto `Paused` so every
existing consumer that only understands Active/Paused/Retired reads them as "not
accepting work" — the safe reading.

To roll back: revert the application. Leave the tables; dropping them discards
the governance audit trail.

## 8. Known limitations

- No worker process is scheduled here. `findResumableJobs()` + `acquireLease()` +
  `runProvisioningJob()` are the building blocks; wiring them to a cron or queue
  is deployment-specific.
- Timelock delays are surfaced in the UI from pending proposals but are enforced
  on-chain, not in this layer.
- `assertPrerequisites` reads service count as `0` on the activate path; the
  service check is enforced by the provisioning `services` step instead.
