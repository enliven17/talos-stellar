# Scoped API Keys

Talos agents authenticate to the API using Bearer tokens. The system supports two key types:

- **Legacy keys** (`tlk_*`) — plaintext keys stored in `tls_talos.apiKey`. Grant full admin-equivalent access.
- **Scoped keys** (`tak_*`) — SHA-256 hashed keys stored in `tls_api_keys`. Grant only the scopes explicitly assigned.

Scoped keys are the recommended approach. They enforce least-privilege access and are logged in the audit trail.

## Scope Taxonomy

| Scope | Description | Routes |
|-------|-------------|--------|
| `admin` | Full access to all endpoints | All |
| `activity:write` | Post activity on behalf of agent | `POST /talos/:id/activity`, `PATCH /playbooks/:id/apply` |
| `commerce:read` | Poll pending jobs, view job results | `GET /jobs/pending`, `GET /jobs/:id/result`, `POST /talos/:id/service` |
| `commerce:write` | Submit job results, manage playbooks, register services | `POST /jobs/:id/result`, `POST /playbooks`, `PATCH /playbooks/:id`, `PUT /talos/:id/service` |
| `wallet:read` | View agent wallet balance | `GET /talos/:id/wallet` |
| `wallet:sign` | Sign Stellar payments (x402) | `POST /talos/:id/sign`, `POST /talos/:id/transfer` |
| `settings:read` | View agent configuration | — |
| `settings:write` | Update agent heartbeat/status | `PATCH /talos/:id/status` |
| `revenue:read` | View financial data, credit score, projections | `GET /talos/:id/financial-*`, `GET /talos/:id/credit-score`, `GET /talos/:id/revenue/buyback` |
| `revenue:write` | Report revenue, trigger distributions/buybacks | `POST /talos/:id/revenue`, `POST /talos/:id/revenue/distribute`, `POST /talos/:id/revenue/buyback`, `POST /talos/:id/dividends` |

## Key Management API

### Create a scoped key

```bash
curl -X POST https://your-api.com/api/talos/{id}/api-keys \
  -H "Authorization: Bearer <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "Agent Runner", "scopes": ["activity:write", "commerce:read"]}'
```

Response includes the raw key **once**. Store it securely — it cannot be retrieved again.

### List keys

```bash
curl https://your-api.com/api/talos/{id}/api-keys \
  -H "Authorization: Bearer <admin_key>"
```

### Update key scopes

```bash
curl -X PATCH https://your-api.com/api/talos/{id}/api-keys/{keyId} \
  -H "Authorization: Bearer <admin_key>" \
  -H "Content-Type: application/json" \
  -d '{"scopes": ["activity:write"]}'
```

### Revoke a key

```bash
curl -X DELETE https://your-api.com/api/talos/{id}/api-keys/{keyId} \
  -H "Authorization: Bearer <admin_key>"
```

## Migration from Legacy Keys

1. **Run the migration script** to copy existing plaintext keys into the scoped keys table as admin-scoped hashed keys:

   ```bash
   npx tsx src/lib/migrate-legacy-keys.ts
   ```

2. **Create scoped keys** for each agent with the minimum required scopes.

3. **Update agent configurations** (`TALOS_API_KEY` env var) to use the new scoped keys.

4. **Verify** all agents are working correctly with the new keys.

5. **Revoke legacy keys** by setting `tls_talos.apiKey = null` for each TALOS.

## Structured Logging

Auth events are logged via Pino:

| Event | Description |
|-------|-------------|
| `auth.key.resolved` | Successful authentication (includes keyId, path) |
| `auth.key.resolved (legacy)` | Successful auth via legacy key |
| `auth.key.denied` | Invalid key (includes path) |
| `auth.key.expired` | Key matched but has expired |
| `auth.scope.denied` | Valid key but insufficient scopes |

## Audit Log

Every authenticated request writes to `tls_api_audit_logs`:

- `talosId` — which agent
- `method` / `path` — which endpoint
- `statusCode` — 200 (success) or 403 (denied)
- `denialReason` — `invalid_key`, `insufficient_scopes`, or `expired_key`
- `scopesRequired` — what scopes were needed
- `ipAddress` — caller IP

## Rollback

If scoped keys cause issues, legacy keys continue to work. The fallback is automatic:

- If no scoped key matches, `verifyAgentApiKey` falls back to the plaintext `tls_talos.apiKey` comparison.
- Legacy keys are granted `admin` scope automatically.

To fully revert, simply stop issuing scoped keys and ensure all agents use their `tlk_*` legacy keys.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` | Pino log level. Set to `debug` for verbose auth logging. |
