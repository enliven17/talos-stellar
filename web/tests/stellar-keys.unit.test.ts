import { describe, it, expect } from "vitest";
import { parseStellarPublicKeyParam } from "../src/lib/stellar-keys";
import { Keypair } from "@stellar/stellar-sdk";

describe("parseStellarPublicKeyParam", () => {
  const validKey = Keypair.random().publicKey();
  const secretKey = Keypair.random().secret();

  it("accepts a valid Stellar Ed25519 public key", () => {
    const result = parseStellarPublicKeyParam(validKey);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicKey).toBe(validKey);
    }
  });

  it("trims surrounding whitespace from a valid public key", () => {
    const result = parseStellarPublicKeyParam(`  ${validKey}  `);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publicKey).toBe(validKey);
    }
  });

  it("returns 400 when parameter is null or empty", async () => {
    const resNull = parseStellarPublicKeyParam(null);
    expect(resNull.ok).toBe(false);
    if (!resNull.ok) {
      expect(resNull.response.status).toBe(400);
      const data = await resNull.response.json();
      expect(data).toEqual({ error: "wallet parameter required" });
    }

    const resEmpty = parseStellarPublicKeyParam("");
    expect(resEmpty.ok).toBe(false);
    if (!resEmpty.ok) {
      expect(resEmpty.response.status).toBe(400);
      const data = await resEmpty.response.json();
      expect(data).toEqual({ error: "wallet parameter required" });
    }

    const resWhitespace = parseStellarPublicKeyParam("   ");
    expect(resWhitespace.ok).toBe(false);
    if (!resWhitespace.ok) {
      expect(resWhitespace.response.status).toBe(400);
      const data = await resWhitespace.response.json();
      expect(data).toEqual({ error: "wallet parameter required" });
    }
  });

  it("returns 400 for lowercase public keys", async () => {
    const lowerKey = validKey.toLowerCase();
    const result = parseStellarPublicKeyParam(lowerKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const data = await result.response.json();
      expect(data).toEqual({ error: "Invalid wallet parameter" });
    }
  });

  it("returns 400 for truncated public keys", async () => {
    const truncatedKey = validKey.slice(0, 32);
    const result = parseStellarPublicKeyParam(truncatedKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const data = await result.response.json();
      expect(data).toEqual({ error: "Invalid wallet parameter" });
    }
  });

  it("returns 400 for secret seed inputs (S...)", async () => {
    const result = parseStellarPublicKeyParam(secretKey);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const data = await result.response.json();
      expect(data).toEqual({ error: "Invalid wallet parameter" });
    }
  });

  it("supports custom parameter name in error message", async () => {
    const res = parseStellarPublicKeyParam("invalid", "account");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.response.status).toBe(400);
      const data = await res.response.json();
      expect(data).toEqual({ error: "Invalid account parameter" });
    }
  });
});
