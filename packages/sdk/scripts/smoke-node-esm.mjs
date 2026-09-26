#!/usr/bin/env node
/**
 * Node ESM smoke test.
 *
 * Dynamically imports the built ESM entry point from `dist/esm/index.js`
 * and asserts that key exports (client classes, chaos types, helpers)
 * are actually present and their names/types are as advertised.
 *
 * This is a runtime import test under real Node.js, not a Vitest bundle —
 * so we exercise Node's native ESM loader end-to-end.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, "..");
const ESM_ENTRY = resolve(SDK_ROOT, "dist", "esm", "index.js");

console.log("[compat:node-esm] importing from:", ESM_ENTRY);

const sdk = await import(pathToFileURL(ESM_ENTRY).href);

const signingExports = ["REQUEST_SIGNATURE_VERSION", "canonicalizeRequest", "SigningController", "SigningError", "StellarKeypairSigner"];
for (const name of signingExports) assert.ok(name in sdk, `expected signing export "${name}" missing in ESM bundle`);
const signingVectors = JSON.parse(readFileSync(resolve(SDK_ROOT, "tests", "fixtures", "request-signing-vectors.json"), "utf8"));
for (const vector of signingVectors.vectors) {
  const bytes = await sdk.canonicalizeRequest(vector.request);
  assert.deepEqual(Array.from(bytes), Array.from(new TextEncoder().encode(vector.canonical)), `signing vector ${vector.name}`);
}

console.log("[compat:node-esm] exports:", Object.keys(sdk).sort().join(", "));

const requiredClasses = ["TalosClient", "TalosAPIError", "TalosEventStream", "TalosStreamError", "InMemorySeenStore", "TalosWebhook", "TalosWebhookError", "ChaosInjector", "ChaosInjectedError", "globalChaosInjector"];
for (const name of requiredClasses) {
  assert.ok(name in sdk, `expected export "${name}" missing in ESM bundle`);
  console.log(`  + ${name} is exported`);
}

const requiredEnumsOrVals = ["FaultType"];
for (const name of requiredEnumsOrVals) {
  assert.ok(name in sdk, `expected export "${name}" missing in ESM bundle`);
  console.log(`  + ${name} is exported with keys=${Object.keys(sdk[name]).join(",")}`);
}

// Instantiate a TalosClient with options — no fetch needed, just ensure the
// constructor runs without throwing under real Node ESM.
const client = new sdk.TalosClient({ baseUrl: "http://example.test", apiKey: "test" });
assert.equal(typeof client.getTalos, "function", "client.getTalos must be callable");
assert.equal(typeof client.listTaloses, "function", "client.listTaloses must be callable");
assert.equal(typeof client.createTalos, "function", "client.createTalos must be callable");
assert.equal(typeof client.reportActivity, "function", "client.reportActivity must be callable");
assert.equal(typeof client.reportRevenue, "function", "client.reportRevenue must be callable");
console.log("  + TalosClient constructor + method check OK");

// Chaos: instantiate ChaosInjector, register a fault, confirm types
const chaos = new sdk.ChaosInjector({ enabled: false });
chaos.registerFault({ type: sdk.FaultType.NETWORK_DROP, probability: 0.5 });
assert.equal(chaos.isEnabled(), false);
assert.equal(chaos.hasFault(sdk.FaultType.NETWORK_DROP), true);
console.log("  + ChaosInjector instantiation & registration OK");

// Deterministic chaos fixtures: plan + replay a registered scenario end to end.
assert.ok(Array.isArray(sdk.CHAOS_SCENARIOS) && sdk.CHAOS_SCENARIOS.length > 0, "CHAOS_SCENARIOS missing/empty");
assert.equal(typeof sdk.planChaosScenario, "function", "planChaosScenario missing");
assert.equal(typeof sdk.replayChaosScenario, "function", "replayChaosScenario missing");
assert.equal(typeof sdk.buildChaosFixtureBundle, "function", "buildChaosFixtureBundle missing");
assert.equal(typeof sdk.createSeededRandom, "function", "createSeededRandom missing");
assert.equal(typeof sdk.faultEffect, "function", "faultEffect missing");
{
  const scenario = sdk.getChaosScenario("api-timeout-delay-then-throw");
  assert.ok(scenario, "chaos scenario lookup failed");
  const plan = sdk.planChaosScenario(scenario);
  assert.equal(plan.calls[0].outcome, "injected-delay-then-throw", "chaos plan outcome drifted");
  const replay = await sdk.replayChaosScenario(scenario);
  assert.deepEqual(
    replay.calls.map((c) => c.outcome),
    plan.calls.map((c) => c.outcome),
    "chaos replay diverged from plan",
  );
  // Boundary: malformed fault configs must fail loudly, never register silently.
  assert.throws(
    () => new sdk.ChaosInjector({}).registerFault({ type: "NETWORK_GREMLIN", probability: 0.5 }),
    TypeError,
    "unknown fault type must throw TypeError",
  );
  const seededA = sdk.createSeededRandom(42);
  const seededB = sdk.createSeededRandom(42);
  assert.deepEqual(Array.from({ length: 8 }, seededA), Array.from({ length: 8 }, seededB), "seeded PRNG not deterministic");
  console.log("  + deterministic chaos fixtures (plan/replay/PRNG) OK");
}

// ── Idempotency helpers ──────────────────────────────────────────────────────
{
  const idempotencyExports = [
    "generateIdempotencyKey",
    "validateIdempotencyKey",
    "isUuidV4",
    "isPayloadConflict",
    "IDEMPOTENCY_KEY_MAX_BYTES",
    "IdempotencyConflictError",
    "IdempotencyError",
    "InMemoryIdempotencyStore",
    "createIdempotencyStore",
    "withIdempotency",
  ];
  for (const name of idempotencyExports) {
    assert.ok(name in sdk, `expected idempotency export "${name}" missing in ESM bundle`);
  }

  // generateIdempotencyKey returns a valid UUID v4
  const key = sdk.generateIdempotencyKey();
  assert.equal(typeof key, "string", "generateIdempotencyKey must return a string");
  assert.ok(sdk.isUuidV4(key), `generated key "${key}" is not a valid UUID v4`);

  // validateIdempotencyKey accepts valid keys and rejects empty/oversized ones
  assert.doesNotThrow(() => sdk.validateIdempotencyKey(key), "validateIdempotencyKey should not throw for a valid key");
  assert.throws(
    () => sdk.validateIdempotencyKey(""),
    TypeError,
    "validateIdempotencyKey should throw TypeError for empty string",
  );
  assert.throws(
    () => sdk.validateIdempotencyKey("a".repeat(200)),
    TypeError,
    "validateIdempotencyKey should throw TypeError for oversized key",
  );

  // IDEMPOTENCY_KEY_MAX_BYTES must be 128
  assert.equal(sdk.IDEMPOTENCY_KEY_MAX_BYTES, 128, "IDEMPOTENCY_KEY_MAX_BYTES must be 128");

  // isPayloadConflict: stable wire-format detection
  assert.equal(sdk.isPayloadConflict("different payload"), true, "isPayloadConflict should match 'different payload'");
  assert.equal(sdk.isPayloadConflict("already being processed"), false, "isPayloadConflict should not match in-flight body");

  // IdempotencyConflictError constructor and property shape
  const conflictErr = new sdk.IdempotencyConflictError("test-key", "/api/test", "body");
  assert.equal(conflictErr.name, "IdempotencyConflictError");
  assert.equal(conflictErr.status, 409);
  assert.equal(conflictErr.conflictingKey, "test-key");
  assert.equal(conflictErr.path, "/api/test");
  assert.ok(conflictErr instanceof Error, "IdempotencyConflictError must extend Error");

  // InMemoryIdempotencyStore round-trip
  const store = new sdk.InMemoryIdempotencyStore({ ttlMs: 60_000 });
  const record = { key, response: "test-response", createdAt: Date.now() };
  store.set(key, record);
  assert.deepEqual(store.get(key), record, "InMemoryIdempotencyStore get() should return stored record");
  store.delete(key);
  assert.equal(store.get(key), undefined, "InMemoryIdempotencyStore delete() should remove entry");

  // createIdempotencyStore factory
  const storeFromFactory = sdk.createIdempotencyStore({ ttlMs: 30_000 });
  assert.ok(storeFromFactory instanceof sdk.InMemoryIdempotencyStore, "createIdempotencyStore must return InMemoryIdempotencyStore");

  // withIdempotency: success path
  const result = await sdk.withIdempotency(key, async (k) => `result-${k}`);
  assert.equal(result, `result-${key}`, "withIdempotency should return fn result");

  // withIdempotency: EXHAUSTED error
  const exhaustedKey = sdk.generateIdempotencyKey();
  let exhaustedError = null;
  try {
    await sdk.withIdempotency(
      exhaustedKey,
      async () => {
        const err = new Error("down");
        err.status = 503;
        throw err;
      },
      { maxAttempts: 1, baseDelayMs: 0 },
    );
  } catch (err) {
    exhaustedError = err;
  }
  assert.ok(exhaustedError instanceof sdk.IdempotencyError, "withIdempotency should throw IdempotencyError after exhausting attempts");
  assert.equal(exhaustedError.code, "EXHAUSTED", "error code should be EXHAUSTED");

  console.log("  + idempotency helpers OK (key generation, validation, store, withIdempotency, errors)");
}

// Helpers
assert.equal(typeof sdk.generateKeypair, "function", "generateKeypair not exported");
assert.equal(typeof sdk.isValidPublicKey, "function", "isValidPublicKey not exported");
assert.equal(typeof sdk.isValidSecretKey, "function", "isValidSecretKey not exported");
const kp = sdk.generateKeypair();
assert.equal(sdk.isValidPublicKey(kp.publicKey), true);
assert.equal(sdk.isValidSecretKey(kp.secret), true);
console.log("  + stellar keypair helpers OK (pub=%s)", kp.publicKey.slice(0, 8) + "...");

// Webhook static methods should exist on TalosWebhook
assert.equal(typeof sdk.TalosWebhook.verify, "function", "TalosWebhook.verify missing");
assert.equal(typeof sdk.TalosWebhook.parseSignatureHeader, "function", "TalosWebhook.parseSignatureHeader missing");
assert.equal(typeof sdk.TalosWebhook.timingSafeEqual, "function", "TalosWebhook.timingSafeEqual missing");
assert.equal(typeof sdk.TalosWebhook.hexToBuf, "function", "TalosWebhook.hexToBuf missing");
assert.equal(typeof sdk.TalosWebhook.constructEvent, "function", "TalosWebhook.constructEvent missing");
assert.equal(typeof sdk.verifyWebhook, "function", "verifyWebhook missing");
assert.equal(typeof sdk.parseWebhookEvent, "function", "parseWebhookEvent missing");
console.log("  + TalosWebhook static methods present");

// Typed seller quote construction
assert.equal(typeof sdk.constructSellerQuote, "function", "constructSellerQuote missing");
assert.equal(typeof sdk.constructSellerPaymentDetails, "function", "constructSellerPaymentDetails missing");
assert.equal(typeof sdk.toCanonicalDecimalAmount, "function", "toCanonicalDecimalAmount missing");
assert.equal(typeof sdk.SellerQuoteError, "function", "SellerQuoteError missing");
const sampleQuote = sdk.constructSellerQuote({
  providerId: "G" + "A".repeat(55),
  amount: 1,
  ttlSeconds: 120,
  now: new Date("2099-01-01T00:00:00.000Z"),
});
assert.equal(sampleQuote.amount, "1.000000");
assert.equal(sampleQuote.assetCode, "USDC");
console.log("  + constructSellerQuote helper OK");

// Event stream constructor
const stream = new sdk.TalosEventStream("http://example.test", { maxReconnectAttempts: 0 });
assert.equal(stream.connectionState, "idle");
stream.close();
console.log("  + TalosEventStream instantiation OK");

// Typed contract event decoding
assert.equal(typeof sdk.decodeContractEvent, "function", "decodeContractEvent missing");
assert.equal(typeof sdk.decodeContractEvents, "function", "decodeContractEvents missing");
assert.equal(typeof sdk.isContractEvent, "function", "isContractEvent missing");
assert.equal(typeof sdk.isContractEventFamily, "function", "isContractEventFamily missing");
assert.equal(typeof sdk.compareEventCursors, "function", "compareEventCursors missing");
assert.equal(typeof sdk.ContractEventError, "function", "ContractEventError missing");
assert.equal(typeof sdk.UnknownContractEventError, "function", "UnknownContractEventError missing");
assert.equal(typeof sdk.MalformedContractEventError, "function", "MalformedContractEventError missing");
assert.equal(typeof sdk.UnsupportedContractVersionError, "function", "UnsupportedContractVersionError missing");
assert.ok(sdk.BUILTIN_EVENT_CATALOG, "BUILTIN_EVENT_CATALOG missing");
assert.equal(typeof sdk.CATALOG_SPEC_VERSION, "string", "CATALOG_SPEC_VERSION missing");
const sampleDecoded = sdk.decodeContractEvent({
  contract: "talos_registry",
  topics: [
    { type: "symbol", value: "tls_crt" },
    { type: "address", value: "GDC2TFRPZ3SJJYE2GDOIVHVGU3J7RZ7WCDIGKNZC4OY4CCIY7JK5JGYZ" },
  ],
  data: [
    { type: "u32", value: 1 },
    { type: "string", value: "Genesis" },
    { type: "string", value: "Marketing" },
  ],
  ledger_sequence: 100000,
});
assert.equal(sampleDecoded.event, "tls_crt");
assert.equal(sampleDecoded.family, "creation");
console.log("  + decodeContractEvent check OK");

console.log("[compat:node-esm] ALL CHECKS PASSED");
process.exit(0);
