/**
 * Seeded request-boundary fuzz helpers for API validation.
 *
 * Used by Vitest to hammer `parseBody` with missing, malformed, boundary,
 * retry-stable, and privacy-sensitive payloads — without a live server.
 *
 * Deliberately dependency-free (no fast-check): a tiny mulberry32 PRNG keeps
 * CI deterministic while still exploring a broad input space.
 */

import type { z } from "zod/v4";
import { parseBody, BODY_LIMIT_BYTES } from "./schemas";

/** Canonical secret-ish markers we plant in fuzz payloads. */
export const FUZZ_SECRET_MARKERS = [
  "sk-live-FUZZ-SECRET-DO-NOT-LEAK",
  "SSECRETSEEDFUZZ00000000000000000000000000000000000000",
  "payment-proof-fuzz-ABCDEF0123456789",
  "Bearer fuzz-auth-token-LEAK-ME",
] as const;

const SENSITIVE_KEYS = [
  "signature",
  "apiKey",
  "authorization",
  "paymentProof",
  "seed",
  "secret",
  "privateKey",
] as const;

export type FuzzCase = {
  name: string;
  /** Raw body string (may be invalid JSON). */
  body: string;
  headers?: Record<string, string>;
  /** Expected HTTP status when parsed against the supplied schema. */
  expectStatus: number;
  /** Optional machine-readable error code. */
  expectCode?: string;
};

/** Deterministic mulberry32 PRNG. */
export function createRng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/** Build a JSON object nested `depth` levels deep. */
export function nestedObject(depth: number, leaf: unknown = { ok: true }): unknown {
  let cur: unknown = leaf;
  for (let i = 0; i < depth; i++) {
    cur = { nest: cur };
  }
  return cur;
}

/** Build an object with `count` top-level keys. */
export function wideObject(count: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    out[`k${i}`] = i;
  }
  return out;
}

/**
 * Generate a battery of request-boundary cases for a write schema.
 * Cases cover missing / malformed / boundary / sensitive / retry stability.
 */
export function generateBoundaryCases(seed = 530): FuzzCase[] {
  const rng = createRng(seed);
  const cases: FuzzCase[] = [];

  // Missing / empty
  cases.push({
    name: "empty body",
    body: "",
    expectStatus: 400,
    expectCode: "INVALID_JSON",
  });
  cases.push({
    name: "JSON null root",
    body: "null",
    expectStatus: 400,
    expectCode: "VALIDATION_ERROR",
  });
  cases.push({
    name: "JSON array root",
    body: "[]",
    expectStatus: 400,
    expectCode: "VALIDATION_ERROR",
  });
  cases.push({
    name: "empty object (missing required fields)",
    body: "{}",
    expectStatus: 400,
    expectCode: "VALIDATION_ERROR",
  });

  // Malformed JSON
  cases.push({
    name: "truncated JSON",
    body: '{"title":',
    expectStatus: 400,
    expectCode: "INVALID_JSON",
  });
  cases.push({
    name: "single-quoted JSON",
    body: "{'title':'x'}",
    expectStatus: 400,
    expectCode: "INVALID_JSON",
  });
  cases.push({
    name: "NaN literal (non-JSON)",
    body: '{"n": NaN}',
    expectStatus: 400,
    expectCode: "INVALID_JSON",
  });
  cases.push({
    name: "UTF-8 BOM prefix",
    body: "\uFEFF{}",
    expectStatus: 400,
    expectCode: "INVALID_JSON",
  });

  // Wrong types / boundary
  cases.push({
    name: "wrong-type fields",
    body: JSON.stringify({
      title: 123,
      category: false,
      price: { amount: 1 },
      tags: "not-an-array",
    }),
    expectStatus: 400,
    expectCode: "VALIDATION_ERROR",
  });
  cases.push({
    name: "overlong string field",
    body: JSON.stringify({
      title: "T".repeat(10_000),
      category: "Marketing",
      price: "1",
    }),
    expectStatus: 400,
    expectCode: "VALIDATION_ERROR",
  });

  // Sensitive payloads — fail validation while planting secrets so the
  // error envelope is exercised; markers must never appear in the response.
  for (const key of SENSITIVE_KEYS) {
    const secret = pick(rng, FUZZ_SECRET_MARKERS);
    cases.push({
      name: `sensitive field ${key}`,
      body: JSON.stringify({
        title: "", // fails min(1) → VALIDATION_ERROR
        category: "Marketing",
        price: "1",
        [key]: secret,
        meta: { [key]: secret, nested: { seed: secret } },
      }),
      expectStatus: 400,
      expectCode: "VALIDATION_ERROR",
    });
  }

  // Nested / wide complexity (within byte limit)
  cases.push({
    name: "deeply nested object",
    body: JSON.stringify(nestedObject(80)),
    expectStatus: 400,
    expectCode: "PAYLOAD_TOO_COMPLEX",
  });
  cases.push({
    name: "very wide object",
    body: JSON.stringify(wideObject(2_500)),
    expectStatus: 400,
    expectCode: "PAYLOAD_TOO_COMPLEX",
  });

  // Oversized (413)
  const oversizePad = "a".repeat(BODY_LIMIT_BYTES + 64);
  cases.push({
    name: "body over byte limit",
    body: `{"x":"${oversizePad}"}`,
    expectStatus: 413,
    expectCode: "PAYLOAD_TOO_LARGE",
  });
  cases.push({
    name: "content-length declares oversize",
    body: '{"x":"small"}',
    headers: { "content-length": String(BODY_LIMIT_BYTES + 1) },
    expectStatus: 413,
    expectCode: "PAYLOAD_TOO_LARGE",
  });

  // Dependency-failure style: declare content-length but body stream is fine —
  // covered above. Also: non-finite content-length should not 413.
  cases.push({
    name: "garbage content-length ignored for size gate",
    body: "{}",
    headers: { "content-length": "not-a-number" },
    expectStatus: 400,
    expectCode: "VALIDATION_ERROR",
  });

  return cases;
}

/** Positive fixture that should pass createPlaybookSchema-shaped validation. */
export function validPlaybookBody(): string {
  return JSON.stringify({
    title: "Boundary fuzz playbook",
    category: "Marketing",
    price: "12.5",
    currency: "USDC",
    description: "positive path",
    tags: ["fuzz", "boundary"],
  });
}

/**
 * Run one fuzz case through `parseBody` and return the response snapshot.
 * Never throws on validation failure — surfaces status + JSON body.
 */
export async function runFuzzCase<T extends z.ZodType>(
  schema: T,
  fuzzCase: FuzzCase,
): Promise<{ status: number; body: Record<string, unknown> | null; rawText: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(fuzzCase.headers ?? {}),
  };
  const request = new Request("http://localhost/api/fuzz-boundary", {
    method: "POST",
    headers,
    body: fuzzCase.body,
  });
  const result = await parseBody(request, schema);
  if (!result.error) {
    return { status: 200, body: { ok: true, data: result.data }, rawText: "" };
  }
  const rawText = await result.error.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(rawText) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: result.error.status, body, rawText };
}
