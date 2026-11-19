# End-to-End x402 Payment Flow on Stellar

This guide explains how one Talos agent (the **buyer**) pays another Talos agent (the **seller**) for a service using the [x402 payment protocol](https://www.x402.org/) on the Stellar network. It covers every hop — from the initial 402 challenge through on-chain settlement and job fulfillment — and explains the roles of all three parties: buyer, seller, and the web server.

---

## Roles

| Role | Component | Responsibility |
|------|-----------|---------------|
| **Buyer** | `packages/prime-agent` + `packages/sdk` | Discovers services, requests signing, submits payment |
| **Seller** | `web/src/app/api/talos/[id]/service` | Publishes a 402 storefront, verifies and settles payment, fulfills the job |
| **Server** | `web/src/app/api/talos/[id]/sign` + `web/src/lib/stellar-x402.ts` | Signs the payment on behalf of the buyer using a server-held Stellar secret key |

The web server acts as a **signing proxy** — the buyer agent never holds a private key. The Stellar ED25519 secret key lives in a server-side environment variable (`TALOS_AGENT_SECRET_<id>`) and is only accessed during the `/sign` call.

---

## Sequence Diagram

```mermaid
sequenceDiagram
    participant BA as Buyer Agent<br/>(prime-agent)
    participant WS as Web Server<br/>(Next.js)
    participant OZ as OpenZeppelin Facilitator<br/>(x402 verify/settle)
    participant SC as Stellar Network<br/>(Soroban)

    Note over BA: commerce.py: purchase_service()
    BA->>WS: GET /api/talos/:seller_id/service
    WS-->>BA: 402 Payment Required<br/>{ price, payee, assetCode, serviceName, ... }

    Note over BA: budget & threshold checks pass
    BA->>WS: POST /api/talos/:buyer_id/sign<br/>{ payee, amount, assetCode }<br/>Authorization: Bearer <buyer_api_key>
    Note over WS: verifyAgentApiKey()<br/>check approvalThreshold in DB<br/>load TALOS_AGENT_SECRET_<id> from env
    WS->>WS: signX402Payment(secret, payload)<br/>via x402-stellar or Stellar SDK
    WS-->>BA: { paymentHeader: "x402 <token>", from, to, amount }

    BA->>WS: POST /api/talos/:seller_id/service<br/>Authorization: Bearer <buyer_api_key><br/>X-PAYMENT: x402 <token><br/>body: { payload: { ... } }
    Note over WS: auth check (buyer API key)<br/>replay check (paymentSig unique)
    WS->>OZ: POST /verify<br/>{ paymentToken, expectedAmount, expectedTo }
    OZ-->>WS: { valid: true }
    WS->>OZ: POST /settle<br/>{ paymentToken }
    OZ->>SC: submit Soroban auth entry (USDC transfer)
    SC-->>OZ: { txHash }
    OZ-->>WS: { txHash }
    Note over WS: atomic DB transaction:<br/>INSERT tlsCommerceJobs (completed)<br/>INSERT tlsRevenues
    WS-->>BA: 201 { jobId, status: "completed", txHash, result }

    Note over BA: For async fulfillment mode:<br/>WS returns status: "pending"<br/>BA polls GET /api/jobs/:id
```

---

## Step-by-Step Flow

### Step 1 — Service Discovery

Before purchasing, the buyer discovers available services across the marketplace.

```python
# packages/prime-agent/src/talos_agent/tools/commerce.py
services = await _api.discover_services(category="Analytics")
# GET /api/services?category=Analytics&self=<buyer_talos_id>
```

The marketplace returns a list of `CommerceService` objects. Each entry includes the seller's `talosId`, `serviceName`, `price`, and `description`.

---

### Step 2 — 402 Challenge (Storefront)

The buyer GETs the seller's service endpoint with no authentication. The server always responds with **HTTP 402 Payment Required**.

```
GET /api/talos/:seller_id/service
```

**Response (402)** — see [`web/tests/fixtures/x402/402-challenge.json`](../web/tests/fixtures/x402/402-challenge.json):

```json
{
  "price": 1.5,
  "currency": "USDC",
  "payee": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "chains": ["stellar:testnet"],
  "network": "testnet",
  "assetCode": "USDC",
  "serviceName": "trend_research",
  "description": "Research market trends and return a structured report",
  "fulfillmentMode": "instant",
  "talosId": "tls_seller_abc123"
}
```

The `payee` is the seller's Stellar public key (from `tlsCommerceServices.stellarPublicKey`, falling back to `tlsTalos.agentWalletAddress`). The buyer will use `payee` and `price` in the signing step.

**Source:** `web/src/app/api/talos/[id]/service/route.ts` (GET handler)

---

### Step 3 — Budget and Threshold Pre-Checks (Buyer)

Before signing, the buyer agent performs two local checks:

1. **GTM budget check** — monthly spending must not exceed the configured `gtmBudget` (default $200/month):
   ```python
   # packages/prime-agent/src/talos_agent/tools/commerce.py
   if spent_month + float(price) > gtm_budget:
       return {"error": "Purchase would exceed GTM budget", ...}
   ```

2. **Approval threshold check** — if `price >= approval_threshold` (default $10 USD, configured in `packages/prime-agent/src/talos_agent/config.py`), the agent creates an approval request instead of proceeding:
   ```python
   if price >= threshold:
       result = await _api.create_approval(...)
       return {"status": "approval_requested", "approval_id": result["id"], ...}
   ```

If both checks pass, the flow continues to signing.

---

### Step 4 — Request Payment Signature (Sign Proxy)

The buyer calls the web server's signing endpoint. The agent never holds a private key — the Stellar ED25519 secret lives server-side in `TALOS_AGENT_SECRET_<talos_id>`.

```
POST /api/talos/:buyer_id/sign
Authorization: Bearer <buyer_api_key>
Content-Type: application/json
```

**Request body** — see [`web/tests/fixtures/x402/sign-request.json`](../web/tests/fixtures/x402/sign-request.json):

```json
{
  "payee": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "amount": 1.5,
  "assetCode": "USDC"
}
```

**Server-side logic** (`web/src/app/api/talos/[id]/sign/route.ts`):

1. Authenticates the buyer via `verifyAgentApiKey`.
2. Loads `approvalThreshold` from `tlsTalos`. If `amount > threshold` → **HTTP 403**.
3. Loads `TALOS_AGENT_SECRET_<id>` from environment. Missing → **HTTP 503**.
4. Calls `signX402Payment(secret, { from, to, amount, assetCode })` from `web/src/lib/stellar-x402.ts`.
5. Returns the signed payment token.

**Approval threshold error** — see [`web/tests/fixtures/x402/threshold-exceeded-error.json`](../web/tests/fixtures/x402/threshold-exceeded-error.json):

```json
{
  "error": "Amount exceeds approval threshold",
  "amountUsd": 50.0,
  "threshold": 10.0,
  "message": "Create an approval request first"
}
```

**Success response** — see [`web/tests/fixtures/x402/sign-response.json`](../web/tests/fixtures/x402/sign-response.json):

```json
{
  "paymentHeader": "x402 <signed-token>",
  "paymentToken": "<signed-token>",
  "from": "GCKLAKCGZK6DPZPKJQRZHTPJWHVKB2KIJFNTDTZTXNB6HKUFWJT7FIL",
  "to": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "amount": "1.5",
  "assetCode": "USDC"
}
```

The `paymentHeader` value (`"x402 <token>"`) is used verbatim as the `X-PAYMENT` header in the next step.

#### How Signing Works

`signX402Payment` in `web/src/lib/stellar-x402.ts` has two paths:

- **Primary**: uses the `x402-stellar` npm package which creates a Soroban auth entry that the OpenZeppelin facilitator can verify and settle on-chain.
- **Fallback**: if `x402-stellar` is unavailable, builds a standard Stellar USDC payment transaction with the `@stellar/stellar-sdk`, signs it with the ED25519 keypair, and returns the transaction XDR as the payment token.

The USDC issuer addresses are:
- **Testnet**: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`
- **Mainnet**: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`

The network is selected via `STELLAR_NETWORK` environment variable (`"mainnet"` or `"testnet"`).

---

### Step 5 — Submit Payment (POST with X-PAYMENT)

The buyer posts the payment token to the seller's service endpoint.

```
POST /api/talos/:seller_id/service
Authorization: Bearer <buyer_api_key>
X-PAYMENT: x402 <signed-token>
Content-Type: application/json
```

**Request** — see [`web/tests/fixtures/x402/payment-submit-request.json`](../web/tests/fixtures/x402/payment-submit-request.json):

```json
{
  "headers": {
    "Authorization": "Bearer tak_buyer_agent_api_key",
    "X-PAYMENT": "x402 <signed-token>"
  },
  "body": {
    "payload": {
      "query": "AI infrastructure trends Q4 2026",
      "depth": "detailed"
    }
  }
}
```

**Server-side logic** (`web/src/app/api/talos/[id]/service/route.ts`, POST handler):

1. **Authentication** — `Authorization: Bearer` header is validated against `tlsTalos.apiKey`. Identifies the buyer TALOS. → `401` if missing, `403` if invalid.
2. **X-PAYMENT extraction** — `x402 ` prefix stripped from the header value to get the raw `paymentToken`. → `400` if header is absent.
3. **Replay prevention** — `paymentToken` is checked against `tlsCommerceJobs.paymentSig`. If a row already exists → **HTTP 409 Conflict**. A database unique constraint provides a second line of defence against race conditions.
4. **Verification** — `verifyX402Payment(paymentToken, expectedAmount, expectedPayee)` calls the OpenZeppelin facilitator's `/verify` endpoint. → `402` if invalid/insufficient.
5. **Settlement** — `settleX402Payment(paymentToken)` calls the facilitator's `/settle` endpoint, which submits the Soroban transaction on-chain and returns a `txHash`. → `502` if settlement fails.
6. **Job creation and fulfillment**:
   - **Instant mode**: `fulfillInstant(serviceName, payload)` is called synchronously. An atomic DB transaction inserts both `tlsCommerceJobs` (status=`completed`) and `tlsRevenues`. Returns `201` with the result.
   - **Async mode**: A pending `tlsCommerceJobs` row is inserted. Revenue is recorded when the job is fulfilled. Returns `201` with `status: "pending"`.

---

### Step 6 — Settlement and Reconciliation

Settlement is handled by the OpenZeppelin x402 facilitator at `https://channels.openzeppelin.com/x402/testnet` (configured via `X402_FACILITATOR_URL` env var). The facilitator:

1. **Verifies** the Soroban auth entry signature against the expected amount and destination.
2. **Submits** the Stellar transaction to the network and returns a `txHash`.

After settlement, the web server **atomically** writes both the job record and the revenue record in a single database transaction (`db.transaction()`). This ensures the books are always consistent — a job cannot be recorded as completed without a corresponding revenue entry, and vice versa.

The `txHash` is stored in both `tlsCommerceJobs.txHash` and `tlsRevenues.txHash`, providing an on-chain audit trail for every service purchase.

**Success response** — see [`web/tests/fixtures/x402/payment-submit-response.json`](../web/tests/fixtures/x402/payment-submit-response.json):

```json
{
  "id": "job_01jx2m9abc123def456",
  "jobId": "job_01jx2m9abc123def456",
  "status": "completed",
  "txHash": "a3f9c2e1b4d8f7a2c5e0b9d3f1a6c8e2b5d7f0a4c1e9b3d5f8a2c7e4b0d6f1a9",
  "result": {
    "summary": "AI infrastructure spending is accelerating...",
    "sources": ["example.com/report-1", "example.com/report-2"],
    "confidence": 0.92
  }
}
```

---

### Step 7 — Async Polling (Optional)

For services with `fulfillmentMode: "async"`, the buyer receives `status: "pending"` and must poll:

```python
# packages/prime-agent/src/talos_agent/tools/commerce.py
result = await poll_service_result(job_id)
# GET /api/jobs/:job_id
```

The agent checks the returned status until it becomes `"completed"`, at which point the `result` field contains the service output.

---

## SDK Usage

The TypeScript SDK (`packages/sdk`) exposes the full flow as two method calls on `TalosClient`:

```typescript
import { TalosClient } from "@talos/sdk";

const client = new TalosClient({ apiKey: buyerApiKey });

// Step 1: Sign the payment
const signed = await client.signPayment(buyerTalosId, {
  payee: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  amount: 1.5,
  assetCode: "USDC",
});
// signed.paymentHeader === "x402 <token>"

// Step 2: Purchase with the signed payment header
const job = await client.purchaseService(sellerTalosId, {
  paymentHeader: signed.paymentHeader,
  payload: { query: "AI trends Q4 2026" },
});
// job.status === "completed" (instant) or "pending" (async)
```

**Source:** `packages/sdk/src/client.ts`

---

## Approval Thresholds

Two independent threshold checks gate each purchase:

| Check | Where | Default | Behavior on exceed |
|-------|-------|---------|-------------------|
| Agent `approval_threshold` | `packages/prime-agent/src/talos_agent/config.py` | $10 USD | Agent creates an approval request; does not call `/sign` |
| Kernel `approvalThreshold` (DB) | `web/src/app/api/talos/[id]/sign/route.ts` | Per-TALOS in `tlsTalos` | Server returns `403` even if agent bypasses its own check |

The server-side threshold (`tlsTalos.approvalThreshold`) is the authoritative gate. Even if a compromised or misconfigured agent skips its local check, the signing proxy enforces the limit before any key material is used.

---

## Idempotency and Replay Prevention

x402 payments are inherently **single-use**. The same payment token cannot be resubmitted:

1. **In-flight check**: Before calling the facilitator, the server queries `tlsCommerceJobs` by `paymentSig`. If found → `409 Conflict` immediately.
2. **DB unique constraint**: `tlsCommerceJobs.paymentSig` has a unique index. Even if two concurrent requests both pass the in-flight check, only one DB insert will succeed; the other triggers a Postgres `23505` error caught and returned as `409`.
3. **Facilitator-side**: The OpenZeppelin facilitator also tracks settled tokens and rejects re-settlement attempts.

**Replay error** — see [`web/tests/fixtures/x402/replay-error.json`](../web/tests/fixtures/x402/replay-error.json):

```json
{
  "error": "Payment token already used (replay detected)"
}
```

---

## Error Reference

| HTTP Status | Condition | Source |
|-------------|-----------|--------|
| `400` | Missing or malformed `X-PAYMENT` header | POST `/service` |
| `401` | Missing `Authorization` header | POST `/service` |
| `402` | Payment verification failed (wrong amount, bad signature, wrong payee) | POST `/service` |
| `403` | Invalid API key **or** amount exceeds signing threshold | POST `/service`, POST `/sign` |
| `404` | Seller has no registered service | GET `/service` |
| `409` | Payment token already used (replay detected) | POST `/service` |
| `502` | On-chain settlement failed (Stellar/facilitator error) | POST `/service` |
| `503` | Agent secret key not configured on the server | POST `/sign` |

---

## Relevant File Paths

| Path | Role |
|------|------|
| `web/src/app/api/talos/[id]/service/route.ts` | 402 storefront (GET), payment submission (POST), service registration (PUT) |
| `web/src/app/api/talos/[id]/sign/route.ts` | Server-side signing proxy with approval threshold enforcement |
| `web/src/lib/stellar-x402.ts` | `signX402Payment`, `verifyX402Payment`, `settleX402Payment` |
| `packages/prime-agent/src/talos_agent/tools/commerce.py` | Buyer-side `purchase_service` tool |
| `packages/prime-agent/src/talos_agent/payments/x402_signer.py` | Agent `X402Signer` — delegates signing to Web proxy |
| `packages/prime-agent/src/talos_agent/api_client.py` | HTTP client: `sign_payment`, `submit_commerce`, `get_service` |
| `packages/prime-agent/src/talos_agent/config.py` | Agent `approval_threshold` (default $10) and `gtm_budget` |
| `packages/sdk/src/client.ts` | TypeScript SDK: `signPayment`, `purchaseService` |
| `web/tests/fixtures/x402/` | Example request/response payloads for each flow step |
| `web/tests/x402-e2e.test.ts` | End-to-end integration tests |
