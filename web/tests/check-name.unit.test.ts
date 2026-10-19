import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/talos/check-name/route";
import { db } from "@/db";
import { isNameAvailableOnChain } from "@/lib/soroban";
import { TALOS_NAME_MIN_LENGTH, TALOS_NAME_MAX_LENGTH } from "@/lib/limits";

vi.mock("@/db", () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock("@/db/schema", () => ({
  tlsTalos: {
    id: "id",
    agentName: "agentName",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ op: "eq", col, val })),
}));

vi.mock("@/lib/soroban", () => ({
  isNameAvailableOnChain: vi.fn(),
}));

function mockSelectChain(results: unknown[]) {
  const chain: Record<string, unknown> = {};
  const stepMethods = ["from", "where", "limit"];
  for (const method of stepMethods) {
    chain[method] = vi.fn().mockReturnValue(chain);
  }
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(results).then(resolve, reject);
  return chain;
}

function makeRequest(name?: string): NextRequest {
  const url = name !== undefined
    ? `http://localhost/api/talos/check-name?name=${encodeURIComponent(name)}`
    : `http://localhost/api/talos/check-name`;
  return new NextRequest(url);
}

describe("GET /api/talos/check-name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.select).mockImplementation(() => mockSelectChain([]) as unknown as ReturnType<typeof db.select>);
    vi.mocked(isNameAvailableOnChain).mockResolvedValue(true);
  });

  it("exports matching length boundary constants", () => {
    expect(TALOS_NAME_MIN_LENGTH).toBe(3);
    expect(TALOS_NAME_MAX_LENGTH).toBe(32);
  });

  describe("length boundary checks", () => {
    it("rejects missing or empty name with minimum length reason", async () => {
      const res = await GET(makeRequest());
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        available: false,
        reason: "Name must be at least 3 characters",
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(isNameAvailableOnChain).not.toHaveBeenCalled();
    });

    it("rejects 2-character names with minimum length reason", async () => {
      const res = await GET(makeRequest("ab"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        available: false,
        reason: "Name must be at least 3 characters",
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(isNameAvailableOnChain).not.toHaveBeenCalled();
    });

    it("accepts 3-character names when format is valid and not taken", async () => {
      const res = await GET(makeRequest("abc"));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ available: true });
      expect(db.select).toHaveBeenCalled();
      expect(isNameAvailableOnChain).toHaveBeenCalledWith("abc");
    });

    it("accepts exactly 32-character names when format is valid and not taken", async () => {
      const name32 = "a".repeat(32);
      const res = await GET(makeRequest(name32));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ available: true });
      expect(db.select).toHaveBeenCalled();
      expect(isNameAvailableOnChain).toHaveBeenCalledWith(name32);
    });

    it("accepts 32-character alphanumeric names with hyphens", async () => {
      const name32 = "abcdefghijklmnopqrstuvwxyz123456";
      expect(name32.length).toBe(32);
      const res = await GET(makeRequest(name32));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({ available: true });
    });

    it("rejects exactly 33-character names with maximum length reason", async () => {
      const name33 = "a".repeat(33);
      const res = await GET(makeRequest(name33));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        available: false,
        reason: "Name must be at most 32 characters",
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(isNameAvailableOnChain).not.toHaveBeenCalled();
    });

    it("rejects names longer than 33 characters (e.g. 40 characters)", async () => {
      const name40 = "a".repeat(40);
      const res = await GET(makeRequest(name40));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        available: false,
        reason: "Name must be at most 32 characters",
      });
      expect(db.select).not.toHaveBeenCalled();
      expect(isNameAvailableOnChain).not.toHaveBeenCalled();
    });
  });

  describe("format validation", () => {
    it("rejects names with invalid characters", async () => {
      const res = await GET(makeRequest("bad_name"));
      const data = await res.json();
      expect(data).toEqual({ available: false, reason: "Invalid format" });
    });

    it("rejects names starting or ending with a hyphen", async () => {
      const resStart = await GET(makeRequest("-abc"));
      expect(await resStart.json()).toEqual({ available: false, reason: "Invalid format" });

      const resEnd = await GET(makeRequest("abc-"));
      expect(await resEnd.json()).toEqual({ available: false, reason: "Invalid format" });
    });

    it("rejects consecutive hyphens", async () => {
      const res = await GET(makeRequest("a--b"));
      expect(await res.json()).toEqual({ available: false, reason: "Invalid format" });
    });

    it("normalizes case and trims whitespace", async () => {
      const res = await GET(makeRequest("  AbC-123  "));
      expect(await res.json()).toEqual({ available: true });
      expect(isNameAvailableOnChain).toHaveBeenCalledWith("abc-123");
    });
  });

  describe("availability checks", () => {
    it("returns available: false when name is taken in DB", async () => {
      vi.mocked(db.select).mockImplementation(
        () => mockSelectChain([{ id: "talos-123" }]) as unknown as ReturnType<typeof db.select>,
      );

      const res = await GET(makeRequest("validname"));
      const data = await res.json();
      expect(data).toEqual({ available: false, reason: "Name already taken" });
      expect(isNameAvailableOnChain).not.toHaveBeenCalled();
    });

    it("returns available: false when name is taken on-chain", async () => {
      vi.mocked(isNameAvailableOnChain).mockResolvedValue(false);

      const res = await GET(makeRequest("validname"));
      const data = await res.json();
      expect(data).toEqual({ available: false, reason: "Name already registered on-chain" });
    });

    it("falls back to DB when on-chain check throws an error", async () => {
      vi.mocked(isNameAvailableOnChain).mockRejectedValue(new Error("RPC failure"));

      const res = await GET(makeRequest("validname"));
      const data = await res.json();
      expect(data).toEqual({ available: true });
    });
  });
});
