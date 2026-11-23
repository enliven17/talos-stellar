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
