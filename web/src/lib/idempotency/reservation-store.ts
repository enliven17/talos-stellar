/**
 * General-purpose idempotency reservation store.
 *
 * Complements the cleanup store (store.ts) which handles commerce-job key
 * expiry. This module provides a cross-cutting reserve/complete/release
 * primitive backed by tls_idempotency_keys — usable from token purchases,
 * service purchases, and any other operation that needs request
 * deduplication without coupling to a specific domain table.
 *
 * State machine
 * ─────────────
 *
 *   (none)  ──reserve──▶  reserved  ──complete──▶  completed
 *                                ╰──── expire ────▶  (deleted + re-reservable)
 *             expired ──reserve──▶  reserved
 *
 * reserve(key, payloadHash, ttlMs?)
 *   → { status: "ok" }             key was free (or expired) — caller may proceed
 *   → { status: "conflict" }       key is reserved by another in-flight request
 *   → { status: "replay", result } key is completed — return stored result
 *   → { status: "hash_mismatch" }  same key, different payload — hard reject
 *
 * complete(key, result)   reserved → completed, stores result for replays
 * release(key)            reserved → (deleted) on failure so the caller can retry
 * purgeExpired()          bulk delete for the cleanup job (out-of-band)
 */

import { createHash } from "node:crypto";
import { eq, and, lt } from "drizzle-orm";
import { db as defaultDb } from "@/db";
import { tlsIdempotencyKeys } from "@/db/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IdempotencyStatus =
  | { status: "ok" }
  | { status: "conflict" }
  | { status: "replay"; result: unknown }
  | { status: "hash_mismatch" };

type Db = typeof defaultDb;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stable SHA-256 fingerprint of an arbitrary JSON-serialisable payload. */
export function hashPayload(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

// ─── Core operations ──────────────────────────────────────────────────────────

/**
 * Attempt to reserve an idempotency key before executing a side-effectful
 * operation. Returns the status the caller should act on.
 */
export async function reserve(
  key: string,
  payloadHash: string,
  ttlMs = 24 * 60 * 60 * 1000,
  tx: Db = defaultDb,
): Promise<IdempotencyStatus> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const [existing] = await tx
    .select()
    .from(tlsIdempotencyKeys)
    .where(eq(tlsIdempotencyKeys.key, key))
    .limit(1);

  if (!existing) {
    await tx.insert(tlsIdempotencyKeys).values({
      key,
      payloadHash,
      status: "reserved",
      expiresAt,
    });
    return { status: "ok" };
  }

  // Expired — treat as free: replace with a fresh reservation.
  if (existing.expiresAt < now) {
    await tx.delete(tlsIdempotencyKeys).where(eq(tlsIdempotencyKeys.key, key));
    await tx.insert(tlsIdempotencyKeys).values({
      key,
      payloadHash,
      status: "reserved",
      expiresAt,
    });
    return { status: "ok" };
  }

  // Hash mismatch takes priority — prevents key hijacking regardless of status.
  if (existing.payloadHash !== payloadHash) {
    return { status: "hash_mismatch" };
  }

  if (existing.status === "completed") {
    return { status: "replay", result: existing.result };
  }

  // status === "reserved" — another request is in-flight.
  return { status: "conflict" };
}

/**
 * Mark a reserved key as completed and persist the result for replay.
 * Safe to call on an already-completed key (no-op due to WHERE clause).
 */
export async function complete(
  key: string,
  result: unknown,
  tx: Db = defaultDb,
): Promise<void> {
  await tx
    .update(tlsIdempotencyKeys)
    .set({ status: "completed", result, updatedAt: new Date() })
    .where(
      and(
        eq(tlsIdempotencyKeys.key, key),
        eq(tlsIdempotencyKeys.status, "reserved"),
      ),
    );
}

/**
 * Delete a reserved key on failure so the caller can retry with the same key.
 */
export async function release(key: string, tx: Db = defaultDb): Promise<void> {
  await tx
    .delete(tlsIdempotencyKeys)
    .where(
      and(
        eq(tlsIdempotencyKeys.key, key),
        eq(tlsIdempotencyKeys.status, "reserved"),
      ),
    );
}

/**
 * Delete all expired rows. Called by the scheduled cleanup job — not in the
 * hot path.
 */
export async function purgeExpired(tx: Db = defaultDb): Promise<void> {
  await tx
    .delete(tlsIdempotencyKeys)
    .where(lt(tlsIdempotencyKeys.expiresAt, new Date()));
}
