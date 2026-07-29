# Webhook Delivery System

## Architecture

The webhook delivery system enables TALOS agents to send signed event notifications to external URLs. It follows the same architectural patterns as the existing commerce job system (lease-based polling, fencing tokens, exponential backoff).

### Components

```
┌─────────────┐     emitWebhookEvent()     ┌───────────────────┐
│  Event Source│ ──────────────────────────▶│  DB Delivery Queue│
│ (approval,   │                            │ (pending/failed)  │
│  revenue,    │                            └────────┬──────────┘
│  activity,   │                                     │
│  dividend)   │                                     ▼ poll
└─────────────┘                            ┌───────────────────┐
                                           │  Worker Polls     │
                                           │ GET /deliveries/  │
                                           │   pending         │
                                           └────────┬──────────┘
                                                    │ claim + deliver
                                                    ▼
┌─────────────┐     POST payload + HMAC      ┌───────────────────┐
│  Subscriber │ ◀────────────────────────────│   Delivery Engine │
│  (HTTP URL) │  X-Webhook-Signature header  │                   │
└─────────────┘                              └───────────────────┘
```

### Data Flow

1. **Event Emission**: When a protocol event occurs (approval completed, revenue recorded, dividend distributed, activity reported), the route handler calls `emitWebhookEvent()`. This creates delivery records for matching active subscriptions.

2. **Delivery Queue**: Delivery records are stored in `tls_webhook_deliveries` with `status = "pending"`, `status = "failed"` (retryable), or `status = "dead_letter"` (exhausted).

3. **Worker Polling**: An external worker (or the Prime Agent) polls `GET /api/webhooks/deliveries/pending` to find available deliveries.

4. **Lease Acquisition**: The worker claims a delivery via `POST /api/webhooks/deliveries/:id/claim`, acquiring an exclusive lease with a fencing token (same pattern as commerce jobs).

5. **HTTP Delivery**: The worker performs the outbound HTTP POST to the subscriber's URL with:
   - Signed payload (`X-Webhook-Signature` header)
   - Content-Type: application/json

6. **Result Recording**: The worker submits the result via `POST /api/webhooks/deliveries/:id/result`, which:
   - On success (2xx/3xx/4xx): marks delivery as `delivered`
   - On failure (5xx/network error): increments attempt count, schedules retry with exponential backoff, or moves to `dead_letter` when max attempts are exhausted

---

## API Endpoints

### Subscription Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `api/webhooks/subscriptions` | Create a new webhook subscription |
| `GET` | `api/webhooks/subscriptions` | List subscriptions for the authenticated TALOS |
| `GET` | `api/webhooks/subscriptions/:id` | Get subscription details |
| `PATCH` | `api/webhooks/subscriptions/:id` | Update subscription |
| `DELETE` | `api/webhooks/subscriptions/:id` | Delete subscription |

### Delivery Worker Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `api/webhooks/deliveries/pending` | Poll for pending deliveries |
| `POST` | `api/webhooks/deliveries/:id/claim` | Acquire lease on a delivery |
| `POST` | `api/webhooks/deliveries/:id/heartbeat` | Extend delivery lease |
| `POST` | `api/webhooks/deliveries/:id/result` | Submit delivery result |
| `GET` | `api/webhooks/deliveries` | List delivery history |

### Event Types

The following event types are automatically emitted:

| Event Type | Trigger | Source Route |
|------------|---------|------|
| `approval.approved` | Approval request is approved | `approvals/[approvalId]/route.ts` |
| `approval.rejected` | Approval request is rejected | `approvals/[approvalId]/route.ts` |
| `revenue.recorded` | Revenue is reported | `revenue/route.ts` |
| `dividend.distributed` | Dividend is recorded | `dividends/route.ts` |
| `activity.*` | Activity is reported (type-specific) | `activity/route.ts` |

---

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_DELIVERY_ENABLED` | `false` | Master enable switch |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | (required) | 64-char hex string (32 bytes) for AES-256-GCM |
| `WEBHOOK_DEFAULT_MAX_ATTEMPTS` | `5` | Delivery retry limit |
| `WEBHOOK_BACKOFF_BASE_MS` | `1000` | Exponential backoff base (ms) |
| `WEBHOOK_BACKOFF_MAX_MS` | `60000` | Backoff ceiling (ms) |
| `WEBHOOK_DELIVERY_TIMEOUT_MS` | `10000` | HTTP request timeout (ms) |
| `WEBHOOK_MAX_PAYLOAD_BYTES` | `64000` | Maximum payload size (bytes) |
| `WEBHOOK_LEASE_TTL_SECONDS` | `300` | Delivery lease duration (s) |
| `WEBHOOK_HEARTBEAT_EXTEND_SECONDS` | `300` | Heartbeat extension (s) |

### Generating the Encryption Key

```bash
openssl rand -hex 32
```

This produces a 64-character hex string. Set it as `WEBHOOK_SECRET_ENCRYPTION_KEY`.

---

## Signature Format

Outgoing webhook payloads are signed using HMAC-SHA256:

```
X-Webhook-Signature: v1=<hmac>,t=<unix_timestamp>
```

The recipient should:
1. Parse the `v1=<hmac>` and `t=<timestamp>` parts
2. Verify the HMAC using the shared secret
3. Reject timestamps older than 5 minutes (replay protection)

---

## Rollout Strategy

1. **Generate encryption key**: `openssl rand -hex 32`
2. **Enable delivery**: Set `WEBHOOK_DELIVERY_ENABLED=true`
3. **Start with one event type**: Create subscriptions for a single event type (e.g., `approval.completed`)
4. **Monitor delivery logs**: Watch for `webhook_delivered` and `webhook_delivery_failed` log entries
5. **Gradually expand event types**: Add more event types as confidence grows

---

## Migrations

Migration `0013_add_webhook_support.sql` creates:
- `tls_webhook_subscriptions` — webhook endpoint configurations
- `tls_webhook_deliveries` — delivery history with retry/lease state

### Rollback

```sql
DROP TABLE IF EXISTS tls_webhook_deliveries;
DROP TABLE IF EXISTS tls_webhook_subscriptions;
```

---

## Security

### Secret Handling
- Webhook secrets are encrypted at rest using AES-256-GCM
- Secrets are never returned in API responses
- Secrets are masked in logs (first 4 + last 4 characters shown)
- Token and secret values are redacted from error messages

### Replay Protection
- Each signature includes a UNIX timestamp
- Recipients should reject signatures older than 5 minutes
- Timestamp validation uses `math.abs(now - timestamp) <= 300`

### Input Validation
- URLs are validated via Zod's `z.string().url()`
- URLs are limited to 2048 characters
- Secrets must be 16–256 characters
- Event types must be non-empty string arrays
- Payloads over 64 KB are rejected

---

## Known Limitations

1. **No wildcard event type matching**: Subscriptions must specify exact event types. Patterns like `"*"` or `"approval.*"` are not supported.

2. **Retry payload reconstruction**: Failed deliveries on retry deliver a minimal stub payload `{ event, id, _retry: true }` rather than the full original event payload. The full payload is not persisted in the delivery record to avoid storing potentially sensitive data.

3. **No in-process metrics counters**: The system relies on structured logging (Pino) for observability. There are no in-memory counters for prometheus-style metrics.

4. **No dead-letter replay**: Once a delivery reaches `dead_letter` status, it is not automatically retried. Manual intervention or a new subscription event is required.

5. **Exact-match event routing**: Event type matching uses PostgreSQL's `ANY()` function. Subscriptions must specify exact event type strings.

6. **No delivery receipt verification**: The system considers any HTTP 2xx–4xx response as successful. It does not verify the response body contains an expected acknowledgement.

---

## Operational Metrics

Key metrics available via structured logging (log level and message):

| Log Message | Level | When |
|-------------|-------|------|
| `webhook_deliveries_created` | info | Delivery records created |
| `webhook_delivered` | info | Delivery succeeded |
| `webhook_delivery_failed` | warn | Delivery failed (retryable) |
| `webhook_dead_letter` | error | Max retries exhausted |
| `webhook_secret_encrypt_failed` | error | Encryption key missing/invalid |
| `webhook_delivery_create_failed` | error | DB insert failed |
| `webhook_payload_too_large` | warn | Payload exceeds size limit |

---

## Local Verification

1. Ensure `DATABASE_URL` points to a local or test Postgres instance
2. Run migrations: `pnpm db:migrate`
3. Set environment variables:
   ```
   WEBHOOK_DELIVERY_ENABLED=true
   WEBHOOK_SECRET_ENCRYPTION_KEY=$(openssl rand -hex 32)
   ```
4. Start the dev server: `pnpm dev`
5. Create a subscription:
   ```bash
   curl -X POST http://localhost:3000/api/webhooks/subscriptions \
     -H "Authorization: Bearer <talos_api_key>" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://webhook.site/your-test-url",
       "secret": "whsec_test_secret_for_signing",
       "eventTypes": ["approval.approved"]
     }'
   ```
6. Trigger an event (e.g., approve a pending approval)
7. Check delivery logs for `webhook_deliveries_created`
8. Poll for pending deliveries: `GET /api/webhooks/deliveries/pending`
