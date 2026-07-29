import { describe, it, expect } from "vitest";
import {
  stellarAssetSchema,
  signPaymentSchema,
  createTalosSchema,
} from "../src/lib/schemas";

// Real Stellar public keys with verified CRC16 checksums
const VALID_ISSUER_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"; // testnet USDC
const VALID_ISSUER_B = "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL"; // operator
const VALID_ISSUER_C = "GDULUZ7WKON44PYY3FFMZBV3DPVBFWB32VAKSVSDIOECJPM4X2XR2BSG"; // random valid

// ---------------------------------------------------------------------------
// stellarAssetSchema — shared native / issued discriminated union
// ---------------------------------------------------------------------------
describe("stellarAssetSchema", () => {
  describe("native (XLM)", () => {
    it("accepts { native: true }", () => {
      const result = stellarAssetSchema.safeParse({ native: true });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual({ native: true });
    });

    it("rejects { native: true, code: 'XLM' } — extra fields not allowed", () => {
      const result = stellarAssetSchema.safeParse({ native: true, code: "XLM" });
      expect(result.success).toBe(false);
    });

    it("rejects { native: 'true' } — must be boolean literal", () => {
      expect(stellarAssetSchema.safeParse({ native: "true" }).success).toBe(false);
    });

    it("rejects { native: 1 } — must be boolean literal", () => {
      expect(stellarAssetSchema.safeParse({ native: 1 }).success).toBe(false);
    });
  });

  describe("issued asset", () => {
    it("accepts a valid code + valid issuer StrKey", () => {
      const result = stellarAssetSchema.safeParse({
        code: "USDC",
        issuer: VALID_ISSUER_A,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual({ code: "USDC", issuer: VALID_ISSUER_A });
      }
    });

    it("accepts a 12-character alphanumeric code (max length)", () => {
      const result = stellarAssetSchema.safeParse({
        code: "ABCDEFGHIJKL",
        issuer: VALID_ISSUER_B,
      });
      expect(result.success).toBe(true);
    });

    it("accepts a 1-character code (min length)", () => {
      const result = stellarAssetSchema.safeParse({
        code: "X",
        issuer: VALID_ISSUER_C,
      });
      expect(result.success).toBe(true);
    });

    it("accepts a numeric-only code", () => {
      const result = stellarAssetSchema.safeParse({
        code: "12345",
        issuer: VALID_ISSUER_A,
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing code", () => {
      expect(
        stellarAssetSchema.safeParse({ issuer: VALID_ISSUER_A }).success,
      ).toBe(false);
    });

    it("rejects empty code", () => {
      expect(
        stellarAssetSchema.safeParse({ code: "", issuer: VALID_ISSUER_A }).success,
      ).toBe(false);
    });

    it("rejects code longer than 12 characters", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "ABCDEFGHIJKLM", // 13 chars
          issuer: VALID_ISSUER_A,
        }).success,
      ).toBe(false);
    });

    it("rejects lowercase code", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "usdc",
          issuer: VALID_ISSUER_A,
        }).success,
      ).toBe(false);
    });

    it("rejects code with special characters", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "US-DC",
          issuer: VALID_ISSUER_A,
        }).success,
      ).toBe(false);
    });

    it("rejects code with spaces", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "US DC",
          issuer: VALID_ISSUER_A,
        }).success,
      ).toBe(false);
    });

    it("rejects missing issuer", () => {
      expect(
        stellarAssetSchema.safeParse({ code: "USDC" }).success,
      ).toBe(false);
    });

    it("rejects issuer with wrong checksum", () => {
      // Flip the last character to invalidate the CRC16
      const badChecksum = VALID_ISSUER_A.slice(0, -1) + "A";
      expect(
        stellarAssetSchema.safeParse({
          code: "USDC",
          issuer: badChecksum,
        }).success,
      ).toBe(false);
    });

    it("rejects issuer that is too short", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "USDC",
          issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3",
        }).success,
      ).toBe(false);
    });

    it("rejects issuer that is too long", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "USDC",
          issuer: VALID_ISSUER_A + "A",
        }).success,
      ).toBe(false);
    });

    it("rejects issuer that starts with S (seed key, not public)", () => {
      // S... keys have version byte 0xb0; should be rejected for issuer use
      const sdk = require("@stellar/stellar-sdk");
      const secret = "SAZJ3JF6V5XVNELUCA7LMKUPE7LH6QV4YV4YV4YV4YV4YV4YV4YV";
      // Build a valid-format secret key with correct checksum
      const kp = sdk.Keypair.random();
      const seed = kp.secret(); // starts with S
      expect(
        stellarAssetSchema.safeParse({
          code: "USDC",
          issuer: seed,
        }).success,
      ).toBe(false);
    });

    it("rejects issuer that is not a valid base32 string", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "USDC",
          issuer: "G0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0",
        }).success,
      ).toBe(false);
    });

    it("rejects completely invalid issuer string", () => {
      expect(
        stellarAssetSchema.safeParse({
          code: "USDC",
          issuer: "not-a-stellar-key",
        }).success,
      ).toBe(false);
    });

    it("rejects native + code/issuer together (discriminated union)", () => {
      expect(
        stellarAssetSchema.safeParse({
          native: true,
          code: "USDC",
          issuer: VALID_ISSUER_A,
        }).success,
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// signPaymentSchema — now includes typed `asset` field
// ---------------------------------------------------------------------------
describe("signPaymentSchema", () => {
  const base = { payee: "GABC", amount: "1.00" };

  it("accepts with no asset (backward compat, defaults handled by route)", () => {
    const result = signPaymentSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("accepts with legacy assetCode string", () => {
    const result = signPaymentSchema.safeParse({ ...base, assetCode: "USDC" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.assetCode).toBe("USDC");
  });

  it("accepts with typed native asset", () => {
    const result = signPaymentSchema.safeParse({
      ...base,
      asset: { native: true },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.asset).toEqual({ native: true });
  });

  it("accepts with typed issued asset", () => {
    const result = signPaymentSchema.safeParse({
      ...base,
      asset: { code: "USDC", issuer: VALID_ISSUER_A },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.asset).toEqual({
        code: "USDC",
        issuer: VALID_ISSUER_A,
      });
    }
  });

  it("rejects typed asset with invalid issuer checksum", () => {
    const result = signPaymentSchema.safeParse({
      ...base,
      asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA6" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects typed asset with lowercase code", () => {
    const result = signPaymentSchema.safeParse({
      ...base,
      asset: { code: "usdc", issuer: VALID_ISSUER_A },
    });
    expect(result.success).toBe(false);
  });

  it("accepts with both asset and legacy assetCode (asset takes precedence)", () => {
    const result = signPaymentSchema.safeParse({
      ...base,
      asset: { code: "USDC", issuer: VALID_ISSUER_A },
      assetCode: "XLM",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing payee", () => {
    expect(signPaymentSchema.safeParse({ amount: "1.00" }).success).toBe(false);
  });

  it("rejects missing amount", () => {
    expect(signPaymentSchema.safeParse({ payee: "GABC" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createTalosSchema — stellarAssetCode validation
// ---------------------------------------------------------------------------
describe("createTalosSchema — stellarAssetCode", () => {
  const minimal = {
    name: "Test Agent",
    category: "Development",
    description: "A test agent",
    creatorPublicKey: "GABC",
    signature: "sig",
    message: "msg",
  };

  it("accepts null stellarAssetCode", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts omitted stellarAssetCode", () => {
    const result = createTalosSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it("accepts valid CODE:ISSUER format", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: `MITOS:${VALID_ISSUER_A}`,
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty string (treated as omitted)", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: "",
    });
    expect(result.success).toBe(true);
  });

  it("rejects code-only string (no issuer)", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: "MITOS",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CODE: with invalid issuer checksum", () => {
    const badIssuer = VALID_ISSUER_A.slice(0, -1) + "A";
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: `MITOS:${badIssuer}`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects lowercase code in CODE:ISSUER", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: `mitos:${VALID_ISSUER_A}`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects code longer than 12 chars in CODE:ISSUER", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: `ABCDEFGHIJKLM:${VALID_ISSUER_A}`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects code with special characters in CODE:ISSUER", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: `MI-TOS:${VALID_ISSUER_A}`,
    });
    expect(result.success).toBe(false);
  });

  it("rejects random non-matching string", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: "just-a-code",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CODE: with too-short issuer", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: "MITOS:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3",
    });
    expect(result.success).toBe(false);
  });

  it("rejects CODE: with non-base32 issuer", () => {
    const result = createTalosSchema.safeParse({
      ...minimal,
      stellarAssetCode: "MITOS:G0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0O0",
    });
    expect(result.success).toBe(false);
  });
});
