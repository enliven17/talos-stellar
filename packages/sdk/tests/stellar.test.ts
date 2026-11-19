/**
 * Unit tests for the Stellar network helpers exported from `stellar.ts`.
 *
 * Covers every exported function with at least one positive and one negative
 * case. Pure unit tests — no network calls.
 *
 * Issue #866.
 */

import { describe, it, expect } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  generateKeypair,
  isValidPublicKey,
  isValidSecretKey,
  normalizeNetworkId,
  networkIdFromPassphrase,
  isKnownNetworkPassphrase,
  resolveNetworkConfig,
  NETWORK_PASSPHRASES,
  type TalosNetworkId,
} from "../src/stellar.js";

// ── generateKeypair ─────────────────────────────────────────────────────────

describe("generateKeypair", () => {
  it("returns a valid public key and secret", () => {
    const kp = generateKeypair();
    expect(typeof kp.publicKey).toBe("string");
    expect(typeof kp.secret).toBe("string");
    expect(kp.publicKey).toMatch(/^G/);
    expect(kp.secret).toMatch(/^S/);
    // The generated key should be cryptographically valid.
    expect(isValidPublicKey(kp.publicKey)).toBe(true);
    expect(isValidSecretKey(kp.secret)).toBe(true);
  });

  it("produces a round-trippable keypair (secret re-derives the public key)", () => {
    const kp = generateKeypair();
    const restored = Keypair.fromSecret(kp.secret);
    expect(restored.publicKey()).toBe(kp.publicKey);
  });

  it("generates a different keypair on each call (randomness)", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.secret).not.toBe(b.secret);
  });
});

// ── isValidPublicKey ────────────────────────────────────────────────────────

describe("isValidPublicKey", () => {
  it("accepts a valid public key (positive)", () => {
    const kp = Keypair.random();
    expect(isValidPublicKey(kp.publicKey())).toBe(true);
  });

  it("rejects a secret key passed as a public key (negative)", () => {
    const kp = Keypair.random();
    expect(isValidPublicKey(kp.secret())).toBe(false);
  });

  it("rejects an empty string (negative)", () => {
    expect(isValidPublicKey("")).toBe(false);
  });

  it("rejects a random non-key string (negative)", () => {
    expect(isValidPublicKey("not-a-key")).toBe(false);
  });

  it("rejects a corrupted key (negative)", () => {
    const kp = Keypair.random();
    const corrupted = kp.publicKey().slice(0, -1) + "0";
    expect(isValidPublicKey(corrupted)).toBe(false);
  });
});

// ── isValidSecretKey ────────────────────────────────────────────────────────

describe("isValidSecretKey", () => {
  it("accepts a valid secret key (positive)", () => {
    const kp = Keypair.random();
    expect(isValidSecretKey(kp.secret())).toBe(true);
  });

  it("rejects a public key passed as a secret key (negative)", () => {
    const kp = Keypair.random();
    expect(isValidSecretKey(kp.publicKey())).toBe(false);
  });

  it("rejects an empty string (negative)", () => {
    expect(isValidSecretKey("")).toBe(false);
  });

  it("rejects a random non-key string (negative)", () => {
    expect(isValidSecretKey("not-a-secret")).toBe(false);
  });

  it("rejects a corrupted secret (negative)", () => {
    const kp = Keypair.random();
    const corrupted = kp.secret().slice(0, -1) + "0";
    expect(isValidSecretKey(corrupted)).toBe(false);
  });
});

// ── normalizeNetworkId ──────────────────────────────────────────────────────

describe("normalizeNetworkId", () => {
  // Positive cases — canonical ids
  it("accepts canonical ids (positive)", () => {
    expect(normalizeNetworkId("public")).toBe("public");
    expect(normalizeNetworkId("testnet")).toBe("testnet");
    expect(normalizeNetworkId("futurenet")).toBe("futurenet");
    expect(normalizeNetworkId("standalone")).toBe("standalone");
  });

  // Positive cases — aliases
  it("normalises mainnet alias to public (positive)", () => {
    expect(normalizeNetworkId("mainnet")).toBe("public");
  });

  it("normalises pubnet alias to public (positive)", () => {
    expect(normalizeNetworkId("pubnet")).toBe("public");
  });

  // Positive cases — stellar: prefix
  it("strips the stellar: prefix (positive)", () => {
    expect(normalizeNetworkId("stellar:testnet")).toBe("testnet");
    expect(normalizeNetworkId("stellar:public")).toBe("public");
  });

  // Positive cases — case insensitivity and whitespace
  it("is case-insensitive and trims whitespace (positive)", () => {
    expect(normalizeNetworkId("  Testnet  ")).toBe("testnet");
    expect(normalizeNetworkId("MAINNET")).toBe("public");
  });

  // Negative cases
  it("throws RangeError for an unknown id (negative)", () => {
    expect(() => normalizeNetworkId("unknownnet")).toThrow(RangeError);
  });

  it("throws RangeError for an empty string (negative)", () => {
    expect(() => normalizeNetworkId("")).toThrow(RangeError);
    expect(() => normalizeNetworkId("   ")).toThrow(RangeError);
  });

  it("throws TypeError for non-string input (negative)", () => {
    expect(() => normalizeNetworkId(42 as unknown as string)).toThrow(TypeError);
    expect(() => normalizeNetworkId(null as unknown as string)).toThrow(TypeError);
    expect(() => normalizeNetworkId(undefined as unknown as string)).toThrow(
      TypeError,
    );
  });

  it("does not echo the raw input in the error message (privacy-safe)", () => {
    expect(() => normalizeNetworkId("super-secret-value")).toThrow(
      /network must be one of/,
    );
  });
});

// ── networkIdFromPassphrase ─────────────────────────────────────────────────

describe("networkIdFromPassphrase", () => {
  it("resolves the public passphrase (positive)", () => {
    expect(networkIdFromPassphrase(Networks.PUBLIC)).toBe("public");
  });

  it("resolves the testnet passphrase (positive)", () => {
    expect(networkIdFromPassphrase(Networks.TESTNET)).toBe("testnet");
  });

  it("resolves the futurenet passphrase (positive)", () => {
    expect(networkIdFromPassphrase(Networks.FUTURENET)).toBe("futurenet");
  });

  it("resolves the standalone passphrase (positive)", () => {
    expect(networkIdFromPassphrase(Networks.STANDALONE)).toBe("standalone");
  });

  it("returns undefined for an unknown passphrase (negative)", () => {
    expect(networkIdFromPassphrase("not-a-real-network")).toBeUndefined();
  });

  it("returns undefined for an empty string (negative)", () => {
    expect(networkIdFromPassphrase("")).toBeUndefined();
  });

  it("returns undefined for a non-string input (negative)", () => {
    expect(networkIdFromPassphrase(42 as unknown as string)).toBeUndefined();
    expect(networkIdFromPassphrase(null as unknown as string)).toBeUndefined();
    expect(networkIdFromPassphrase(undefined as unknown as string)).toBeUndefined();
  });
});

// ── isKnownNetworkPassphrase ────────────────────────────────────────────────

describe("isKnownNetworkPassphrase", () => {
  it("returns true for a known passphrase (positive)", () => {
    expect(isKnownNetworkPassphrase(Networks.PUBLIC)).toBe(true);
    expect(isKnownNetworkPassphrase(Networks.TESTNET)).toBe(true);
    expect(isKnownNetworkPassphrase(Networks.FUTURENET)).toBe(true);
    expect(isKnownNetworkPassphrase(Networks.STANDALONE)).toBe(true);
  });

  it("returns false for an unknown passphrase (negative)", () => {
    expect(isKnownNetworkPassphrase("not-a-real-network")).toBe(false);
  });

  it("returns false for an empty string (negative)", () => {
    expect(isKnownNetworkPassphrase("")).toBe(false);
  });

  it("returns false for a non-string input (negative)", () => {
    expect(isKnownNetworkPassphrase(42 as unknown as string)).toBe(false);
    expect(isKnownNetworkPassphrase(null as unknown as string)).toBe(false);
  });
});

// ── resolveNetworkConfig ───────────────────────────────────────────────────

describe("resolveNetworkConfig", () => {
  // ── Positive cases ──

  it("returns undefined when no options are provided (positive)", () => {
    expect(resolveNetworkConfig()).toBeUndefined();
    expect(resolveNetworkConfig(null)).toBeUndefined();
    expect(resolveNetworkConfig(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty options object (positive)", () => {
    expect(resolveNetworkConfig({})).toBeUndefined();
  });

  it("resolves only network → fills passphrase (positive)", () => {
    const result = resolveNetworkConfig({ network: "testnet" });
    expect(result).toEqual({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
    });
  });

  it("normalises aliases when only network is given (positive)", () => {
    expect(resolveNetworkConfig({ network: "mainnet" })).toEqual({
      network: "public",
      networkPassphrase: Networks.PUBLIC,
    });
    expect(resolveNetworkConfig({ network: "stellar:testnet" })).toEqual({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
    });
  });

  it("resolves only networkPassphrase → fills network (positive)", () => {
    const result = resolveNetworkConfig({
      networkPassphrase: Networks.PUBLIC,
    });
    expect(result).toEqual({
      network: "public",
      networkPassphrase: Networks.PUBLIC,
    });
  });

  it("accepts both when they agree (positive)", () => {
    const result = resolveNetworkConfig({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
    });
    expect(result).toEqual({
      network: "testnet",
      networkPassphrase: Networks.TESTNET,
    });
  });

  it("returns a frozen result object (positive)", () => {
    const result = resolveNetworkConfig({ network: "testnet" });
    expect(Object.isFrozen(result)).toBe(true);
  });

  // ── Negative cases ──

  it("throws when network and passphrase disagree (negative)", () => {
    expect(() =>
      resolveNetworkConfig({ network: "testnet", networkPassphrase: Networks.PUBLIC }),
    ).toThrow(RangeError);
  });

  it("throws RangeError when only an unknown passphrase is provided (negative)", () => {
    expect(() =>
      resolveNetworkConfig({ networkPassphrase: "not-a-real-network" }),
    ).toThrow(RangeError);
  });

  it("throws RangeError for an empty passphrase (negative)", () => {
    expect(() => resolveNetworkConfig({ networkPassphrase: "" })).toThrow(
      RangeError,
    );
    expect(() => resolveNetworkConfig({ networkPassphrase: "   " })).toThrow(
      RangeError,
    );
  });

  it("throws RangeError for an unknown network (negative)", () => {
    expect(() => resolveNetworkConfig({ network: "unknownnet" })).toThrow(
      RangeError,
    );
  });

  it("throws TypeError for a non-string network (negative)", () => {
    expect(() =>
      resolveNetworkConfig({ network: 42 as unknown as string }),
    ).toThrow(TypeError);
  });

  it("throws TypeError for a non-string passphrase (negative)", () => {
    expect(() =>
      resolveNetworkConfig({ networkPassphrase: 42 as unknown as string }),
    ).toThrow(TypeError);
  });

  it("throws TypeError for a non-object input (negative)", () => {
    expect(() => resolveNetworkConfig("testnet" as never)).toThrow(TypeError);
    expect(() => resolveNetworkConfig(42 as never)).toThrow(TypeError);
  });

  it("throws TypeError when an array is passed (negative)", () => {
    expect(() =>
      resolveNetworkConfig([] as unknown as { network?: string }),
    ).toThrow(TypeError);
  });
});

// ── NETWORK_PASSPHRASES invariant ────────────────────────────────────────────

describe("NETWORK_PASSPHRASES", () => {
  it("maps every canonical network id to the correct passphrase", () => {
    expect(NETWORK_PASSPHRASES.public).toBe(Networks.PUBLIC);
    expect(NETWORK_PASSPHRASES.testnet).toBe(Networks.TESTNET);
    expect(NETWORK_PASSPHRASES.futurenet).toBe(Networks.FUTURENET);
    expect(NETWORK_PASSPHRASES.standalone).toBe(Networks.STANDALONE);
  });

  it("is frozen (immutable)", () => {
    expect(Object.isFrozen(NETWORK_PASSPHRASES)).toBe(true);
  });

  it("is a round-trip with networkIdFromPassphrase for every entry", () => {
    for (const id of Object.keys(NETWORK_PASSPHRASES) as TalosNetworkId[]) {
      const passphrase = NETWORK_PASSPHRASES[id];
      expect(networkIdFromPassphrase(passphrase)).toBe(id);
    }
  });
});
