/**
 * Distributed rate-limit store.
 *
 * Provides a pluggable backend for the rate limiter:
 *   - RedisRateLimitStore  — atomic, shared across all instances (production)
 *   - MemoryRateLimitStore — process-local fallback (dev / test / Redis down)
 *
 * The Redis implementation uses a single INCR + PEXPIREAT pipeline per
 * request, which is both atomic and O(1). The key expires automatically so
 * no background pruning is required.
 *
 * Fail-open semantics: if the Redis connection is not available (REDIS_URL
 * unset, connection refused, or any other error) the store silently falls
 * back to the in-process memory store. This prevents a Redis outage from
 * blocking all traffic. Set RATE_LIMIT_FAIL_CLOSED=true to invert this and
 * deny requests when Redis is unreachable.
 */

import { createConnection } from "net";
import { logger } from "@/lib/logger";
import {
  DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
  isValidResetAt,
} from "@/lib/retry-after";

// ─── Operation Classes & Grace Policy ──────────────────────────────
export type OperationClass = "standard" | "payment" | "privileged" | "read";

export interface RateLimitStoreIncrementOptions {
  operationClass?: OperationClass;
  graceTtlMs?: number;
}

export const DEFAULT_RATE_LIMIT_GRACE_TTL_MS = 60_000;

// ─── Interfaces ───────────────────────────────────────────────────

export interface RateLimitStore {
  /**
   * Atomically increment the counter for `key` and return its current value
   * along with the window expiry (Unix ms), or `null` when the reset time is
   * unknown (for example, invalid window duration, missing/unbounded Redis
   * TTL, or fail-closed denial while Redis is unreachable). Creates the key if
   * absent with a TTL of `windowMs`.
   */
  increment(
    key: string,
    windowMs: number,
    options?: RateLimitStoreIncrementOptions,
  ): Promise<{ count: number; resetAt: number }>;
}

// ─── In-memory store (process-local) ─────────────────────────────

interface MemWindow {
  count: number;
  resetAt: number | null;
  expiresAt: number;
}

const memStore = new Map<string, MemWindow>();

// Prune expired windows every 5 minutes to avoid memory growth.
const pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, w] of memStore) {
    if (!Number.isFinite(w.expiresAt) || w.expiresAt < now) memStore.delete(k);
  }
}, 5 * 60 * 1_000);
// Avoid keeping the Node process alive in test environments.
if (pruneInterval.unref) pruneInterval.unref();

export class MemoryRateLimitStore implements RateLimitStore {
  async increment(
    key: string,
    windowMs: number,
    _options?: RateLimitStoreIncrementOptions,
  ): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const validResetAt = resolveWindowResetAt(now, windowMs);
    const expiresAt =
      validResetAt ?? now + DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS * 1_000;

    let win = memStore.get(key);
    if (!win || !Number.isFinite(win.expiresAt) || win.expiresAt < now) {
      win = { count: 1, resetAt: validResetAt, expiresAt };
      memStore.set(key, win);
    } else {
      win.count += 1;
    }
    return { count: win.count, resetAt: win.resetAt };
  }
}

// ─── Redis store ──────────────────────────────────────────────────

/**
 * Minimal inline Redis client — no external dependency.
 *
 * Implements only the commands needed for rate limiting:
 *   INCR key
 *   PEXPIREAT key unixMs
 *   PTTL key
 *
 * Uses pipelining (sends both commands before reading any response) for
 * a single round-trip per increment call.
 */
class MinRedisClient {
  private readonly host: string;
  private readonly port: number;
  private readonly password: string | null;
  private readonly db: number;

  constructor(url: string) {
    const u = new URL(url);
    this.host = u.hostname || "127.0.0.1";
    this.port = Number(u.port) || 6379;
    this.password = u.password ? decodeURIComponent(u.password) : null;
    this.db = u.pathname && u.pathname !== "/" ? parseInt(u.pathname.slice(1), 10) || 0 : 0;
  }

  /**
   * Send a single pipelined request: INCR + PEXPIREAT.
   * Opens a fresh TCP connection per call — connection pooling is intentionally
   * omitted to stay dependency-free and because rate-limit calls are infrequent
   * relative to DB calls.
   *
   * If any error occurs the promise is rejected; the caller falls back to
   * in-memory.
   */
  async incrWithExpire(key: string, expireAtMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let buf = "";
      let resolved = false;

      const cleanup = () => {
        if (!socket.destroyed) socket.destroy();
      };

      socket.setTimeout(2_000);
      socket.setEncoding("utf8");

      socket.on("timeout", () => {
        cleanup();
        reject(new Error("Redis connection timeout"));
      });

      socket.on("error", (err) => {
        cleanup();
        reject(err);
      });

      socket.on("connect", () => {
        // Build RESP commands
        const commands: string[] = [];

        if (this.password) {
          commands.push(resp("AUTH", this.password));
        }
        if (this.db !== 0) {
          commands.push(resp("SELECT", String(this.db)));
        }
        commands.push(resp("INCR", key));
        commands.push(resp("PEXPIREAT", key, String(expireAtMs)));

        socket.write(commands.join(""));
      });

      socket.on("data", (chunk: string) => {
        buf += chunk;

        // Parse enough responses to get the INCR result.
        // We send (optionally) AUTH, SELECT, INCR, PEXPIREAT.
        // We only care about the INCR integer reply.
        const lines = buf.split("\r\n");
        let incrValue: number | null = null;

        for (const line of lines) {
          // Integer reply: :N
          if (line.startsWith(":")) {
            const n = parseInt(line.slice(1), 10);
            if (!isNaN(n) && incrValue === null) {
              // AUTH/SELECT return +OK (simple string), so the first integer
              // reply we see is the INCR result.
              incrValue = n;
            }
          }
          // Error reply
          if (line.startsWith("-")) {
            cleanup();
            if (!resolved) {
              resolved = true;
              reject(new Error(`Redis error: ${line.slice(1)}`));
            }
            return;
          }
        }

        if (incrValue !== null && !resolved) {
          resolved = true;
          cleanup();
          resolve(incrValue);
        }
      });
    });
  }

  async pttl(key: string): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let buf = "";
      let resolved = false;

      const cleanup = () => { if (!socket.destroyed) socket.destroy(); };

      socket.setTimeout(2_000);
      socket.setEncoding("utf8");
      socket.on("timeout", () => { cleanup(); reject(new Error("Redis timeout")); });
      socket.on("error", (err) => { cleanup(); reject(err); });

      socket.on("connect", () => {
        const cmds: string[] = [];
        if (this.password) cmds.push(resp("AUTH", this.password));
        if (this.db !== 0) cmds.push(resp("SELECT", String(this.db)));
        cmds.push(resp("PTTL", key));
        socket.write(cmds.join(""));
      });

      socket.on("data", (chunk: string) => {
        buf += chunk;
        for (const line of buf.split("\r\n")) {
          if (line.startsWith(":")) {
            const n = parseInt(line.slice(1), 10);
            if (!isNaN(n) && !resolved) {
              resolved = true;
              cleanup();
              resolve(n);
            }
          }
          if (line.startsWith("-") && !resolved) {
            resolved = true;
            cleanup();
            reject(new Error(`Redis error: ${line.slice(1)}`));
          }
        }
      });
    });
  }
}

/** Serialize a Redis command in RESP format. */
function resp(...args: string[]): string {
  const parts: string[] = [`*${args.length}\r\n`];
  for (const a of args) {
    parts.push(`$${Buffer.byteLength(a, "utf8")}\r\n${a}\r\n`);
  }
  return parts.join("");
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: MinRedisClient;
  private readonly fallback: MemoryRateLimitStore;
  private readonly failClosed: boolean;
  private readonly defaultGraceTtlMs: number;
  private outageStartTime: number | null = null;
  private consecutiveFailures = 0;

  constructor(
    redisUrl: string,
    failClosed = false,
    defaultGraceTtlMs = DEFAULT_RATE_LIMIT_GRACE_TTL_MS,
  ) {
    this.client = new MinRedisClient(redisUrl);
    this.fallback = new MemoryRateLimitStore();
    this.failClosed = failClosed;
    this.defaultGraceTtlMs = defaultGraceTtlMs;
  }

  /** Read current outage status for telemetry / diagnostics. */
  getOutageStatus(): { isOutage: boolean; outageDurationMs: number; consecutiveFailures: number } {
    const isOutage = this.consecutiveFailures > 0;
    const outageDurationMs = this.outageStartTime ? Date.now() - this.outageStartTime : 0;
    return { isOutage, outageDurationMs, consecutiveFailures: this.consecutiveFailures };
  }

  /** Reset outage tracking state (e.g. for testing). */
  resetOutage(): void {
    this.outageStartTime = null;
    this.consecutiveFailures = 0;
  }

  async increment(
    key: string,
    windowMs: number,
    options?: RateLimitStoreIncrementOptions,
  ): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const resetAt = now + windowMs;
    const opClass: OperationClass = options?.operationClass ?? "standard";
    const graceTtlMs = options?.graceTtlMs ?? this.defaultGraceTtlMs;

    try {
      const count = await this.client.incrWithExpire(key, expireAtMs);

      // On healthy response, clear any active outage tracking
      if (this.outageStartTime !== null || this.consecutiveFailures > 0) {
        logger.info(
          { key, previousFailures: this.consecutiveFailures },
          "rate-limit: Redis connection recovered from outage",
        );
        this.outageStartTime = null;
        this.consecutiveFailures = 0;
      }

      // On the first increment the key is brand-new; the PEXPIREAT sets TTL.
      // On subsequent increments the TTL is already set; we need to read the
      // actual expiry to return a consistent resetAt.
      if (count === 1) {
        // First request in this window — validResetAt is accurate (or null if windowMs invalid).
        return { count, resetAt: validResetAt };
      }

      // For count > 1 the key already existed. Derive resetAt from PTTL.
      let ttlMs: number;
      try {
        ttlMs = await this.client.pttl(key);
      } catch {
        // PTTL failed — reset time is unknown rather than guessing a misleading timestamp.
        return { count, resetAt: null };
      }

      if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs <= 0) {
        // Negative PTTL (-1 persistent key, -2 missing key) or zero/non-finite means unknown reset.
        return { count, resetAt: null };
      }

      const derivedResetAt = Date.now() + ttlMs;
      return {
        count,
        resetAt: isValidResetAt(derivedResetAt) ? derivedResetAt : null,
      };
    } catch (err) {
      if (this.outageStartTime === null) {
        this.outageStartTime = Date.now();
      }
      this.consecutiveFailures += 1;
      const outageDurationMs = Date.now() - this.outageStartTime;

      logger.warn(
        {
          err,
          key,
          opClass,
          outageDurationMs,
          consecutiveFailures: this.consecutiveFailures,
        },
        "rate-limit: Redis unavailable, evaluating bounded grace outage policy",
      );

      // Payment and privileged paths MUST fail closed during verified outages
      if (opClass === "payment" || opClass === "privileged") {
        logger.error(
          { key, opClass, outageDurationMs },
          "rate-limit: fail-closed enforced for payment/privileged operation during store outage",
        );
        return { count: Number.MAX_SAFE_INTEGER, resetAt };
      }

      // If global strict failClosed is configured, fail closed for all paths
      if (this.failClosed) {
        return { count: Number.MAX_SAFE_INTEGER, resetAt };
      }

      // Bounded grace window check: if outage duration exceeds graceTtlMs, fail closed
      if (outageDurationMs > graceTtlMs) {
        logger.error(
          { key, opClass, outageDurationMs, graceTtlMs },
          "rate-limit: outage exceeded bounded grace period, failing closed",
        );
        return { count: Number.MAX_SAFE_INTEGER, resetAt };
      }

      // Within bounded grace period: fallback to memory store for standard / read operations
      return this.fallback.increment(key, windowMs, options);
    }
  }
}

// ─── Singleton store ──────────────────────────────────────────────

let _store: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (_store) return _store;

  const redisUrl = process.env.REDIS_URL;
  const failClosed = process.env.RATE_LIMIT_FAIL_CLOSED === "true";
  const graceTtlMs = process.env.RATE_LIMIT_GRACE_TTL_MS
    ? parseInt(process.env.RATE_LIMIT_GRACE_TTL_MS, 10) || DEFAULT_RATE_LIMIT_GRACE_TTL_MS
    : DEFAULT_RATE_LIMIT_GRACE_TTL_MS;

  if (redisUrl) {
    logger.info("rate-limit: using Redis distributed store");
    _store = new RedisRateLimitStore(redisUrl, failClosed, graceTtlMs);
  } else {
    logger.info("rate-limit: REDIS_URL not set — using in-process memory store");
    _store = new MemoryRateLimitStore();
  }

  return _store;
}

/** Reset the singleton — used in tests only. */
export function _resetRateLimitStore(): void {
  _store = null;
}
