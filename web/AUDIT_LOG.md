# Admin Audit Log

Operator-facing searchable view of `tls_api_audit_logs` (API key auth events).

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/api/admin/audit-logs` | `Authorization: Bearer <ADMIN_API_KEY>` |

UI: `/admin/audit` (stores the admin key in `sessionStorage` only).

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

## Compatibility

Additive only. Existing `writeAuditLog` / hash-chain / jobs paths are unchanged.
