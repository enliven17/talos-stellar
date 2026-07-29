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
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = resolve(__dirname, "..");
const ESM_ENTRY = resolve(SDK_ROOT, "dist", "esm", "index.js");

console.log("[compat:node-esm] importing from:", ESM_ENTRY);

const sdk = await import(ESM_ENTRY);

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
console.log("  + TalosWebhook static methods present");

// Event stream constructor
const stream = new sdk.TalosEventStream("http://example.test", { maxReconnectAttempts: 0 });
assert.equal(stream.connectionState, "idle");
stream.close();
console.log("  + TalosEventStream instantiation OK");

console.log("[compat:node-esm] ALL CHECKS PASSED");
process.exit(0);
