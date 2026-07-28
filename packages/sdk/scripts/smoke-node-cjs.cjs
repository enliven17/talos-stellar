#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Node CJS smoke test.
 *
 * `require()`'s the built CommonJS bundle from `dist/cjs/index.cjs` (or, if
 * only the .js variant was emitted, it falls back to loading .js). Then
 * asserts that the same set of exported names and methods work from CJS as
 * from ESM, confirming the dual-module build.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");

const SDK_ROOT = path.resolve(__dirname, "..");
const CJS_DIR = path.join(SDK_ROOT, "dist", "cjs");

function resolveCjsEntry() {
  const candidates = [
    path.join(CJS_DIR, "index.cjs"),
    path.join(CJS_DIR, "index.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`No CJS entry found. Tried ${candidates.join(", ")}`);
}

const entry = resolveCjsEntry();
console.log("[compat:node-cjs] requiring from:", entry);
const sdk = require(entry);

console.log(
  "[compat:node-cjs] exports:",
  Object.keys(sdk).sort().join(", "),
);

const requiredClasses = [
  "TalosClient",
  "TalosAPIError",
  "TalosEventStream",
  "TalosStreamError",
  "InMemorySeenStore",
  "TalosWebhook",
  "TalosWebhookError",
  "ChaosInjector",
  "ChaosInjectedError",
  "globalChaosInjector",
];
for (const name of requiredClasses) {
  assert.ok(name in sdk, `expected export "${name}" missing in CJS bundle`);
  console.log("  + " + name + " is exported");
}

assert.ok("FaultType" in sdk, "FaultType enum missing in CJS bundle");
console.log(
  "  + FaultType keys=" + Object.keys(sdk.FaultType).join(","),
);

const client = new sdk.TalosClient({
  baseUrl: "http://example.test",
  apiKey: "cjs-test",
});
assert.equal(typeof client.getTalos, "function");
assert.equal(typeof client.listTaloses, "function");
assert.equal(typeof client.createTalos, "function");
assert.equal(typeof client.purchaseServiceWithPayment, "function");
console.log("  + TalosClient constructor + method check OK");

const chaos = new sdk.ChaosInjector({ enabled: false });
chaos.registerFault({
  type: sdk.FaultType.DB_CONNECTION_FAIL,
  probability: 0.75,
});
assert.equal(chaos.isEnabled(), false);
assert.equal(chaos.hasFault(sdk.FaultType.DB_CONNECTION_FAIL), true);
console.log("  + ChaosInjector instantiation & registration OK");

assert.equal(typeof sdk.generateKeypair, "function");
assert.equal(typeof sdk.isValidPublicKey, "function");
const kp = sdk.generateKeypair();
assert.equal(sdk.isValidPublicKey(kp.publicKey), true);
assert.equal(sdk.isValidSecretKey(kp.secret), true);
console.log("  + stellar keypair helpers OK (pub=%s)", kp.publicKey.slice(0, 8) + "...");

assert.equal(typeof sdk.TalosWebhook.verify, "function");
assert.equal(typeof sdk.TalosWebhook.parseSignatureHeader, "function");
console.log("  + TalosWebhook static methods present");

const stream = new sdk.TalosEventStream("http://example.test", {
  maxReconnectAttempts: 0,
});
assert.equal(stream.connectionState, "idle");
stream.close();
console.log("  + TalosEventStream instantiation OK");

console.log("[compat:node-cjs] ALL CHECKS PASSED");
process.exit(0);
