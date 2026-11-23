import { createServer, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  _resetRateLimitStore,
} from "../src/lib/rate-limit-store";
import { rateLimit, rateLimitResponse } from "../src/lib/rate-limit";

// ─── Fake RESP Server ────────────────────────────────────────────────────────

interface FakeRedisOptions {
  pttlResponse?: string;
}

interface FakeRedisServer {
  url: string;
  commands: string[][];
  setPttlResponse: (reply: string) => void;
  close: () => Promise<void>;
}

/**
 * Parse as many complete RESP arrays as are present in `buf`, returning parsed
 * command argument lists and the unparsed remainder.
 */
function parseRespCommands(buf: string): { commands: string[][]; rest: string } {
  const commands: string[][] = [];
  let offset = 0;

  while (offset < buf.length) {
    const startOffset = offset;
    if (buf[offset] !== "*") break;
    const arrayHeaderEnd = buf.indexOf("\r\n", offset);
    if (arrayHeaderEnd === -1) break;

    const argCount = Number(buf.slice(offset + 1, arrayHeaderEnd));
    if (!Number.isInteger(argCount) || argCount < 0) break;

    offset = arrayHeaderEnd + 2;
    const args: string[] = [];
    let incomplete = false;

    for (let i = 0; i < argCount; i++) {
      if (offset >= buf.length || buf[offset] !== "$") {
        incomplete = true;
        break;
      }
      const lenEnd = buf.indexOf("\r\n", offset);
      if (lenEnd === -1) {
        incomplete = true;
        break;
      }
      const byteLen = Number(buf.slice(offset + 1, lenEnd));
      const argStart = lenEnd + 2;
      const argEnd = argStart + byteLen;
      if (buf.length < argEnd + 2) {
        incomplete = true;
        break;
      }
      args.push(buf.slice(argStart, argEnd));
      offset = argEnd + 2;
    }

    if (incomplete) {
      offset = startOffset;
      break;
    }

    commands.push(args);
  }

  return { commands, rest: buf.slice(offset) };
}

async function startFakeRedisServer(options: FakeRedisOptions = {}): Promise<FakeRedisServer> {
  const counts = new Map<string, number>();
  const commands: string[][] = [];
  const sockets = new Set<Socket>();
  let pttlResponse = options.pttlResponse ?? ":30000\r\n";

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {
      // Ignore client disconnects (e.g. MinRedisClient closing after INCR reply).
    });

    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const parsed = parseRespCommands(buffer);
      buffer = parsed.rest;

      for (const cmd of parsed.commands) {
        commands.push(cmd);
        const op = cmd[0]?.toUpperCase();
        const key = cmd[1] ?? "";

        if (op === "INCR") {
          const next = (counts.get(key) ?? 0) + 1;
          counts.set(key, next);
          if (!socket.destroyed) socket.write(`:${next}\r\n`);
        } else if (op === "PEXPIREAT") {
          if (!socket.destroyed) socket.write(":1\r\n");
        } else if (op === "PTTL") {
          if (!socket.destroyed) socket.write(pttlResponse);
        } else if (op === "AUTH" || op === "SELECT") {
          if (!socket.destroyed) socket.write("+OK\r\n");
        } else {
          if (!socket.destroyed) socket.write(`-ERR unsupported command ${op}\r\n`);
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Unexpected server address");
  }

  return {
    url: `redis://127.0.0.1:${addr.port}`,
    commands,
    setPttlResponse: (reply: string) => {
      pttlResponse = reply;
    },
    close: async () => {
      for (const s of sockets) {
        if (!s.destroyed) s.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function getClosedRedisUrl(): Promise<string> {
  const srv = await startFakeRedisServer();
  const url = srv.url;
  await srv.close();
  return url;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
const ORIGINAL_FAIL_CLOSED = process.env.RATE_LIMIT_FAIL_CLOSED;
const ORIGINAL_MAX_RETRY_AFTER = process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
const ORIGINAL_UNKNOWN_RETRY_AFTER = process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;

const activeServers: FakeRedisServer[] = [];

beforeEach(() => {
  _resetRateLimitStore();
  delete process.env.REDIS_URL;
  delete process.env.RATE_LIMIT_FAIL_CLOSED;
  delete process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
  delete process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;
});

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop();
    if (srv) await srv.close();
  }
  _resetRateLimitStore();

  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;

  if (ORIGINAL_FAIL_CLOSED === undefined) delete process.env.RATE_LIMIT_FAIL_CLOSED;
  else process.env.RATE_LIMIT_FAIL_CLOSED = ORIGINAL_FAIL_CLOSED;

  if (ORIGINAL_MAX_RETRY_AFTER === undefined) delete process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
  else process.env.QUOTA_MAX_RETRY_AFTER_SECONDS = ORIGINAL_MAX_RETRY_AFTER;

  if (ORIGINAL_UNKNOWN_RETRY_AFTER === undefined) {
    delete process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;
  } else {
    process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS = ORIGINAL_UNKNOWN_RETRY_AFTER;
  }
});

// ─── MemoryRateLimitStore ────────────────────────────────────────────────────

describe("MemoryRateLimitStore", () => {
  it("returns finite resetAt for valid windowMs and caps huge window Retry-After", async () => {
    const store = new MemoryRateLimitStore();
    const key = `mem-huge-${Date.now()}-${Math.random()}`;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

    const before = Date.now();
    const res1 = await store.increment(key, thirtyDaysMs);
    const res2 = await store.increment(key, thirtyDaysMs);

    expect(res1.count).toBe(1);
    expect(res2.count).toBe(2);
    expect(res2.resetAt).not.toBeNull();
    expect(res2.resetAt!).toBeGreaterThanOrEqual(before + thirtyDaysMs);

    const response = rateLimitResponse({
      ok: false,
      limit: 1,
      remaining: 0,
      resetAt: res2.resetAt,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("3600");
    expect(response.headers.get("X-RateLimit-Reset")).toBeTruthy();
  });

  it.each([Number.NaN, Infinity, -Infinity, 0, -5_000])(
    "returns resetAt: null for invalid windowMs (%p), keeps counting, and yields finite Retry-After without X-RateLimit-Reset",
    async (badWindowMs) => {
      const store = new MemoryRateLimitStore();
      const key = `mem-bad-${String(badWindowMs)}-${Date.now()}-${Math.random()}`;

      const r1 = await store.increment(key, badWindowMs);
      const r2 = await store.increment(key, badWindowMs);

      expect(r1).toEqual({ count: 1, resetAt: null });
      expect(r2).toEqual({ count: 2, resetAt: null });

      const response = rateLimitResponse({
        ok: false,
        limit: 1,
        remaining: 0,
        resetAt: r2.resetAt,
      });
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect(response.headers.get("X-RateLimit-Reset")).toBeNull();
    },
  );
});

// ─── RedisRateLimitStore ─────────────────────────────────────────────────────

describe("RedisRateLimitStore", () => {
  it("returns finite resetAt on count === 1 and derives resetAt from positive PTTL on count > 1", async () => {
    const srv = await startFakeRedisServer({ pttlResponse: ":45000\r\n" });
    activeServers.push(srv);

    const store = new RedisRateLimitStore(srv.url, false);
    const key = `redis-ok-${Date.now()}`;

    const r1 = await store.increment(key, 60_000);
    expect(r1.count).toBe(1);
    expect(typeof r1.resetAt).toBe("number");
    expect(r1.resetAt!).toBeGreaterThan(Date.now());

    const r2 = await store.increment(key, 60_000);
    expect(r2.count).toBe(2);
    expect(typeof r2.resetAt).toBe("number");
    expect(r2.resetAt!).toBeGreaterThan(Date.now() + 35_000);
    expect(r2.resetAt!).toBeLessThanOrEqual(Date.now() + 50_000);
  });

  it("caps Retry-After at 3600 when Redis PTTL reports a 24-hour TTL", async () => {
    const srv = await startFakeRedisServer({ pttlResponse: ":86400000\r\n" });
    activeServers.push(srv);
    process.env.REDIS_URL = srv.url;

    const key = `redis-24h-${Date.now()}`;
    const first = await rateLimit(key, { limit: 1, windowMs: 86_400_000 });
    expect(first.ok).toBe(true);

    const exceeded = await rateLimit(key, { limit: 1, windowMs: 86_400_000 });
    expect(exceeded.ok).toBe(false);
    expect(exceeded.resetAt).not.toBeNull();

    const resp = rateLimitResponse(exceeded);
    expect(resp.status).toBe(429);
    expect(resp.headers.get("Retry-After")).toBe("3600");
    expect(Number(resp.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(0);
  });

  it.each([
    ["persistent key (-1)", ":-1\r\n"],
    ["missing key (-2)", ":-2\r\n"],
    ["zero PTTL (0)", ":0\r\n"],
    ["overflow PTTL (1e20)", ":99999999999999999999\r\n"],
    ["Redis error (-ERR)", "-ERR PTTL failed\r\n"],
  ])(
    "returns resetAt: null on count > 1 when PTTL returns %s, emitting finite Retry-After: 60 and no X-RateLimit-Reset",
    async (_label, pttlReply) => {
      const srv = await startFakeRedisServer({ pttlResponse: pttlReply });
      activeServers.push(srv);
      process.env.REDIS_URL = srv.url;

      const key = `redis-pttl-${Date.now()}-${Math.random()}`;
      const r1 = await rateLimit(key, { limit: 1, windowMs: 60_000 });
      expect(r1.ok).toBe(true);

      const r2 = await rateLimit(key, { limit: 1, windowMs: 60_000 });
      expect(r2.ok).toBe(false);
      expect(r2.resetAt).toBeNull();

      const resp = rateLimitResponse(r2);
      expect(resp.status).toBe(429);
      expect(resp.headers.get("Retry-After")).toBe("60");
      expect(resp.headers.get("X-RateLimit-Reset")).toBeNull();
    },
  );

  it("returns count=MAX_SAFE_INTEGER and resetAt=null when Redis is unreachable in fail-closed mode", async () => {
    const closedUrl = await getClosedRedisUrl();
    process.env.REDIS_URL = closedUrl;
    process.env.RATE_LIMIT_FAIL_CLOSED = "true";

    const result = await rateLimit(`redis-closed-${Date.now()}`, {
      limit: 10,
      windowMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetAt).toBeNull();

    const resp = rateLimitResponse(result);
    expect(resp.status).toBe(429);
    expect(resp.headers.get("Retry-After")).toBe("60");
    expect(resp.headers.get("X-RateLimit-Reset")).toBeNull();
  });

  it("falls back to MemoryRateLimitStore when Redis is unreachable in fail-open mode", async () => {
    const closedUrl = await getClosedRedisUrl();
    const store = new RedisRateLimitStore(closedUrl, false);
    const key = `redis-open-${Date.now()}-${Math.random()}`;

    const r1 = await store.increment(key, 60_000);
    const r2 = await store.increment(key, 60_000);

    expect(r1.count).toBe(1);
    expect(r2.count).toBe(2);
    expect(r1.resetAt).not.toBeNull();
    expect(r2.resetAt).toBe(r1.resetAt);
  });

  it.each([Number.NaN, Infinity, 0, -1_000])(
    "sends a finite positive integer PEXPIREAT and returns resetAt: null for invalid windowMs (%p)",
    async (badWindowMs) => {
      const srv = await startFakeRedisServer({ pttlResponse: ":30000\r\n" });
      activeServers.push(srv);

      const store = new RedisRateLimitStore(srv.url, false);
      const key = `redis-bad-win-${String(badWindowMs)}-${Date.now()}`;

      const result = await store.increment(key, badWindowMs);
      expect(result).toEqual({ count: 1, resetAt: null });

      // Wait briefly for the pipelined PEXPIREAT command to be read by the fake server.
      await new Promise((resolve) => setTimeout(resolve, 25));

      const pexpireCmd = srv.commands.find((c) => c[0]?.toUpperCase() === "PEXPIREAT");
      expect(pexpireCmd).toBeDefined();
      const expireArg = pexpireCmd![2];
      expect(expireArg).toMatch(/^\d+$/);
      expect(Number(expireArg)).toBeGreaterThan(Date.now() - 5_000);
    },
  );
});
