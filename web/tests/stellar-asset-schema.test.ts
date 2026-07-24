import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  stellarAssetCodeSchema,
  stellarPublicKeySchema,
  stellarAssetSchema,
  stellarNativeAssetSchema,
  stellarIssuedAssetSchema,
} from "@/lib/schemas";

const VALID_KEYPAIR = Keypair.random();
const VALID_PUBLIC_KEY = VALID_KEYPAIR.publicKey();

const OTHER_VALID_KEY = "GDN5AZ5KL6ZUN4W7SLRUXA3ZXCF4V6POZPV2QKDVDHM7QAN6R54IB3BV";

describe("stellarAssetCodeSchema", () => {
  it("accepts a valid 4-char asset code (USDC)", () => {
    const result = stellarAssetCodeSchema.safeParse("USDC");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("USDC");
  });

  it("accepts a 1-char asset code (boundary minimum)", () => {
    const result = stellarAssetCodeSchema.safeParse("X");
    expect(result.success).toBe(true);
  });

  it("accepts a 12-char asset code (boundary maximum)", () => {
    const result = stellarAssetCodeSchema.safeParse("ABCDEFGHIJKL");
    expect(result.success).toBe(true);
  });

  it("rejects an empty asset code (boundary below min)", () => {
    const result = stellarAssetCodeSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects a 13-char asset code (boundary above max)", () => {
    const result = stellarAssetCodeSchema.safeParse("ABCDEFGHIJKLM");
    expect(result.success).toBe(false);
  });

  it("rejects lowercase letters in asset code (malformed)", () => {
    const result = stellarAssetCodeSchema.safeParse("usdc");
    expect(result.success).toBe(false);
  });

  it("rejects non-alphanumeric characters (malformed)", () => {
    const result = stellarAssetCodeSchema.safeParse("USD-C");
    expect(result.success).toBe(false);
  });

  it("rejects an asset code containing only spaces (malformed)", () => {
    const result = stellarAssetCodeSchema.safeParse("    ");
    expect(result.success).toBe(false);
  });
});

describe("stellarPublicKeySchema", () => {
  it("accepts a valid freshly-generated Ed25519 public key", () => {
    const result = stellarPublicKeySchema.safeParse(VALID_PUBLIC_KEY);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(VALID_PUBLIC_KEY);
  });

  it("accepts a well-known valid 56-char G-prefixed public key", () => {
    const result = stellarPublicKeySchema.safeParse(OTHER_VALID_KEY);
    expect(result.success).toBe(true);
  });

  it("rejects a public key that does not start with G (malformed prefix)", () => {
    const bad = "X" + VALID_PUBLIC_KEY.slice(1);
    const result = stellarPublicKeySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a short public key (boundary below 56 chars)", () => {
    const result = stellarPublicKeySchema.safeParse("GSHORT");
    expect(result.success).toBe(false);
  });

  it("rejects a 56-char G-prefixed key with invalid CRC (malformed)", () => {
    const bad =
      VALID_PUBLIC_KEY.slice(0, -1) +
      (VALID_PUBLIC_KEY.endsWith("A") ? "B" : "A");
    const result = stellarPublicKeySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects an empty string as public key (malformed)", () => {
    const result = stellarPublicKeySchema.safeParse("");
    expect(result.success).toBe(false);
  });
});

describe("stellarNativeAssetSchema", () => {
  it("accepts the native (XLM) asset descriptor", () => {
    const result = stellarNativeAssetSchema.safeParse({ type: "native" });
    expect(result.success).toBe(true);
  });

  it("rejects native asset with extra fields beyond type", () => {
    const result = stellarNativeAssetSchema.safeParse({
      type: "native",
      code: "XLM",
    } as any);
    expect(result.success).toBe(false);
  });
});

describe("stellarIssuedAssetSchema", () => {
  it("accepts an issued asset with valid code and issuer", () => {
    const result = stellarIssuedAssetSchema.safeParse({
      type: "issued",
      code: "USDC",
      issuer: VALID_PUBLIC_KEY,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an issued asset with a malformed (lowercase) code", () => {
    const result = stellarIssuedAssetSchema.safeParse({
      type: "issued",
      code: "usdc",
      issuer: VALID_PUBLIC_KEY,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an issued asset with a malformed issuer public key", () => {
    const result = stellarIssuedAssetSchema.safeParse({
      type: "issued",
      code: "USDC",
      issuer: "GBADKEY",
    });
    expect(result.success).toBe(false);
  });
});

describe("stellarAssetSchema (discriminated union)", () => {
  it("accepts a native asset via the discriminated union", () => {
    const result = stellarAssetSchema.safeParse({ type: "native" });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "native") {
      expect(result.data.type).toBe("native");
    }
  });

  it("accepts an issued asset via the discriminated union", () => {
    const result = stellarAssetSchema.safeParse({
      type: "issued",
      code: "MITOS",
      issuer: OTHER_VALID_KEY,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "issued") {
      expect(result.data.code).toBe("MITOS");
      expect(result.data.issuer).toBe(OTHER_VALID_KEY);
    }
  });

  it("rejects an asset with an unknown discriminator type", () => {
    const result = stellarAssetSchema.safeParse({ type: "erc20" } as any);
    expect(result.success).toBe(false);
  });

  it("rejects an issued asset missing the required issuer field", () => {
    const result = stellarAssetSchema.safeParse({
      type: "issued",
      code: "USDC",
    } as any);
    expect(result.success).toBe(false);
  });
});
