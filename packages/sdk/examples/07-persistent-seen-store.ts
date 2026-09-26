/**
 * Example 07 — Persistent SeenStore (SQLite-backed duplicate suppression)
 *
 * The built-in {@link InMemorySeenStore} loses state on process restart —
 * a restarted agent will re-process events it already handled.  This example
 * shows how to replace it with {@link SqliteSeenStore}, which writes each
 * seen event ID to a local SQLite file so deduplication survives crashes and
 * deploys.
 *
 * ## Compatibility
 *
 * Node.js ≥22 uses the built-in `node:sqlite` module (zero extra deps).
 * Node.js 18/20 requires `better-sqlite3` to be installed:
 *
 *   npm install better-sqlite3
 *   # or: pnpm add better-sqlite3
 *
 * Browser environments should continue using {@link InMemorySeenStore}.
 *
 * ## What this example does
 *
 * 1. Opens (or creates) a SQLite database at `./state/seen-events.db`.
 * 2. Prunes entries older than 30 days to keep the file small.
 * 3. Attaches the store to a TalosEventStream so events are deduplicated
 *    across process restarts.
 * 4. Demonstrates the boundary, retry, and failure behaviours described in
 *    the issue specification:
 *    - Missing / empty IDs are not stored (the stream never calls add() for
 *      events with no id field).
 *    - Malformed adapters throw a typed SqliteSeenStoreError.
 *    - Retried event IDs are silently skipped.
 *
 * ## Expected output
 *
 *   ✓ Opened SQLite SeenStore  rows=0
 *   ✓ Pruned old rows  deleted=(rows older than 30 days)
 *   ✓ has(unknown-id) = false
 *   ✓ add(evt-001)
 *   ✓ has(evt-001) = true  (duplicate suppressed)
 *   ✓ has(evt-002) = false  (new event passes through)
 *   ✓ add(same-id) is idempotent
 *   ✓ SqliteSeenStore attached to TalosEventStream
 *   (stream will reconnect on server close — Ctrl-C to exit)
 *
 * ## Environment variables
 *
 *   TALOS_API_KEY   — required; operator API key
 *   TALOS_API_URL   — optional; defaults to https://talos-stellar.vercel.app
 *   TALOS_AGENT_ID  — required; the agent's talosId for the event stream path
 *   SEEN_DB_PATH    — optional; defaults to ./state/seen-events.db
 */

import { TalosEventStream, InMemorySeenStore } from "../src/events.js";
import {
  SqliteSeenStore,
  SqliteSeenStoreError,
} from "../src/seen-store-sqlite.js";
import type { TalosStreamEvent } from "../src/events.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.TALOS_API_KEY ?? "";
const API_URL =
  process.env.TALOS_API_URL ?? "https://talos-stellar.vercel.app";
const SEEN_DB_PATH = process.env.SEEN_DB_PATH ?? "./state/seen-events.db";

if (!API_KEY) {
  console.error("ERROR: TALOS_API_KEY environment variable is required.");
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(label: string, extra: Record<string, unknown> = {}) {
  const pairs = Object.entries(extra)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("  ");
  console.log(`✓ ${label}${pairs ? "  " + pairs : ""}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // ── Step 1: Open (or create) the persistent store ──────────────────────────
  let seenStore: SqliteSeenStore;

  try {
    seenStore = await SqliteSeenStore.open(SEEN_DB_PATH, { maxAgeDays: 30 });
  } catch (err) {
    if (err instanceof SqliteSeenStoreError) {
      if (err.code === "ADAPTER_UNAVAILABLE") {
        console.warn(
          "No SQLite adapter available.  Falling back to InMemorySeenStore.",
        );
        console.warn(
          "Install better-sqlite3 (Node 18/20) or upgrade to Node ≥22 for persistence.",
        );
        // Graceful fallback — in-memory dedup is better than nothing.
        const memStore = new InMemorySeenStore();
        runStream(memStore as unknown as SqliteSeenStore);
        return;
      }
      console.error("Failed to open SQLite SeenStore:", err.message);
      process.exit(1);
    }
    throw err;
  }

  log("Opened SQLite SeenStore", { rows: seenStore.size() });

  // ── Step 2: Prune stale entries ────────────────────────────────────────────
  seenStore.prune();
  log("Pruned old rows");

  // ── Step 3: Demonstrate the store contract ─────────────────────────────────

  // has() returns false for unknown IDs
  const unknown = await Promise.resolve(seenStore.has("unknown-id-xyz"));
  log("has(unknown-id) = false", { result: unknown });
  console.assert(unknown === false, "Expected false for unknown id");

  // add() records an ID
  seenStore.add("evt-001");
  log("add(evt-001)");

  // has() returns true after add()
  const seen = await Promise.resolve(seenStore.has("evt-001"));
  log("has(evt-001) = true  (duplicate suppressed)", { result: seen });
  console.assert(seen === true, "Expected true after add()");

  // has() returns false for a different ID
  const notSeen = await Promise.resolve(seenStore.has("evt-002"));
  log("has(evt-002) = false  (new event passes through)", { result: notSeen });
  console.assert(notSeen === false, "Expected false for different id");

  // add() is idempotent — calling it twice is safe (INSERT OR IGNORE)
  seenStore.add("evt-001");
  seenStore.add("evt-001");
  const stillSeen = await Promise.resolve(seenStore.has("evt-001"));
  console.assert(stillSeen === true, "Idempotent add should keep id as seen");
  log("add(same-id) is idempotent");

  // ── Step 4: Attach to TalosEventStream ────────────────────────────────────
  runStream(seenStore);
}

function runStream(seenStore: SqliteSeenStore) {
  log("SqliteSeenStore attached to TalosEventStream");

  const stream = new TalosEventStream(API_URL, {
    authHeader: `Bearer ${API_KEY}`,
    seenStore,
    logger: {
      info: (event, ctx) => console.log(`[sse] ${event}`, ctx),
      warn: (event, ctx) => console.warn(`[sse:warn] ${event}`, ctx),
      error: (event, ctx) => console.error(`[sse:error] ${event}`, ctx),
    },
    maxReconnectAttempts: 5,
  });

  stream.on("event", (evt: TalosStreamEvent) => {
    console.log(`[event] type=${evt.type}  id=${evt.id ?? "(none)"}  data=${evt.data.slice(0, 80)}`);
  });

  stream.on("error", (err: unknown, attempt: number) => {
    console.error(`[stream error] attempt=${attempt}`, err);
  });

  stream.on("close", () => {
    console.log("[stream closed]");
    // In a real agent you might call seenStore.close() here.
  });

  stream.connect();
  console.log(
    "(stream will reconnect on server close — press Ctrl-C to exit)",
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
