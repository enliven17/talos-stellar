/**
 * Request-boundary fuzz coverage for API validation (`parseBody`).
 *
 * Positive / negative / boundary / retry / privacy regression cases.
 * No Next.js server or database required — synthetic Request fixtures only.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { createPlaybookSchema, parseBody, BODY_LIMIT_BYTES } from "../src/lib/schemas";
import {
  FUZZ_SECRET_MARKERS,
  generateBoundaryCases,
  runFuzzCase,
  validPlaybookBody,
  nestedObject,
  createRng,
} from "../src/lib/request-boundary-fuzz";

describe("request-boundary fuzz — positive path", () => {
  it("accepts a valid playbook payload unchanged", async () => {
    const request = new Request("http://localhost/api/playbooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validPlaybookBody(),
    });
    const result = await parseBody(request, createPlaybookSchema);
    expect(result.error).toBeUndefined();
    expect(result.data?.title).toBe("Boundary fuzz playbook");
    expect(result.data?.currency).toBe("USDC");
  });
});

describe("request-boundary fuzz — generated battery", () => {
  const cases = generateBoundaryCases(530);

  for (const fuzzCase of cases) {
    it(`${fuzzCase.name} → HTTP ${fuzzCase.expectStatus}`, async () => {
      const snapshot = await runFuzzCase(createPlaybookSchema, fuzzCase);
      expect(snapshot.status).toBe(fuzzCase.expectStatus);
      if (fuzzCase.expectCode) {
        expect(snapshot.body?.code).toBe(fuzzCase.expectCode);
      }
      // Privacy: planted secrets never appear in the response envelope
      const haystack = snapshot.rawText || JSON.stringify(snapshot.body ?? {});
      for (const marker of FUZZ_SECRET_MARKERS) {
        expect(haystack).not.toContain(marker);
      }
      // Envelope shape on errors
      if (snapshot.status >= 400) {
        expect(snapshot.body).toMatchObject({
          code: expect.any(String),
          message: expect.any(String),
          requestId: expect.any(String),
        });
      }
    });
  }
});

describe("request-boundary fuzz — retry stability", () => {
  it("returns the same error code for identical malformed retries", async () => {
    const fuzzCase = {
      name: "retry",
      body: '{"title":',
      expectStatus: 400,
      expectCode: "INVALID_JSON",
    };
    const a = await runFuzzCase(createPlaybookSchema, fuzzCase);
    const b = await runFuzzCase(createPlaybookSchema, fuzzCase);
    expect(a.status).toBe(b.status);
    expect(a.body?.code).toBe(b.body?.code);
    expect(a.body?.message).toBe(b.body?.message);
  });

  it("returns stable VALIDATION_ERROR for empty-object retries", async () => {
    const fuzzCase = {
      name: "retry-empty",
      body: "{}",
      expectStatus: 400,
      expectCode: "VALIDATION_ERROR",
    };
    const a = await runFuzzCase(createPlaybookSchema, fuzzCase);
    const b = await runFuzzCase(createPlaybookSchema, fuzzCase);
    expect(a.body?.code).toBe("VALIDATION_ERROR");
    expect(b.body?.code).toBe("VALIDATION_ERROR");
    expect(a.body?.issues).toEqual(b.body?.issues);
  });
});

describe("request-boundary fuzz — privacy regression", () => {
  it("redacts sensitive path values from Zod issue strings", async () => {
    // Schema that will fail on signature length while still naming the path
    const schema = z.object({
      signature: z.string().min(100),
      title: z.string().min(1),
    });
    const secret = FUZZ_SECRET_MARKERS[0];
    const request = new Request("http://localhost/api/fuzz", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature: secret, title: "" }),
    });
    const result = await parseBody(request, schema);
    expect(result.error).toBeDefined();
    const body = await result.error!.json();
    const issues: string[] = body.issues ?? [];
    const joined = issues.join("\n");
    expect(joined).not.toContain(secret);
    // Path should still be identifiable
    expect(joined.toLowerCase()).toMatch(/signature|title/);
  });
});

describe("request-boundary fuzz — seeded generator smoke", () => {
  it("is deterministic for the same seed", () => {
    const a = generateBoundaryCases(42).map((c) => c.name);
    const b = generateBoundaryCases(42).map((c) => c.name);
    expect(a).toEqual(b);
  });

  it("PRNG stays in unit interval", () => {
    const rng = createRng(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("nestedObject builds the requested depth", () => {
    const obj = nestedObject(3, "leaf") as { nest: { nest: { nest: string } } };
    expect(obj.nest.nest.nest).toBe("leaf");
  });

  it("documents BODY_LIMIT_BYTES is positive", () => {
    expect(BODY_LIMIT_BYTES).toBeGreaterThan(0);
  });
});
