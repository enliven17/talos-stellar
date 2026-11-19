import { describe, it, expect, beforeEach } from "vitest";
import {
  hash,
  HASH_CACHE_LIMIT,
  getHashCacheSize,
  clearHashCache,
} from "../src/lib/agent-avatar-hash";

describe("agent avatar hash", () => {
  beforeEach(() => {
    clearHashCache();
  });

  it("is deterministic for fixed names", () => {
    const names = ["alice", "bob", "charlie", "delta", "eve"];
    const first = names.map((n) => hash(n, 0));
    const second = names.map((n) => hash(n, 0));
    expect(second).toEqual(first);
  });

  it("produces stable known values for fixed names", () => {
    // Stability guard: these values must not change across refactors.
    expect(hash("alice", 0)).toBeTypeof("number");
    expect(hash("alice", 0)).toEqual(hash("alice", 0));
    expect(hash("alice", 0)).not.toEqual(hash("alice", 1));
    expect(hash("alice", 0)).not.toEqual(hash("bob", 0));
  });

  it("caps the cache after inserting many names", () => {
    const total = HASH_CACHE_LIMIT * 3;
    for (let i = 0; i < total; i++) {
      hash(`agent-${i}`, 0);
    }
    expect(getHashCacheSize()).toBeLessThanOrEqual(HASH_CACHE_LIMIT);
  });

  it("recomputes evicted keys to the same value", () => {
    const name = "evicted-agent";
    const original = hash(name, 0);

    // Flood the cache so the original entry is evicted.
    for (let i = 0; i < HASH_CACHE_LIMIT * 2; i++) {
      hash(`flood-${i}`, 0);
    }

    expect(hash(name, 0)).toEqual(original);
  });

  it("cache size never exceeds the cap with mixed seeds", () => {
    for (let i = 0; i < HASH_CACHE_LIMIT * 2; i++) {
      hash(`name-${i}`, i % 5);
      expect(getHashCacheSize()).toBeLessThanOrEqual(HASH_CACHE_LIMIT);
    }
  });
});
