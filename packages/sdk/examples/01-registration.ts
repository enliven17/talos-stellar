/**
 * Example 01 — Talos Registration
 *
 * Demonstrates the full creation lifecycle:
 *   1. Instantiate the SDK client from environment variables.
 *   2. Create a new Talos agent with all configurable fields.
 *   3. Persist the one-time API key safely.
 *   4. Retrieve the created record to confirm round-trip consistency.
 *
 * Expected output (values vary per run):
 *   ✓ Talos created  id=<uuid>  name=ExampleBot
 *   ✓ API key received (store securely — shown once)
 *   ✓ Fetched talos  id=<uuid>  status=active
 *
 * Environment variables required:
 *   TALOS_API_KEY   — operator API key
 *   TALOS_API_URL   — optional; defaults to https://talos-stellar.vercel.app
 *
 * Safe testnet usage:
 *   Set TALOS_API_URL to a local dev server or staging URL to avoid creating
 *   real on-chain records on mainnet.
 */

import { TalosClient, TalosAPIError } from "../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL = process.env.TALOS_API_URL; // undefined → SDK default

if (!API_KEY) {
  console.error("ERROR: TALOS_API_KEY environment variable is required.");
  process.exit(1);
}

// ── Client ────────────────────────────────────────────────────────────────────

const client = new TalosClient({ apiKey: API_KEY, baseUrl: API_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(label: string, data: Record<string, unknown>) {
  const pairs = Object.entries(data)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("  ");
  console.log(`✓ ${label}  ${pairs}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Step 1: Create Talos
  const created = await client.createTalos({
    name: "ExampleBot",
    category: "Marketing",
    description: "Autonomous marketing agent for the Talos protocol examples.",
    totalSupply: 1_000_000,
    initialPrice: 0.10,
    approvalThreshold: 500,
    gtmBudget: 5_000,
    minPatronPulse: 100,
    persona: "Friendly, data-driven growth hacker",
    targetAudience: "DeFi enthusiasts on Stellar",
    channels: ["X", "Telegram"],
    toneVoice: "concise and informative",
    tokenSymbol: "EBOT",
  });

  log("Talos created", { id: created.id, name: created.name });

  // Step 2: Persist API key (shown once — in a real workflow store this in a secrets manager)
  log("API key received (store securely — shown once)", {
    apiKey: created.apiKeyOnce.slice(0, 8) + "...",
  });

  // Step 3: Verify round-trip by fetching the full record
  const fetched = await client.getTalos(created.id);
  log("Fetched talos", { id: fetched.id, status: fetched.status });

  // Step 4: Confirm field consistency
  if (fetched.name !== created.name) {
    throw new Error(`Name mismatch: expected "${created.name}", got "${fetched.name}"`);
  }
  console.log("✓ Field consistency verified");
}

main().catch((err) => {
  if (err instanceof TalosAPIError) {
    console.error(`API error ${err.status} on ${err.path}:`, err.body);
  } else {
    console.error("Unexpected error:", err);
  }
  process.exit(1);
});
