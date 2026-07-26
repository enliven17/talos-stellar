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

// ─── Interfaces ───────────────────────────────────────────────────

export interface RateLimitStore {
  /**
   * Atomically increment the counter for `key` and return its current value
   * along with the window expiry (Unix ms). Creates the key if absent with a
   * TTL of `windowMs`.
   */
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

// ─── In-memory store (process-local) ─────────────────────────────

interface MemWindow {
  count: number;
  resetAt: number;
}

const memStore = new Map<string, MemWindow>();

// Prune expired windows every 5 minutes to avoid memory growth.
const pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, w] of memStore) {
    if (w.resetAt < now) memStore.delete(k);
  }
}, 5 * 60 * 1_000);
// Avoid keeping the Node process alive in test environments.
if (pruneInterval.unref) pruneInterval.unref();

export class MemoryRateLimitStore implements RateLimitStore {
  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    let win = memStore.get(key);
    if (!win || win.resetAt < now) {
      win = { count: 1, resetAt: now + windowMs };
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

  constructor(redisUrl: string, failClosed = false) {
    this.client = new MinRedisClient(redisUrl);
    this.fallback = new MemoryRateLimitStore();
    this.failClosed = failClosed;
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    const resetAt = now + windowMs;

    try {
      const count = await this.client.incrWithExpire(key, resetAt);

      // On the first increment the key is brand-new; the PEXPIREAT sets TTL.
      // On subsequent increments the TTL is already set; we need to read the
      // actual expiry to return a consistent resetAt.
      if (count === 1) {
        // First request in this window — resetAt is accurate.
        return { count, resetAt };
      }

      // For count > 1 the key already existed. Derive resetAt from PTTL.
      let ttlMs: number;
      try {
        ttlMs = await this.client.pttl(key);
      } catch {
        // If PTTL fails, approximate from our local clock.
        ttlMs = windowMs;
      }
      const derivedResetAt = ttlMs > 0 ? Date.now() + ttlMs : resetAt;
      return { count, resetAt: derivedResetAt };
    } catch (err) {
      logger.warn({ err, key }, "rate-limit: Redis unavailable, falling back to memory store");

      if (this.failClosed) {
        // Deny all traffic when Redis is down (strict mode).
        return { count: Number.MAX_SAFE_INTEGER, resetAt };
      }

      return this.fallback.increment(key, windowMs);
    }
  }
}

// ─── Singleton store ──────────────────────────────────────────────

let _store: RateLimitStore | null = null;

export function getRateLimitStore(): RateLimitStore {
  if (_store) return _store;

  const redisUrl = process.env.REDIS_URL;
  const failClosed = process.env.RATE_LIMIT_FAIL_CLOSED === "true";

  if (redisUrl) {
    logger.info("rate-limit: using Redis distributed store");
    _store = new RedisRateLimitStore(redisUrl, failClosed);
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
