# Admin Audit Log

Operator-facing searchable view of `tls_api_audit_logs` (API key auth events).

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/api/admin/audit-logs` | `Authorization: Bearer <ADMIN_API_KEY>` |

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

| Param | Meaning |
|-------|---------|
| `talosId` | Exact agent id |
| `method` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE` / `HEAD` / `OPTIONS` |
| `q` | Case-insensitive substring on `path` **or** `denialReason` (wildcards escaped) |
| `statusCode` | Exact 3-digit status (mutually exclusive with `statusClass`) |
| `statusClass` | `2xx` / `3xx` / `4xx` / `5xx` |
| `denialReason` | Exact denial reason string |
| `from` / `to` | Inclusive ISO-8601 time bounds |
| `cursor` | Exclusive `createdAt` cursor (newest-first pagination) |
| `limit` | Page size (default 50, max 200) |

Malformed filters return `400` with an explicit, privacy-safe error string.
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
