/**
 * Deterministic full-stack smoke fixture — contract and behavior tests.
 *
 * Covers the positive, negative, boundary, regression, and privacy behavior
 * of scripts/smoke-fixture.lib.mjs (shared by the generator script and this
 * suite) and asserts the committed fixture at
 * web/tests/fixtures/smoke-fixture.json stays canonical and deterministic.
 *
 * Local command:
 *   pnpm --dir web exec vitest run tests/smoke-fixture.unit.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSmokeFixture,
  canonicalize,
  deriveDeterministicId,
  deriveTruncatedAddress,
  findDrift,
  fnv1a32,
  validateSmokeFixture,
  FIXTURE_REL_PATH,
  SMOKE_FIXTURE_SCHEMA_VERSION,
} from "../../scripts/smoke-fixture.lib.mjs";

const repoRoot = resolve(__dirname, "../..");
const fixturePath = resolve(repoRoot, FIXTURE_REL_PATH);

// ─── Positives ───────────────────────────────────────────────────────────────

describe("smoke fixture: positive", () => {
  it("builds a fixture that passes validation", () => {
    const fixture = buildSmokeFixture();
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("contains at least one agent with the full agent contract", () => {
    const { agents } = buildSmokeFixture();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    for (const agent of agents) {
      expect(agent.id).toMatch(/^smoke-[0-9a-f]{8}$/);
      expect(agent.status).toBe("Active");
      expect(agent.currency).toBe("USDC");
      expect(agent.chains).toEqual(["stellar"]);
      expect(agent.fulfillmentMode).toBe("instant");
      expect(Number(agent.price)).toBeGreaterThan(0);
    }
  });

  it("declares the local stack endpoints used by pnpm stack:up", () => {
    const { stack, marketplace } = buildSmokeFixture();
    expect(stack.webPort).toBe(3000);
    expect(stack.mockStellarPort).toBe(4010);
    expect(stack.marketplacePath).toBe("/api/services");
    expect(stack.health.path).toBe("/api/health");
    expect(marketplace.defaultLimit).toBeLessThanOrEqual(marketplace.maxLimit);
  });

  it("committed fixture passes validation", () => {
    const committed = JSON.parse(readFileSync(fixturePath, "utf8"));
    expect(validateSmokeFixture(committed)).toEqual({ ok: true, errors: [] });
  });
});

// ─── Determinism / regression ────────────────────────────────────────────────

describe("smoke fixture: determinism and regression", () => {
  it("produces byte-identical output across repeated builds", () => {
    const first = canonicalize(buildSmokeFixture());
    const second = canonicalize(buildSmokeFixture());
    expect(first).toBe(second);
  });

  it("committed fixture is canonical and drift-free", () => {
    const expected = canonicalize(buildSmokeFixture());
    const actual = readFileSync(fixturePath, "utf8");
    expect(findDrift(expected, actual)).toBeNull();
    expect(actual.endsWith("\n")).toBe(true);
  });

  it("detects drift when the committed fixture is not canonical", () => {
    const fixture = buildSmokeFixture();
    const reformatted = `${JSON.stringify(fixture, null, 4)}\n`;
    expect(findDrift(canonicalize(fixture), reformatted)).toMatch(/canonically formatted/);
  });

  it("detects content drift", () => {
    const fixture = buildSmokeFixture();
    const mutated = JSON.parse(canonicalize(fixture));
    mutated.agents[0].name = "renamed-agent";
    expect(findDrift(canonicalize(fixture), canonicalize(mutated))).toMatch(/differs/);
  });

  it("reports unreadable content as drift without echoing it", () => {
    const fixture = buildSmokeFixture();
    const drift = findDrift(canonicalize(fixture), null);
    expect(drift).toMatch(/unreadable/);
  });

  it("derives stable ids from names", () => {
    expect(deriveDeterministicId("smoke-signal")).toBe(deriveDeterministicId("smoke-signal"));
    expect(deriveDeterministicId("smoke-signal")).not.toBe(deriveDeterministicId("smoke-scout"));
  });
});

// ─── Negatives: missing / malformed / ambiguous / duplicates ─────────────────

describe("smoke fixture: negative (fail closed)", () => {
  it("rejects non-object fixtures", () => {
    for (const bad of [null, "fixture", 42, []]) {
      expect(validateSmokeFixture(bad).ok).toBe(false);
    }
  });

  it("rejects unknown top-level and nested fields", () => {
    const fixture = buildSmokeFixture();
    (fixture as Record<string, unknown>).extraField = true;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('unknown field "extraField"');
  });

  it("rejects missing required fields", () => {
    const fixture = buildSmokeFixture();
    const meta = fixture.meta as Partial<typeof fixture.meta>;
    delete meta.name;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('missing required field "name"');
  });

  it("rejects malformed agent payloads", () => {
    const fixture = buildSmokeFixture();
    fixture.agents[0].id = "not-a-fixture-id";
    fixture.agents[0].serviceName = "Bad Service Name!";
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("fixture.agents[0].id");
    expect(joined).toContain("fixture.agents[0].serviceName");
  });

  it("rejects malformed price formats", () => {
    const fixture = buildSmokeFixture();
    for (const badPrice of ["1", "0.1.2", ".5", "1.", "abc", ""]) {
      fixture.agents[0].price = badPrice;
      expect(validateSmokeFixture(fixture).ok).toBe(false);
    }
  });

  it("rejects non-positive prices (ambiguous money)", () => {
    const fixture = buildSmokeFixture();
    fixture.agents[0].price = "0.00";
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("greater than zero");
  });

  it("rejects non-deterministic meta (ambiguous fixture)", () => {
    const fixture = buildSmokeFixture();
    fixture.meta.deterministic = false;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("deterministic");
  });

  it("rejects wrong schema version", () => {
    const fixture = buildSmokeFixture();
    fixture.meta.schemaVersion = SMOKE_FIXTURE_SCHEMA_VERSION + 1;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("schemaVersion");
  });

  it("rejects duplicate agent identity (id, name, onChainId, serviceName)", () => {
    const fixture = buildSmokeFixture();
    fixture.agents.push({ ...fixture.agents[0] });
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    const joined = result.errors.join("\n");
    expect(joined).toContain("duplicate agent id");
    expect(joined).toContain("duplicate agent name");
    expect(joined).toContain("duplicate on-chain id");
    expect(joined).toContain("duplicate service name");
  });

  it("rejects an empty agents array", () => {
    const fixture = buildSmokeFixture();
    fixture.agents = [];
    expect(validateSmokeFixture(fixture).ok).toBe(false);
  });
});

// ─── Boundaries ──────────────────────────────────────────────────────────────

describe("smoke fixture: boundaries", () => {
  it("accepts the inclusive boundary values", () => {
    const fixture = buildSmokeFixture();
    fixture.agents[0].onChainId = 1;
    fixture.stack.webPort = 1;
    fixture.stack.mockStellarPort = 65535;
    fixture.marketplace.defaultLimit = fixture.marketplace.maxLimit;
    expect(validateSmokeFixture(fixture).ok).toBe(true);
  });

  it("rejects out-of-range ports and ids", () => {
    const fixture = buildSmokeFixture();

    fixture.stack.webPort = 0;
    expect(validateSmokeFixture(fixture).ok).toBe(false);

    fixture.stack.webPort = 65536;
    expect(validateSmokeFixture(fixture).ok).toBe(false);

    fixture.stack.webPort = 3000;
    fixture.agents[0].onChainId = 0;
    expect(validateSmokeFixture(fixture).ok).toBe(false);
  });

  it("rejects non-integer numbers", () => {
    const fixture = buildSmokeFixture();
    fixture.stack.webPort = 3000.5;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("must be an integer");
  });

  it("rejects marketplace limits above the max or inverted", () => {
    const fixture = buildSmokeFixture();
    fixture.marketplace.maxLimit = 101;
    expect(validateSmokeFixture(fixture).ok).toBe(false);

    fixture.marketplace.defaultLimit = 100;
    fixture.marketplace.maxLimit = 50;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("less than or equal to maxLimit");
  });

  it("rejects agent arrays beyond the size cap", () => {
    const fixture = buildSmokeFixture();
    const template = fixture.agents[0];
    fixture.agents = Array.from({ length: 65 }, (_, i) => ({
      ...template,
      id: deriveDeterministicId(`agent-${i}`),
      name: `agent-${i}`,
      onChainId: i + 1,
      serviceName: `service_${i}`,
    }));
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("at most 64");
  });

  it("rejects chains that are not exactly stellar", () => {
    const fixture = buildSmokeFixture();
    fixture.agents[0].chains = [];
    expect(validateSmokeFixture(fixture).ok).toBe(false);

    fixture.agents[0].chains = ["ethereum"];
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain('only "stellar"');
  });
});

// ─── Privacy safety ──────────────────────────────────────────────────────────

describe("smoke fixture: privacy safety", () => {
  it("rejects secret-shaped field names and never echoes values", () => {
    const fixture = buildSmokeFixture();
    const sensitiveValue = "SUPER-SECRET-VALUE-THAT-MUST-NOT-LEAK";
    const agent = fixture.agents[0] as unknown as Record<string, unknown>;
    agent.operatorSecretKey = sensitiveValue;
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result.errors);
    expect(serialized).toContain("sensitive field names are not allowed");
    expect(serialized).not.toContain(sensitiveValue);
  });

  it("rejects nested secret-shaped field names anywhere in the tree", () => {
    const fixture = buildSmokeFixture();
    const meta = fixture.meta as unknown as Record<string, unknown>;
    meta.paymentProof = "x";
    const result = validateSmokeFixture(fixture);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("fixture.meta.paymentProof");
  });

  it("committed fixture contains no secret-shaped keys", () => {
    const committed = JSON.parse(readFileSync(fixturePath, "utf8"));
    const keys: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (node === null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        keys.push(`${path}.${k}`);
        walk(v, `${path}.${k}`);
      }
    };
    walk(committed, "fixture");
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/(secret|seed|private|password|passphrase|mnemonic|token|api[_-]?key|credential|proof)/i);
    }
  });

  it("hash primitives only see synthetic names", () => {
    const fixture = buildSmokeFixture();
    for (const agent of fixture.agents) {
      expect(agent.creatorAddress).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
      expect(fnv1a32(agent.name)).toBeTypeOf("number");
    }
    expect(deriveTruncatedAddress("smoke-signal")).toMatch(/^0x[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/);
  });
});

// ─── fnv1a32 edge cases ──────────────────────────────────────────────────────

describe("fnv1a32", () => {
  it("is deterministic for the same input", () => {
    expect(fnv1a32("talos")).toBe(fnv1a32("talos"));
  });

  it("produces unsigned 32-bit values", () => {
    const hash = fnv1a32("talos");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  it("throws on non-string input (fail closed)", () => {
    expect(() => fnv1a32(123 as unknown as string)).toThrow(/expects a string/);
    expect(() => fnv1a32(null as unknown as string)).toThrow(TypeError);
  });
});
