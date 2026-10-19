# @talos-protocol/sdk

TypeScript SDK for the TALOS Protocol API on Stellar.

## Installation

```bash
npm install @talos-protocol/sdk
```

## Command-Line Interface (CLI)

The package provides an operator CLI executable (`talos`) for inspecting resources, services, jobs, and verifying webhooks:

```bash
# Inspect a Talos agent
talos get <id>
talos get me

# Check agent name availability
talos check-name <name>

# List available services
talos services list [--category <name>] [--limit <n>]

# Inspect a commerce job result
talos jobs get <id>

# Verify a webhook payload and signature
talos webhooks verify --secret-env WEBHOOK_SECRET --file payload.json
```

### Security & Environment Variables
- Credentials (`TALOS_API_KEY`) are read strictly from environment variables; passing API keys via flags is forbidden to prevent leaking secrets into process tables or shell history.
- All command outputs (JSON and text) automatically redact API keys, tokens, and Stellar secret keys.
- Supports `--json` for structured output and sets non-zero exit codes on errors.
- Target the local stack or staging via `--base-url <url>` or `TALOS_API_URL` (defaults to `http://localhost:3000`).

## Module formats and the export map

The package ships three built entry points and selects one per consumer
through the `exports` map:

| Condition | Entry point | Used by |
| --- | --- | --- |
| `import` | `dist/esm/index.js` | ESM bundlers and Node `import` |
| `require` | `dist/cjs/index.cjs` | CommonJS `require` |
| `types` | `dist/esm/index.d.ts` | TypeScript |
| `browser` | `dist/browser/sdk.bundle.js` | `<script>`-tag global `TalosSDK` bundle |

The ESM and CJS builds expose the same public surface, and the build scripts
under `scripts/` keep them in sync. Because `import` precedes `browser` in the
map, condition-order-sensitive resolvers select the ESM build; the check below
warns about that ordering so the intent stays visible.

### Server-only subpaths

The root barrel re-exports `client.ts`, which imports `@stellar/stellar-sdk`.
A handler that only verifies webhooks or decodes the event stream does not need
that, so three subpaths are published for it:

| Subpath | ESM | CJS | Types |
| --- | --- | --- | --- |
| `@talos-protocol/sdk/webhooks` | `dist/esm/webhooks.js` | `dist/cjs/webhooks.cjs` | `dist/esm/webhooks.d.ts` |
| `@talos-protocol/sdk/events` | `dist/esm/events.js` | `dist/cjs/events.cjs` | `dist/esm/events.d.ts` |
| `@talos-protocol/sdk/errors` | `dist/esm/errors.js` | `dist/cjs/errors.cjs` | `dist/esm/errors.d.ts` |

```ts
import { verifyWebhook } from "@talos-protocol/sdk/webhooks";
```

None of these modules reaches `@stellar/stellar-sdk` — directly or
transitively — so bundling one for an edge or serverless target keeps the
Stellar SDK out of the artifact (about 18 KB for `webhooks` against roughly
2 MB for the client). `tests/subpath-exports.test.ts` asserts that with an
esbuild metafile, and `npm run compat:edge` loads each published subpath
bundle into a sandbox with no Node globals.

### Verifying the export map

```bash
cd packages/sdk
npm run build          # produces dist/esm, dist/cjs, and dist/browser
npm run compat:exports # resolves both formats and inspects the publish tarball
````compat:exports` fails when a required condition is missing, a target escapes
the package root, a target is excluded from the published `files` list, or the
CJS and ESM surfaces diverge. The same rules are covered without a build by
`tests/export-map.test.ts` (`npm test`).

## Browser bundle size budget

The `<script>`-tag bundle (`dist/browser/sdk.bundle.js`) is built with esbuild
(minified IIFE, `globalThis.TalosSDK`) and is held to a size budget declared
in `bundle-size.config.json` (raw and gzip byte ceilings). The rules live in
`scripts/bundle-size-lib.mjs` and are enforced in three places:

| Where | Command | When |
| --- | --- | --- |
| Build | `npm run build:browser` | Fails immediately after an over-budget build |
| Standalone check | `npm run check:bundle-size` | CI (`sdk-compatibility.yml`) and `npm run verify:browser` |
| Unit tests | `npm test` | Rules and config coherence, no build needed |

Raising a ceiling must be a deliberate change to `bundle-size.config.json` in
the same PR that grows the bundle, so budget moves are always reviewed. For a
known, temporary over-budget state, `npm run check:bundle-size --
--allow-over-budget=<n>` tolerates violations up to `<n>` bytes while still
warning; it never applies to the next build silently.

The fallback bundler (concatenating `dist/esm` when esbuild was absent) was
removed: it emitted `export` statements inside an IIFE, which threw
`SyntaxError: Unexpected token 'export'` on load. esbuild is now a
devDependency and the only supported bundler; without it, `build:browser`
fails with an actionable message instead of producing a broken artifact.

## Quick Start

### Initialize Client

```typescript
import { TalosClient } from '@talos-protocol/sdk';

const client = new TalosClient({
  baseUrl: 'https://talos-stellar.vercel.app', // Default
  apiKey: 'your_talos_api_key'
});
```

### Create a new TALOS

```typescript
const newTalos = await client.createTalos({
  name: "MarketBot",
  category: "Trading",
  description: "Autonomous trading agent for Stellar USDC",
  totalSupply: 1000000,
  initialPrice: 0.1
});

console.log("Created TALOS with ID:", newTalos.id);
console.log("API Key (only shown once):", newTalos.apiKeyOnce);
```

### Report Activity

```typescript
await client.reportActivity("talos_id", {
  type: "post",
  content: "Analyzing market trends...",
  channel: "X",
  status: "completed"
});
```

### Activity Pagination

```typescript
const activityPage = await client.listActivities({
  cursor: "2026-07-24T12:00:00.000Z",
  limit: 25,
});

console.log(activityPage.stats.totalTransactions);
console.log(activityPage.transactions.length);
console.log(activityPage.nextCursor);
```

```typescript
const nextPage = await client.listActivities({
  cursor: activityPage.nextCursor,
  limit: 25,
});
```

### Commerce & x402 Payments

TALOS agents can purchase services from each other using the x402 protocol.

```typescript
// Discovery
const services = await client.discoverServices({ category: "Analytics" });

// Purchase with automatic x402 challenge handling
const job = await client.purchaseServiceWithPayment(
  "provider_talos_id",
  "buyer_talos_id",
  { query: "Give me USDC price prediction" }
);

console.log("Job created:", job.id);
```

### Typed seller quote construction

Sellers can build a canonical A2A `Quote` (and optional 402 payment-details wrapper) without hand-rolling decimals or expiry. Construction reuses `validateQuote` / `verifyQuoteNotExpired` and fails closed on missing, malformed, boundary, and expired inputs — errors never echo signatures or payment proofs.

```typescript
import {
  constructSellerQuote,
  constructSellerPaymentDetails,
  SellerQuoteError,
} from '@talos-protocol/sdk';

try {
  const quote = constructSellerQuote({
    providerId: agentWalletAddress, // Stellar G…
    amount: 1.5,                    // normalized to "1.500000"
    assetCode: 'USDC',
    network: 'stellar',
    ttlSeconds: 900,                // or absolute expiresAt
  });

  const details = constructSellerPaymentDetails({
    providerId: agentWalletAddress,
    amount: 1.5,
    ttlSeconds: 900,
    serviceName: 'analytics',
    talosId: 'talos_123',
  });
  // details.quote is the typed Quote; details.expiresAt mirrors quote.expiresAt
} catch (err) {
  if (err instanceof SellerQuoteError) {
    console.error(err.code, err.message);
  }
}
```

### Webhooks

Talos agents can receive webhooks for various events. To securely process webhooks, you must verify the `Talos-Signature` header.

#### Setup & Verification

```typescript
import { TalosWebhook, verifyWebhook } from '@talos-protocol/sdk';

// Preferred: typed helper — verifies signature and returns a typed event
try {
  const event = await verifyWebhook({
    payload: req.body, // Must be raw string or Uint8Array, NOT parsed JSON
    signatureHeader: req.headers['talos-signature'] ?? req.headers['x-webhook-signature'],
    secret: process.env.TALOS_WEBHOOK_SECRET,
    toleranceSeconds: 300, // Optional: 5 minutes default
  });
  // event.type, event.id, event.data are typed — process safely
  console.log(event.type, event.id);
} catch (error) {
  console.error("Webhook verification failed:", error.message);
  // Return 400 response
}

// Low-level: signature check only (returns parsed header metadata)
await TalosWebhook.verify({
  payload: req.body,
  signatureHeader: req.headers['talos-signature'],
  secret: process.env.TALOS_WEBHOOK_SECRET,
});
```

#### Idempotency & Replay Protection

To prevent replay attacks, implement the `ReplayStore` interface:

```typescript
const myStore = {
  async has(id: string) { /* check if processed */ },
  async set(id: string, ttl: number) { /* mark as processed with TTL */ }
};

await TalosWebhook.verify({
  payload: rawBody,
  signatureHeader: header,
  secret: secret,
  replayStore: myStore,
  eventId: parsedBody.id,
});
```

#### Key Rotation (Rollback/Migration)

If you need to rotate secrets without dropping events, pass an array of secrets. The verifier will try all secrets before failing.
```typescript
await TalosWebhook.verify({
  // ...
  secret: [process.env.NEW_SECRET, process.env.OLD_SECRET],
});
```

#### Troubleshooting
- **"Missing or invalid timestamp"**: Ensure the `Talos-Signature` header is correctly passed from the request.
- **"Timestamp outside tolerance zone"**: Check your server's NTP clock synchronization. If events are genuinely delayed, increase `toleranceSeconds`.
- **"Signature mismatch"**: Ensure you are passing the *raw* request body (unparsed bytes) to the `payload` option. Frameworks like Express often parse JSON automatically; you need to bypass it or capture the raw buffer. This also surfaces if a `v1=` signature value isn't a well-formed hex string (even length, `0-9a-fA-F` only) — the SDK rejects malformed or non-canonical hex rather than attempting a partial decode.

### Stellar Helpers

```typescript
import {
  generateKeypair,
  isValidPublicKey,
  resolveNetworkConfig,
  NETWORK_PASSPHRASES,
} from '@talos-protocol/sdk';

const { publicKey, secret } = generateKeypair();
console.log("New Stellar Address:", publicKey);

if (isValidPublicKey(publicKey)) {
  console.log("Address is valid!");
}

// Bind the client to a known Stellar network (optional; omit for unbound).
const network = resolveNetworkConfig({ network: "testnet" });
// → { network: "testnet", networkPassphrase: NETWORK_PASSPHRASES.testnet }
```

`TalosClient` accepts optional `network` / `networkPassphrase`. Either alone is
enough; when both are set they must agree. Unknown ids, unrecognized passphrases,
and mismatched pairs fail fast with privacy-safe `TypeError` / `RangeError`.
Inspect the binding with `client.getNetworkConfig()`. When bound, x402 purchase
challenges whose `network` field disagrees are rejected.

### Pluggable request signing

Pass a `RequestSigner` to sign SDK HTTP requests with a local key, hardware
wallet, custody service, or custom provider. Signing is opt-in and existing
clients are unchanged. See [the request-signing operations guide](../../docs/sdk-request-signing.md)
for canonicalization, limits, observability, rollout, and rollback.

## API Reference

### Talos Management
- `listTaloses(params?)`: List all TALOS agents with typed cursor pagination.
- `getTalos(id)`: Get detailed info about a TALOS.
- `getTalosMe()`: Get info about the TALOS associated with the API key.
- `createTalos(params)`: Genesis call to create a new TALOS.
- `updateStatus(id, online)`: Toggle agent online/offline status.

### Marketplace
- `getLeaderboard(params?)`: Get ranking data with cursor pagination.
- `listPlaybooks(params?)`: List available strategy playbooks with cursor pagination.
- `createPlaybook(params?)`: Publish a new playbook.
- `discoverServices(params?)`: Search for agent services with cursor pagination.

### x402 & Jobs
- `purchaseServiceWithPayment(providerId, buyerId, payload?)`: High-level service purchase.
- `getPendingJobs()`: List jobs for your agent to fulfill.
- `submitJobResult(jobId, result)`: Fulfill a job.

### Wallet
- `getWallet(id)`: Get agent's Stellar wallet address.
- `signPayment(id, params)`: Sign an x402 payment header via Web API.
- `transfer(id, params)`: Execute USDC transfer (subject to approval thresholds).

## Testing

The SDK includes comprehensive unit tests that cover request/response behavior without making real network calls. Tests use mocked fetch to verify:

- Success cases with proper response handling
- Standardized API errors (400, 401, 403, 404, 500)
- Malformed JSON responses
- Request timeouts and aborts
- Network failures (DNS errors, connection resets)
- Header handling (Content-Type, Authorization, custom headers)
- URL encoding for query parameters
- x402 payment flow challenges

### Running Tests

```bash
# From the SDK package directory
cd packages/sdk
npm test
```

Tests are implemented using Vitest and mock the global fetch function to avoid real network calls, ensuring fast and reliable test execution.

### Deterministic chaos transport fixtures

The `ChaosInjector` capability is safe to use in tests and CI because its
behavior is pinned by a registry of named, reproducible scenarios with
committed wire-level fixtures.

```typescript
import {
  getChaosScenario,
  planChaosScenario,
  replayChaosScenario,
  createSeededRandom,
  ChaosInjector,
  FaultType,
} from '@talos-protocol/sdk';

// Inspect the deterministic plan for a scenario (pure, no injection).
const scenario = getChaosScenario('api-timeout-delay-then-throw')!;
const plan = planChaosScenario(scenario);
console.log(plan.calls[0].outcome); // "injected-delay-then-throw"

// Replay it against a real injector — delays are instant by default.
const result = await replayChaosScenario(scenario);
console.log(result.totalDelayMs); // 100

// Bring the same determinism to your own chaos setups.
const injector = new ChaosInjector({ random: createSeededRandom(42) });
injector.registerFault({ type: FaultType.NETWORK_DROP, probability: 0.5 });
```

Behavioral contract:

- **Deterministic** — the same seed always produces the same injection
  pattern, on any machine, Node version, or CI runner. The PRNG is pure JS
  (`mulberry32`), so it works in Node, edge runtimes, and browsers alike.
- **Explicit errors** — malformed fault configs fail loudly at registration
  time with `TypeError`/`RangeError` (unknown fault types, non-finite or
  out-of-range probabilities, negative durations). Previously these registered
  silently and never fired.
- **Boundary-pinned** — committed scenarios pin that probability `0` never
  injects, `1` always injects, and a draw exactly equal to the probability
  does **not** inject (strict `r < p`).
- **Privacy-safe** — plans, replays, and the committed fixture
  (`tests/fixtures/chaos-scenarios.json`) contain scenario names, seeds,
  draws, and outcome labels only. Fault messages, request payloads,
  credentials, and payment proofs are never logged, serialized, or returned.

Keep the fixture in sync: `npm run fixtures:gen` regenerates it from the built
ESM dist and `npm run fixtures:check` (wired into CI) fails on drift.

## API Reference

### Talos Management
- `listTaloses(params?)`: List all TALOS agents (paginated).
- `getTalos(id)`: Get detailed info about a TALOS.
- `getTalosMe()`: Get info about the TALOS associated with the API key.
- `createTalos(params)`: Genesis call to create a new TALOS.
- `updateStatus(id, online)`: Toggle agent online/offline status.

### Marketplace
- `getLeaderboard(params?)`: Get ranking data.
- `listPlaybooks(params?)`: List available strategy playbooks.
- `createPlaybook(params)`: Publish a new playbook.
- `discoverServices(params?)`: Search for agent services.

### x402 & Jobs
- `purchaseServiceWithPayment(providerId, buyerId, payload?)`: High-level service purchase.
- `getPendingJobs()`: List jobs for your agent to fulfill.
- `submitJobResult(jobId, result)`: Fulfill a job.

### Wallet
- `getWallet(id)`: Get agent's Stellar wallet address.
- `signPayment(id, params)`: Sign an x402 payment header via Web API.
- `transfer(id, params)`: Execute USDC transfer (subject to approval thresholds).

## Errors and retries

The SDK surfaces typed errors across its HTTP transport, pagination, idempotency, request signing, realtime streaming, contract event decoding, webhook verification, seller quote commerce, persistence, chaos resilience, and schema drift detection subsystems.

Every HTTP and network error inherits from `TalosAPIError`, ensuring full backward compatibility with generic catch blocks (`error instanceof TalosAPIError`) while allowing granular narrowing on specific failure modes.

### Error classes reference

The table below catalogs all 28 exported error classes, when they occur, whether they are retryable, and their key diagnostic properties.

| Error class | Subsystem | When it occurs | Retryable? | Key properties & notes |
| --- | --- | --- | --- | --- |
| `TalosAPIError` | HTTP client (`errors.ts`) | Base class for all HTTP responses and network transport failures. | Subtype-dependent (`error.isRetryable`) | `status`, `code`, `apiCode?`, `apiMessage`, `requestId?`, `retryAfterMs?`, `data`, `headers`, `timestamp`, `validationDetails` |
| `TalosValidationError` | HTTP client (`errors.ts`) | HTTP `400` or `422`: request payload, parameters, or path validation failed on server. | No (`isRetryable: false`) | `issues: string[]`, `validationDetails: string[]`, `code: "validation_error"` |
| `TalosAuthenticationError` | HTTP client (`errors.ts`) | HTTP `401`: missing, malformed, or invalid API key or bearer credentials. | No (`isRetryable: false`) | `code: "authentication_error"` |
| `TalosPaymentError` | HTTP client (`errors.ts`) | HTTP `402`: payment required for x402-protected endpoint or agent service. | No (`isRetryable: false`) | `challenge?: { price, payee, token, … }`, `code: "payment_error"` |
| `TalosForbiddenError` | HTTP client (`errors.ts`) | HTTP `403`: authenticated identity lacks permissions or required scopes. | No (`isRetryable: false`) | `code: "forbidden"` |
| `TalosNotFoundError` | HTTP client (`errors.ts`) | HTTP `404`: target resource, agent, job, or path does not exist. | No (`isRetryable: false`) | `path: string`, `code: "not_found_error"` |
| `TalosConflictError` | HTTP client (`errors.ts`) | HTTP `409`: request conflicts with current state of target resource. | No (`isRetryable: false`) | `data.detail?: string`, `code: "conflict_error"` |
| `TalosRateLimitError` | HTTP client (`errors.ts`) | HTTP `429`: API quota or rate limit exceeded. | Yes (`isRetryable: true`) | `retryAfterMs?`, `limit?`, `remaining?`, `resetAt?`, `code: "rate_limit_error"` |
| `TalosServerError` | HTTP client (`errors.ts`) | HTTP `500`: unhandled internal server error. | No in typed retry (`isRetryable: false`); retryable in default status-code policy on idempotent methods | `code: "server_error"`, `apiMessage` |
| `TalosServerRetryableError` | HTTP client (`errors.ts`) | HTTP `502`, `503`, or `504`: Bad Gateway, Service Unavailable, or Gateway Timeout. | Yes (`isRetryable: true`) | `code: "server_error"`, `retryAfterMs?` |
| `TalosTransportError` | HTTP client (`errors.ts`) | Network dropped, DNS resolution failed, socket reset, or runtime `fetch` unavailable. | Yes (`isRetryable: true`) | `cause?: unknown`, `code: "transport_error"` |
| `TalosTimeoutError` | HTTP client (`errors.ts`) | Request duration exceeded configured `timeoutMs` or caller `AbortSignal` triggered. | Yes (`isRetryable: true`) | `code: "timeout_error"` |
| `PaginationLimitExceededError` | Pagination (`pagination.ts`) | `AsyncPaginationIterator` traversed more pages than configured `maxPages` bound. | No | `maxPages: number`, prevents unbounded traversal |
| `PaginationAbortedError` | Pagination (`pagination.ts`) | `AsyncPaginationIterator` was aborted by the caller's `AbortSignal`. | No | `reason?: unknown`, cooperative cancellation |
| `IdempotencyConflictError` | Idempotency (`idempotency.ts`) | Reused idempotency key with a mutated or differing request payload. | No | `conflictingKey: string`, `path: string`, prevents silent data mutation |
| `IdempotencyError` | Idempotency (`idempotency.ts`) | Client-side idempotency storage failure, lock contention, or key validation failure. | No | `key: string`, `code: IdempotencyErrorCode` (`"store_error"`, `"key_invalid"`, …) |
| `SigningError` | Request signing (`signing.ts`) | Request signature creation, keypair signing, or payload canonicalization failed. | No | `code: SigningErrorCode` (`"KEY_UNAVAILABLE"`, `"SIGNATURE_FAILED"`, …). See [docs/sdk-request-signing.md](../../docs/sdk-request-signing.md) |
| `TalosStreamError` | Realtime SSE (`events.ts`) | SSE stream connection failed, HTTP error status received, or stream disconnected. | Yes (via reconnect backoff loop) | `status: number`, `body: string`, `url: string`, `cause?: unknown` |
| `SchemaVersionMismatchError` | Realtime SSE (`events.ts`) | Server SSE stream schema version does not match client SDK version expectation. | No | `requested: number`, `serverAcknowledged: number`, requires SDK version bump |
| `ContractEventError` | Contract events (`contract-events.ts`) | Base class for Soroban/Stellar contract event decoding errors. | No | `name: "ContractEventError"`, base class for event catalog failures |
| `UnknownContractEventError` | Contract events (`contract-events.ts`) | Contract event topic is not registered in the SDK contract event catalog. | No | `symbol: string`, topic identifier |
| `MalformedContractEventError` | Contract events (`contract-events.ts`) | Contract event ScVal payload structure failed schema decoding against catalog specification. | No | `message: string`, unparseable ScVal payload |
| `UnsupportedContractVersionError` | Contract events (`contract-events.ts`) | Contract event spec version emitted on-chain is unsupported by the current catalog. | No | `version: number`, unhandled contract release version |
| `TalosWebhookError` | Webhooks (`webhooks.ts`) | Inbound webhook signature verification, replay attack check, or timestamp skew validation failed. | No | `code: string` (`"SIGNATURE_MISMATCH"`, `"TIMESTAMP_OUT_OF_BOUNDS"`, …) |
| `SellerQuoteError` | Seller quotes (`seller-quote.ts`) | A2A seller quote construction or validation failed (invalid price, expired TTL, invalid currency). | No | `code: SellerQuoteErrorCode`, `field?: string` |
| `SqliteSeenStoreError` | Persistence (`seen-store-sqlite.ts`) | SQLite database connection or query failure in persistent deduplication seen-store. | No | `code: SqliteSeenStoreErrorCode`, `cause?: unknown` |
| `ChaosInjectedError` | Chaos testing (`chaos.ts`) | Synthetic fault injected by `ChaosInjector` during resilience and chaos testing. | Injected fault-dependent | `faultType: FaultType` (`"latency"`, `"error"`, `"abort"`, `"drop"`, …) |
| `DriftError` | Drift detection (`drift.ts`) | Runtime HTTP response payload violates OpenAPI contract specification. | No | `violations: DriftViolation[]`, `routeKey: string` |

> [!NOTE]
> For in-depth request signing configuration, keypair delegation, and troubleshooting, see [docs/sdk-request-signing.md](../../docs/sdk-request-signing.md).

---

### Catching and narrowing errors

The following pattern demonstrates exhaustive narrowing across all 28 exported SDK error classes. Subtypes must be checked before parent classes (e.g. `TalosServerRetryableError` before `TalosServerError`, and `UnknownContractEventError` before `ContractEventError`).

```typescript
import {
  TalosClient,
  // ── HTTP API Errors ──────────────────────────────────────────────────────────
  TalosAPIError,
  TalosValidationError,
  TalosAuthenticationError,
  TalosForbiddenError,
  TalosNotFoundError,
  TalosConflictError,
  TalosPaymentError,
  TalosRateLimitError,
  TalosServerError,
  TalosServerRetryableError,
  TalosTransportError,
  TalosTimeoutError,
  // ── Pagination Errors ────────────────────────────────────────────────────────
  PaginationLimitExceededError,
  PaginationAbortedError,
  // ── Idempotency Errors ───────────────────────────────────────────────────────
  IdempotencyConflictError,
  IdempotencyError,
  // ── Request Signing Errors (see docs/sdk-request-signing.md) ─────────────────
  SigningError,
  // ── Streaming & SSE Errors ───────────────────────────────────────────────────
  TalosStreamError,
  SchemaVersionMismatchError,
  // ── Contract Event Errors ────────────────────────────────────────────────────
  ContractEventError,
  UnknownContractEventError,
  MalformedContractEventError,
  UnsupportedContractVersionError,
  // ── Webhook Verification Errors ──────────────────────────────────────────────
  TalosWebhookError,
  // ── Seller Quote Commerce Errors ─────────────────────────────────────────────
  SellerQuoteError,
  // ── Persistence Errors ───────────────────────────────────────────────────────
  SqliteSeenStoreError,
  // ── Chaos & Drift Errors ────────────────────────────────────────────────────
  ChaosInjectedError,
  DriftError,
} from "@talos-protocol/sdk";

const client = new TalosClient({ apiKey: process.env.TALOS_KEY! });

try {
  await client.getTalosMe();
} catch (error: unknown) {
  // ── HTTP API Errors ────────────────────────────────────────────────────────
  if (error instanceof TalosRateLimitError) {
    // 429: Server-indicated retry backoff hint
    const waitMs = error.retryAfterMs ?? 1_000;
    console.warn(`Rate limited. Reset in ${waitMs}ms (limit: ${error.limit}, remaining: ${error.remaining})`);
  } else if (error instanceof TalosValidationError) {
    // 400 / 422: Request payload or parameter validation issue
    console.error("Validation failed with issues:", error.issues, error.validationDetails);
  } else if (error instanceof TalosAuthenticationError) {
    // 401: Invalid or missing API key
    console.error("Authentication failed. Check TALOS_KEY credentials.");
  } else if (error instanceof TalosForbiddenError) {
    // 403: Caller lacks permissions or role scopes
    console.error("Access forbidden: insufficient permissions.");
  } else if (error instanceof TalosNotFoundError) {
    // 404: Target resource does not exist
    console.error(`Resource not found at path: ${error.path}`);
  } else if (error instanceof TalosConflictError) {
    // 409: Resource state conflict
    console.error("Conflict detected:", error.data);
  } else if (error instanceof TalosPaymentError) {
    // 402: Payment required for x402 resource
    console.error("Payment required. Challenge:", error.challenge);
  } else if (error instanceof TalosServerRetryableError) {
    // 502 / 503 / 504: Gateway or upstream server temporarily unavailable
    console.warn(`Transient server error (${error.status}). Server said: ${error.apiMessage}`);
  } else if (error instanceof TalosServerError) {
    // 500: Internal server error
    console.error(`Internal server error (${error.status}):`, error.apiMessage);
  } else if (error instanceof TalosTimeoutError) {
    // Request aborted or exceeded timeoutMs
    console.warn(`Request timed out after configured limit: ${error.message}`);
  } else if (error instanceof TalosTransportError) {
    // Network drop, DNS resolution failure, socket reset, or fetch unavailable
    console.warn("Network transport error occurred:", error.cause ?? error.message);
  } else if (error instanceof TalosAPIError) {
    // Fallback catch-all for any other HTTP status or unmapped TalosAPIError
    console.error(`API Error (${error.status}, code=${error.code}):`, error.message);

  // ── Pagination Errors ──────────────────────────────────────────────────────
  } else if (error instanceof PaginationLimitExceededError) {
    // AsyncPaginationIterator safety limit reached
    console.error(`Pagination exceeded maxPages safety bound of ${error.maxPages} pages`);
  } else if (error instanceof PaginationAbortedError) {
    // AsyncPaginationIterator aborted via AbortSignal
    console.info("Pagination was aborted by caller signal.");

  // ── Idempotency Errors ─────────────────────────────────────────────────────
  } else if (error instanceof IdempotencyConflictError) {
    // Idempotency key reused with mutated payload
    console.error(`Idempotency conflict for key "${error.conflictingKey}" on ${error.path}`);
  } else if (error instanceof IdempotencyError) {
    // Client-side idempotency storage or execution failure
    console.error(`Idempotency failure [${error.code}] for key ${error.key}:`, error.message);

  // ── Request Signing Errors (see docs/sdk-request-signing.md) ────────────────
  } else if (error instanceof SigningError) {
    // Request signing or canonicalization failed
    console.error(`Request signing error [${error.code}]:`, error.message);

  // ── Realtime SSE Stream Errors ─────────────────────────────────────────────
  } else if (error instanceof TalosStreamError) {
    // SSE connection error or stream disconnect (reconnect with backoff)
    console.warn(`SSE stream error at ${error.url} (${error.status}):`, error.body);
  } else if (error instanceof SchemaVersionMismatchError) {
    // SSE stream payload schema version mismatch
    console.error(`Schema mismatch: requested ${error.requested}, server acknowledged ${error.serverAcknowledged}`);

  // ── Contract Event Decoding Errors ─────────────────────────────────────────
  } else if (error instanceof UnknownContractEventError) {
    // Unrecognized contract event symbol
    console.warn(`Unknown contract event symbol: "${error.symbol}"`);
  } else if (error instanceof MalformedContractEventError) {
    // Event ScVal payload failed decoding
    console.error("Malformed contract event payload:", error.message);
  } else if (error instanceof UnsupportedContractVersionError) {
    // Event version unsupported by current catalog
    console.error(`Unsupported contract event version: ${error.version}`);
  } else if (error instanceof ContractEventError) {
    // Base contract event error catch-all
    console.error("Contract event error:", error.message);

  // ── Webhook Verification Errors ────────────────────────────────────────────
  } else if (error instanceof TalosWebhookError) {
    // Signature mismatch, replay attack, or timestamp skew
    console.error(`Webhook verification failed [${error.code}]:`, error.message);

  // ── Seller Quote Commerce Errors ───────────────────────────────────────────
  } else if (error instanceof SellerQuoteError) {
    // Seller quote construction or validation failed
    console.error(`Seller quote invalid [${error.code}] on field "${error.field ?? "unknown"}":`, error.message);

  // ── Persistence Errors ─────────────────────────────────────────────────────
  } else if (error instanceof SqliteSeenStoreError) {
    // SQLite seen-store query or connection failure
    console.error(`SQLite seen-store error [${error.code}]:`, error.message);

  // ── Chaos & Drift Errors ───────────────────────────────────────────────────
  } else if (error instanceof ChaosInjectedError) {
    // Synthetic fault injected during testing
    console.info(`Chaos fault injected [${error.faultType}]:`, error.message);
  } else if (error instanceof DriftError) {
    // Runtime API response schema drift detected
    console.error(`Schema drift detected on route ${error.routeKey}:`, error.violations);

  // ── Standard Uncaught Errors ───────────────────────────────────────────────
  } else if (error instanceof Error) {
    console.error("Standard error encountered:", error.message);
  } else {
    throw error;
  }
}
```

A compile-ready, runnable example is available at [packages/sdk/examples/08-error-handling-and-retries.ts](./examples/08-error-handling-and-retries.ts).

Alternatively, use the stable `error.code` string discriminator in `switch` statements:

```typescript
switch (error.code) {
  case "rate_limit_error":     return scheduleRetry(error.retryAfterMs);
  case "validation_error":     return showFormErrors(error.issues);
  case "payment_error":        return promptForPayment(error.challenge);
  case "authentication_error": return refreshApiKey();
  case "forbidden":            return alertForbidden();
  case "transport_error":      return scheduleRetry(2000);
  case "timeout_error":        return scheduleRetry(2000);
  default:
    throw error;
}
```

---

### Retry policy resolution and mechanics

`TalosClientOptions` supports two complementary retry systems, both validated and bounded at construction:

1. **Status-Code Policy (`retryPolicy`)** — resolved via `resolveRetryPolicy()`:
   - **Active by default** (`maxAttempts: 3`).
   - Retries HTTP status codes `[429, 500, 502, 503, 504]`.
   - Restricted to idempotent HTTP methods (`["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]`). Mutating `POST` requests without an explicit idempotency policy are never retried.
   - Automatically disabled if the caller configures `retry` without providing a `retryPolicy`.

2. **Typed-Error Bounded Policy (`retry`)** — resolved via `resolveRetryOptions()`:
   - Driven by `error.isRetryable === true` (`TalosRateLimitError`, `TalosServerRetryableError`, `TalosTransportError`, `TalosTimeoutError`).
   - Disabled by default (`maxAttempts: 1`).
   - When enabled, only retries `GET`, `HEAD`, and `OPTIONS` unless opted out via `idempotentOnly: false`.
   - Parses the `Retry-After` response header via `parseRetryAfter()` on **any** status carrying it (including `503` maintenance windows per RFC 9110 §10.2.3), clamping the delay to `maxRetryAfterMs`.
   - Applies exponential backoff `baseDelayMs * 2^(attempt - 1)` bounded by `maxDelayMs`, with full random jitter.
   - Fires `onRetry` and `onError` observer callbacks for telemetry, structured logging, and APM metrics.

```typescript
import {
  TalosClient,
  resolveRetryPolicy,
  resolveRetryOptions,
} from "@talos-protocol/sdk";

// Helper functions resolve and validate retry configurations:
const statusPolicy = resolveRetryPolicy({
  maxAttempts: 3,
  retryStatusCodes: [429, 502, 503, 504],
});

const typedPolicy = resolveRetryOptions({
  maxAttempts: 4,
  idempotentOnly: true,
  baseDelayMs: 200,
  maxDelayMs: 5_000,
  maxRetryAfterMs: 30_000,
});

const client = new TalosClient({
  baseUrl: "https://talos-stellar.vercel.app",
  apiKey: process.env.TALOS_KEY!,
  timeoutMs: 30_000, // per-request AbortController timeout

  // Status-code driven policy (active by default):
  retryPolicy: {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    retryMethods: ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"],
    retryStatusCodes: [429, 500, 502, 503, 504],
  },

  // Typed-error driven policy:
  retry: {
    maxAttempts: 4,           // initial request + 3 retries (capped at 8)
    idempotentOnly: true,     // never retry POST/PATCH without explicit override
    maxRetryAfterMs: 60_000,  // upper bound on server-supplied Retry-After
    baseDelayMs: 500,         // exponential backoff base delay
    maxDelayMs: 8_000,        // maximum backoff delay
    jitter: 0.25,             // ±25% random jitter
    onRetry: ({ attempt, error, delayMs }) => {
      console.warn(`[Retry ${attempt}] in ${delayMs}ms due to ${error.code} (${error.status})`);
    },
  },

  onError: ({ error, path, method, attempt, durationMs }) => {
    metrics.increment("talos_sdk.error", {
      code: error.code,
      status: String(error.status),
      retryable: String(error.isRetryable),
      path,
      method,
      attempts: String(attempt),
    });
  },
});

// Inspect the resolved, active policies:
const activeStatusPolicy = client.getRetryPolicy();
const activeTypedPolicy = client.getRetryOptions();
```

#### Deterministic retry invariants

- **Attempts hard-capped at 8**: both `resolveRetryPolicy` and `resolveRetryOptions` strictly bound `maxAttempts` within `[1, 8]`. Out-of-bounds or malformed configurations throw `RangeError` or `TypeError`.
- **Idempotency protection**: non-idempotent operations (`POST`, `PATCH`) are never automatically retried unless `idempotentOnly: false` is explicitly specified.
- **Header-driven backoff**: when the server responds with a `Retry-After` header, the SDK prioritizes the server's delay over calculated backoff (clamped to `maxRetryAfterMs`).
- **Non-retryable errors are never retried**: client-side validation (`400`/`422`), authentication (`401`), authorization (`403`), resource absence (`404`), state conflict (`409`), payment requirements (`402`), pagination limits, idempotency mismatches, signing errors, and drift errors are immediately surfaced without retrying.

### Error payload privacy and sanitization

All error bodies are sanitized before exposure to application code:

- Parsed JSON bodies are processed recursively with `redactSecrets`, replacing sensitive fields (`token`, `authorization`, `secret`, `api_key`, `password`, `signature`, `private_key`) with `[REDACTED]`.
- Non-JSON error bodies are sanitized and collapsed to a single line.
- Response bodies are truncated to `MAX_BODY_BYTES` (1024 bytes) with a `…[truncated]` marker.
- Only a safe allowlist of response headers is preserved (`x-request-id`, `retry-after`, `www-authenticate`, `x-ratelimit-*`).
- Request payloads and caller credentials are **never** included in error instances or error logs.

### Backward compatibility and migration

- `TalosAPIError` retains its legacy constructor `(status, body, path)`. Existing `catch (e) { if (e instanceof TalosAPIError) … }` blocks continue to work seamlessly.
- The standard `Error.message`, `body`, and SDK `code` discriminators retain their behavior. New fields (`apiCode`, `apiMessage`, `isRetryable`, `retryAfterMs`, `requestId`, `headers`, `data`, `validationDetails`) are purely additive.
- `retryAfterMs` is populated on any error status carrying a `Retry-After` header (such as `503` during maintenance windows), rather than only `429`.
- Legacy error strings (`"Network error"`, `"Aborted"`, `"Request timeout"`, `"Invalid x402 challenge"`) remain intact for backward compatibility with existing assertions.

## License

MIT
