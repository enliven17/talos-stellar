# Server-Side Schema Drift Detection

## Overview

The web API includes an SDK boundary drift detection system located in [`web/src/lib/drift/`](file:///c:/Users/HP/drips/first/talos-stellar/web/src/lib/drift).

**Schema drift** is divergence between what an SDK client sends and what the web API expects. The drift detection subsystem validates incoming HTTP request payloads at the Next.js API boundary against pre-compiled JSON Schemas in [`web/src/generated/schemas/`](file:///c:/Users/HP/drips/first/talos-stellar/web/src/generated/schemas) (derived from the authoritative Zod schemas in [`web/src/lib/schemas.ts`](file:///c:/Users/HP/drips/first/talos-stellar/web/src/lib/schemas.ts)).

### Architecture

```
HTTP Request (POST / PUT / PATCH)
  └─▶ withDriftDetection(routeKey, handler)
        ├─ Mode check: mode == "off" ──▶ skip validation, call handler directly
        ├─ Sampling check: shouldSample(config) ──▶ maybe skip (probabilistic)
        ├─ JSON parse: invalid JSON ──▶ strict: 422 reject / warn: log violation & proceed
        ├─ Schema lookup: registry.get(routeKey) ──▶ if missing: recordNoSchema, call handler
        ├─ validateAgainstSchema(body, schema, policy)
        │     ├─ Clean ──▶ recordClean(), call handler
        │     ├─ Violations in "warn" mode ──▶ recordWarn(), call handler
        │     └─ Violations in "strict" mode ──▶ recordReject(), return 422 Unprocessable Entity
        └─ Failure safety: unexpected validator exception ──▶ recordValidatorError(), call handler
```

### Key Principles

1. **Failure Safety:** Drift detection must never crash production traffic. Any unexpected error in the validator is caught and logged, allowing the request to proceed.
2. **Privacy Guarantees:** Field values are **never logged or leaked**. Violation records only capture JSON Pointer paths, violation categories, expected types, and received types.
3. **Zero Cost When Disabled:** When `mode` is `"off"`, validation is short-circuited immediately without buffering or parsing overhead.
4. **Transparent Re-injection:** Request streams are buffered and re-injected via a cloned `NextRequest` so downstream route handlers can call `req.json()` or `req.text()` normally.

---

## Configuration & Tuning

Configuration is resolved at application startup from environment variables and can be overridden per-route or dynamically in tests.

### Environment Variables

| Variable | Type | Default | Description |
|---|---|---|---|
| `DRIFT_MODE` | `off` \| `warn` \| `strict` | `off` | Validation mode across all wrapped routes. |
| `DRIFT_SAMPLE_RATE` | `float` (0.0 – 1.0) | `1.0` | Fraction of requests evaluated. Ignored when `DRIFT_MODE="off"`. |
| `DRIFT_UNKNOWN_FIELDS` | `allow` \| `strip` \| `reject` | `allow` | Policy for request payload fields not defined in the schema. |

### Drift Modes (`DriftMode`)

- **`off` (default):** Validation is skipped entirely. No performance overhead or body parsing.
- **`warn`:** Incoming payloads are validated against the schema. Violations are recorded in in-memory counters and logged with request context (`requestId`, `routeKey`, violation paths/types), but the request is passed through to the handler.
- **`strict`:** Violations result in an immediate `422 Unprocessable Entity` HTTP response containing a structured violation list. The route handler is never executed.

### Sampling (`sampler.ts`)

Sampling allows operators to balance CPU and latency overhead with schema coverage under heavy traffic loads.

- Controlled via `DRIFT_SAMPLE_RATE` (clamped between `0.0` and `1.0`).
- **`1.0`:** 100% of mutating requests are inspected.
- **`0.1`:** ~10% of requests are sampled probabilistically using uniform distribution (`random() < sampleRate`).
- **`0.0`:** Sampling always evaluates to false (skips validation).
- When a request is skipped due to sampling or mode `"off"`, the `skipped` counter is incremented.

### Unknown Field Policy (`UnknownFieldPolicy`)

Controls how extra fields not defined in the JSON Schema are handled:

- **`allow` (default):** Unknown fields pass through unchanged, maximizing forward-compatibility for newer SDK versions.
- **`strip`:** Unknown keys are stripped recursively from the parsed object before forwarding to the handler (when no other violations exist).
- **`reject`:** Any field not explicitly permitted by schema properties causes an `unknown_field` violation (triggering warnings in `warn` mode or 422 rejection in `strict` mode).

---

## Route Handler Middleware Usage

Wrap route handlers with `withDriftDetection`:

```typescript
import { withDriftDetection } from "@/lib/drift";

async function handler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const body = await req.json();
  // ... process request ...
  return Response.json({ ok: true });
}

// Wrap with route key
export const POST = withDriftDetection("POST /api/talos/:id/activity", handler);

// Optional per-route config override
export const PUT = withDriftDetection(
  "PUT /api/talos/:id/service",
  handler,
  { mode: "strict", sampleRate: 0.5 }
);
```

Only mutating methods (`POST`, `PUT`, `PATCH`) carry request bodies and are validated. Non-mutating methods pass through directly.

---

## Metrics & Observability

Observability is implemented in [`web/src/lib/drift/metrics.ts`](file:///c:/Users/HP/drips/first/talos-stellar/web/src/lib/drift/metrics.ts).

### In-Process Counters

Lightweight in-memory counters track drift activity since process startup. Retrieve them via `getDriftCounters()` (e.g. for exposure in health check endpoints):

```typescript
import { getDriftCounters } from "@/lib/drift";

const metrics = getDriftCounters();
```

| Counter Name | Type | Description |
|---|---|---|
| `validated` | `number` | Count of requests that underwent schema validation. |
| `skipped` | `number` | Count of requests skipped because `mode === "off"` or excluded by probabilistic sampling. |
| `warned` | `number` | Total number of violations encountered in `warn` mode across all requests. |
| `rejected` | `number` | Total number of violations that led to a `422` rejection in `strict` mode. |
| `errors` | `number` | Count of unexpected internal exceptions thrown by the validator (caught and swallowed to preserve traffic flow). |

*(Note: `warned` and `rejected` accumulate total violation counts, so a single request with 3 invalid fields adds 3 to the respective counter).*

### Structured Logs

The drift middleware emits structured logs using Pino:

- **Clean request:** Emitted at `debug` level with `{ requestId, routeKey, drift: "clean" }`.
- **Warn mode violation:** Emitted at `warn` level with `{ requestId, routeKey, drift: "warn", violationCount, violations: [...] }`.
- **Strict mode reject:** Emitted at `warn` level with `{ requestId, routeKey, drift: "strict", violationCount, violations: [...] }`.
- **Internal validator error:** Emitted at `error` level with `{ requestId, routeKey, mode, err }`.
- **Missing route schema:** Emitted at `debug` level with `{ requestId, routeKey, drift: "no_schema" }`.

### Violation Structure (`DriftViolation`)

Violation objects conform to RFC 6901 JSON Pointers and privacy safety:

```json
{
  "path": "/metadata/tags",
  "kind": "type_mismatch",
  "message": "expected array but received string",
  "expectedType": "array",
  "receivedType": "string"
}
```

#### Violation Kinds (`DriftViolationKind`)

- `missing_required`: A required field was omitted.
- `type_mismatch`: Field was present but did not match expected type (or schema variant).
- `invalid_value`: Value failed an enum, regex pattern, string length, or numerical range constraint.
- `unknown_field`: Payload contained an unmapped field when policy is `reject` or schema disallows additional properties.
- `invalid_json`: Request body failed initial JSON parsing.
- `schema_not_found`: No registered schema exists for the route key.

---

## Schema Generation & Regeneration

JSON schemas are generated from Zod definitions using [`zod-to-json-schema`](https://www.npmjs.com/package/zod-to-json-schema) Draft-07 format and checked into git under `web/src/generated/schemas/`.

### When to Regenerate

Re-run schema generation whenever schemas in [`web/src/lib/schemas.ts`](file:///c:/Users/HP/drips/first/talos-stellar/web/src/lib/schemas.ts) or route registrations are modified. CI enforces schema parity via OpenAPI snapshot tests.

### How to Regenerate

From the `web` workspace:

```bash
pnpm schemas:generate
```

Or from repository root:

```bash
pnpm --filter web schemas:generate
```

### Generation Script Details

The generator script [`web/scripts/generate-schemas.ts`](file:///c:/Users/HP/drips/first/talos-stellar/web/scripts/generate-schemas.ts):
1. Inlines all schema definitions (`$refStrategy: "none"`) so schemas can be evaluated self-contained at runtime without multi-file ref resolution.
2. Emits individual `<schemaName>.json` files in `web/src/generated/schemas/`.
3. Writes `web/src/generated/schemas/index.json`, providing a manifest of schemas, filenames, and mapped route keys.
4. Schemas are bootstrapped into the server registry on startup by [`web/src/lib/drift-schemas.ts`](file:///c:/Users/HP/drips/first/talos-stellar/web/src/lib/drift-schemas.ts).

---

## SDK Pre-Flight Drift Detection (`DriftDetector`)

In addition to server-side enforcement, the TypeScript SDK provides a mirrored client-side detector [`DriftDetector`](file:///c:/Users/HP/drips/first/talos-stellar/packages/sdk/src/drift.ts) in `@talos-protocol/sdk`.

This allows clients to catch schema mismatches before sending requests over the network.

### SDK Usage Example

```typescript
import { DriftDetector } from "@talos-protocol/sdk";
import activitySchema from "@talos-protocol/web/src/generated/schemas/reportActivity.json";

// Initialize detector
const detector = new DriftDetector({
  mode: "warn", // "off" | "warn" | "strict"
  sampleRate: 1.0,
  unknownFieldPolicy: "allow", // "allow" | "strip" | "reject"
  onViolation: (routeKey, violations) => {
    console.warn(`[SDK Drift] ${routeKey}:`, violations);
  },
});

// Register schema against route key
detector.registerSchema("POST /api/talos/:id/activity", activitySchema);

// Perform pre-flight validation
const isValid = detector.validate("POST /api/talos/:id/activity", payload);

// In strict mode, detector.validate throws DriftError if violations are found:
// try {
//   detector.validate("POST /api/talos/:id/activity", invalidPayload);
// } catch (err) {
//   if (err instanceof DriftError) {
//     console.error("Drift violations:", err.violations);
//   }
// }
```
