# Admin Audit Log

Operator-facing searchable view of `tls_api_audit_logs` (API key auth events).

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/api/admin/audit-logs` | `Authorization: Bearer <ADMIN_API_KEY>` |
| `GET` | `/api/talos/:id/audit/verify` | `Authorization: Bearer <AGENT_API_KEY>` |

UI: `/admin/audit` (stores the admin key in `sessionStorage` only).

The review bundle is agent-scoped and returns at most 200 audit references
(default 50), a `nextCursor` when more references are available, and a
checkpoint of the agent's current hash-chain root and entry count. Use
`?limit=1..200` to select the page size and pass the returned `nextCursor`
as `cursor` to continue. Invalid limits or cursors return `400`.
References include only stored audit metadata and never API keys, request
bodies, payment proofs, or records belonging to another agent.

Endpoint: `GET /api/talos/:id/audit/review-bundle` (authenticated with that
TALOS's API key).

## Query filters

| Param | Meaning | Bounds |
|-------|---------|--------|
| `talosId` | Exact agent id (actor) | 1–128 characters |
| `method` | Action HTTP method | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `HEAD` / `OPTIONS` (max 16 chars) |
| `q` | Case-insensitive substring on `path` **or** `denialReason` (wildcards escaped) | 1–200 characters |
| `statusCode` | Exact 3-digit status (mutually exclusive with `statusClass`) | Integer 100–599 |
| `statusClass` | HTTP status class | `2xx` / `3xx` / `4xx` / `5xx` |
| `denialReason` | Exact denial reason string | 1–200 characters |
| `from` / `to` | Inclusive ISO-8601 time bounds | Valid ISO-8601, max 64 chars (`from <= to`) |
| `cursor` | Exclusive `createdAt` cursor (newest-first pagination) | Valid ISO-8601, max 64 chars |
| `limit` | Page size | Positive integer (default 50, max 200) |

Malformed or oversized filters are rejected before constructing database queries:
- HTTP `GET /api/admin/audit-logs` returns `400` with an explicit, privacy-safe error string.
- Direct calls to `listAuditLogs` validate filters up front and throw `AuditLogFilterError` (`code: "INVALID_AUDIT_FILTER"`) with no partial query execution.
Responses contain only columns already stored on the audit table — never API
keys, request bodies, or payment proofs.

## Offline exports

Use `createAuditExport(records, exportedAt)` to produce a JSON export. The
envelope and every record carry `redactionPolicyVersion`, currently
`talos.audit.redaction.v1`. The envelope also contains a deterministic
`integrityHash`, so an offline consumer can call `verifyAuditExport(value)`.

Verification returns `failure: "policy_version_mismatch"` when the verifier's
redaction rules differ from the export, and `failure: "data_corruption"` when
the envelope or hash chain was modified. A valid result has `valid: true` and
`failure: null`. Pass a fixed ISO timestamp to `createAuditExport` when a
reproducible byte-for-byte artifact is required.

## Compatibility

Additive only. Existing `writeAuditLog` / hash-chain / jobs paths are unchanged.

## Independently Verifiable Audit Checkpoint Bundles

Bounded, cryptographically signed audit checkpoint bundles can be exported and verified offline without database connectivity or administrator credentials.

- **Export (`exportAuditCheckpointBundle` / `createAuditCheckpointBundle` / `GET /api/talos/:id/audit/checkpoint?bundle=true`)**:
  - Produces a bounded bundle (`limit` defaults to `100`, clamped to `[1, 1000]`) with explicit chain boundaries (`startSequence`, `endSequence`, `startEntryHash`, `endEntryHash`, `previousChainHash`, `startTimestamp`, `endTimestamp`, `entryCount`, `limit`, `truncated`), `chainRoot`, and `entriesDigest`.
  - Signs the canonical checkpoint payload under domain `talos.audit.checkpoint.v1` using Ed25519 (`AUDIT_CHECKPOINT_PRIVATE_KEY` / `AUDIT_CHECKPOINT_PUBLIC_KEY`) or HMAC-SHA256 (`AUDIT_HASH_CHAIN_SECRET`).
- **Offline Verification (`verifyAuditCheckpointBundle`)**:
  - Verifies bundle structure, domain separation, bounded size, boundary consistency, `entriesDigest`, per-entry SHA-256 hash chain linkage (`talos.audit.v1`), contiguous sequence numbers, `previousChainHash` anchoring, and the cryptographic signature purely in-memory without database or admin access.

## Retention With Checkpoint Continuity

Old chained audit entries can be pruned with `applyAuditRetention` (planned by
the pure `planAuditRetention` in `src/lib/audit-log/retention.ts`) without
weakening the evidence that remains. Retention is **opt-in**: nothing is ever
deleted unless `AUDIT_RETENTION_ENABLED=true`. `dryRun: true` returns the plan
without deleting, even while disabled.

A run prunes `[oldest, anchor - 1]` for one agent, and only when the range is:

- **Closed**: it lies inside a signed checkpoint bundle (from
  `exportAuditCheckpointBundle`) that covers the oldest stored entry, and it is
  followed by a retained successor, so the open chain tail is never pruned.
- **Verified**: the checkpoint signature is valid (a signature is always
  required), the stored rows recompute to their `entryHash` and link
  contiguously, and every pruned row plus the anchor matches the signed
  checkpoint entries hash for hash.

The **anchor**, which is the entry immediately before the surviving chain, is
never pruned. It is the predecessor evidence for the surviving chain:
`verifyChainRange(rows, { predecessor: anchor })` and
`GET /api/talos/:id/audit/verify?from=…` for any window starting after the
anchor still report `complete: true`. Keep the checkpoint bundle used for a run
as the signed proof of the entries it removed. The next run starts from the
anchor, whose link to the pruned predecessor is checked against that signed
checkpoint.

The anchor is the highest sequence number allowed by every bound: at most
`checkpoint.endSequence`, leaving at least `AUDIT_RETENTION_MIN_ENTRIES`
newest entries, pruning only entries created at or before
`now - AUDIT_RETENTION_MS` (inclusive), and at most
`AUDIT_RETENTION_BATCH_SIZE` entries per run (hard cap 1000, the checkpoint
bound). Any verification failure refuses the whole run (`action: "refused"`,
with `checkpoint_invalid`, `checkpoint_empty`, `checkpoint_not_covering`,
`checkpoint_mismatch`, `chain_unverified` or `invalid_policy`). The delete
runs in a transaction and is rolled back
(`AuditRetentionConflictError`) unless it removes exactly the verified rows.
Legacy rows without chain columns are never pruned.

After pruning, verifying from genesis (`verifyChain`, or the unbounded
`/audit/verify`) reports `incomplete` at the anchor, because entries before it
were removed on purpose. To check the surviving chain, verify a window that
starts after the anchor.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUDIT_RETENTION_ENABLED` | `false` | Allow `applyAuditRetention` to delete rows. |
| `AUDIT_RETENTION_MS` | `31536000000` (365 days) | Minimum age of a prunable entry. |
| `AUDIT_RETENTION_MIN_ENTRIES` | `1000` | Newest chained entries always retained. |
| `AUDIT_RETENTION_BATCH_SIZE` | `500` | Max entries pruned per run (capped at 1000). |
