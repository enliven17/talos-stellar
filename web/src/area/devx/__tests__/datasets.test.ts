import { describe, it, expect } from "vitest";
import {
  generateTalosIds,
  generatePayloads,
  generateActivityEntries,
  generateTransferPayloads,
} from "../datasets";

describe("generateTalosIds", () => {
  it("generates requested number of ids", () => {
    const ids = generateTalosIds(10);
    expect(ids).toHaveLength(10);
  });

  it("generates deterministic output with same seed", () => {
    const a = generateTalosIds(5, 42);
    const b = generateTalosIds(5, 42);
    expect(a).toEqual(b);
  });

  it("generates different output with different seeds", () => {
    const a = generateTalosIds(5, 42);
    const b = generateTalosIds(5, 99);
    expect(a).not.toEqual(b);
  });

  it("each id is a 24-char alphanumeric string", () => {
    const ids = generateTalosIds(100);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9]{24}$/);
    }
  });
});

describe("generatePayloads", () => {
  it("generates requested number of payloads", () => {
    const payloads = generatePayloads(10);
    expect(payloads).toHaveLength(10);
  });

  it("each payload has index, value, label, tags", () => {
    const payloads = generatePayloads(5);
    for (const p of payloads) {
      expect(p).toHaveProperty("index");
      expect(p).toHaveProperty("value");
      expect(p).toHaveProperty("label");
      expect(p).toHaveProperty("tags");
      expect(Array.isArray(p.tags)).toBe(true);
    }
  });

  it("produces deterministic output", () => {
    const a = generatePayloads(3, 42);
    const b = generatePayloads(3, 42);
    expect(a).toEqual(b);
  });
});

describe("generateActivityEntries", () => {
  it("generates requested number of entries", () => {
    const entries = generateActivityEntries(10);
    expect(entries).toHaveLength(10);
  });

  it("each entry has valid type, content, channel", () => {
    const entries = generateActivityEntries(20);
    const validTypes = ["post", "research", "reply", "engagement", "commerce", "approval"];
    const validChannels = ["twitter", "discord", "telegram", "email", "web"];
    for (const e of entries) {
      expect(validTypes).toContain(e.type);
      expect(typeof e.content).toBe("string");
      expect(e.content.length).toBeGreaterThan(0);
      expect(validChannels).toContain(e.channel);
    }
  });
});

describe("generateTransferPayloads", () => {
  it("generates requested number of payloads", () => {
    const payloads = generateTransferPayloads(5);
    expect(payloads).toHaveLength(5);
  });

  it("each payload has valid transfer shape", () => {
    const payloads = generateTransferPayloads(5);
    for (const p of payloads) {
      expect(p.asset).toBe("USDC");
      expect(p.amount).toMatch(/^\d+\.\d{2}$/);
      expect(p.nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(p.signature).toMatch(/^[0-9a-f]{64}$/);
      expect(p.destination).toMatch(/^G[A-Z2-7]{55}$/);
    }
  });
});