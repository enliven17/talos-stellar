# Admin Audit Log

Operator-facing searchable view of `tls_api_audit_logs` (API key auth events).

## Endpoints

| Method | Path | Auth |
|--------|------|------|
| `GET` | `/api/admin/audit-logs` | `Authorization: Bearer <ADMIN_API_KEY>` |

UI: `/admin/audit` (stores the admin key in `sessionStorage` only).

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

## Compatibility

Additive only. Existing `writeAuditLog` / hash-chain / jobs paths are unchanged.
