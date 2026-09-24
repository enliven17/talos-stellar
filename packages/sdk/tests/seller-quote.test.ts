import { describe, expect, it } from "vitest";
import {
  DEFAULT_SELLER_QUOTE_TTL_SECONDS,
  SellerQuoteError,
  constructSellerPaymentDetails,
  constructSellerQuote,
  toCanonicalDecimalAmount,
} from "../src/seller-quote.js";
import { verifyQuoteNotExpired, validateQuote } from "../src/a2a-validation.js";

const PROVIDER =
  "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";
const FIXED_NOW = new Date("2026-06-15T12:00:00.000Z");

describe("toCanonicalDecimalAmount", () => {
  it("accepts canonical six-digit strings", () => {
    expect(toCanonicalDecimalAmount("1.500000")).toBe("1.500000");
  });

  it("pads shorter decimals and integers", () => {
    expect(toCanonicalDecimalAmount("1.5")).toBe("1.500000");
    expect(toCanonicalDecimalAmount(2)).toBe("2.000000");
    expect(toCanonicalDecimalAmount("10")).toBe("10.000000");
  });

  it("rejects zero, negative, empty, and malformed", () => {
    expect(toCanonicalDecimalAmount(0)).toBeNull();
    expect(toCanonicalDecimalAmount("0.000000")).toBeNull();
    expect(toCanonicalDecimalAmount(-1)).toBeNull();
    expect(toCanonicalDecimalAmount("")).toBeNull();
    expect(toCanonicalDecimalAmount("abc")).toBeNull();
    expect(toCanonicalDecimalAmount(Number.NaN)).toBeNull();
  });
});

describe("constructSellerQuote", () => {
  it("builds a valid typed quote with defaults (positive)", () => {
    const quote = constructSellerQuote({
      providerId: PROVIDER,
      amount: 1.5,
      now: FIXED_NOW,
      ttlSeconds: 600,
    });

    expect(quote).toEqual({
      providerId: PROVIDER,
      assetCode: "USDC",
      network: "stellar",
      amount: "1.500000",
      expiresAt: "2026-06-15T12:10:00.000Z",
    });
    expect(validateQuote(quote)).toEqual([]);
    expect(verifyQuoteNotExpired(quote)).toBe(true);
  });

  it("uses default TTL when neither expiresAt nor ttlSeconds set", () => {
    const quote = constructSellerQuote({
      providerId: PROVIDER,
      amount: "3.000000",
      now: FIXED_NOW,
    });
    const expected = new Date(
      FIXED_NOW.getTime() + DEFAULT_SELLER_QUOTE_TTL_SECONDS * 1000,
    ).toISOString();
    expect(quote.expiresAt).toBe(expected);
  });

  it("prefers absolute expiresAt over ttlSeconds", () => {
    const quote = constructSellerQuote({
      providerId: PROVIDER,
      amount: "1.000000",
      expiresAt: "2026-06-15T18:00:00.000Z",
      ttlSeconds: 60,
      now: FIXED_NOW,
      quoteId: "q-1",
    });
    expect(quote.expiresAt).toBe("2026-06-15T18:00:00.000Z");
    expect(quote.quoteId).toBe("q-1");
  });

  it("rejects missing providerId", () => {
    expect(() =>
      constructSellerQuote({ providerId: "  ", amount: 1, now: FIXED_NOW }),
    ).toThrow(SellerQuoteError);
    try {
      constructSellerQuote({ providerId: "", amount: 1, now: FIXED_NOW });
    } catch (err) {
      expect(err).toBeInstanceOf(SellerQuoteError);
      expect((err as SellerQuoteError).code).toBe("MISSING_PROVIDER_ID");
      expect(JSON.stringify(err)).not.toMatch(/secret|seed|proof/i);
    }
  });

  it("rejects invalid provider for network", () => {
    try {
      constructSellerQuote({
        providerId: "not-a-key",
        amount: 1,
        network: "stellar",
        now: FIXED_NOW,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SellerQuoteError);
      expect((err as SellerQuoteError).code).toBe("INVALID_PROVIDER_ID");
    }
  });

  it("rejects malformed amount", () => {
    expect(() =>
      constructSellerQuote({
        providerId: PROVIDER,
        amount: "nope",
        now: FIXED_NOW,
      }),
    ).toThrow(/amount/i);
  });

  it("rejects non-positive ttlSeconds", () => {
    try {
      constructSellerQuote({
        providerId: PROVIDER,
        amount: 1,
        ttlSeconds: 0,
        now: FIXED_NOW,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SellerQuoteError).code).toBe("INVALID_TTL");
    }
  });

  it("rejects expiry at the boundary instant (now == expiresAt)", () => {
    try {
      constructSellerQuote({
        providerId: PROVIDER,
        amount: 1,
        expiresAt: FIXED_NOW.toISOString(),
        now: FIXED_NOW,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SellerQuoteError).code).toBe("EXPIRED_QUOTE");
    }
  });

  it("rejects past expiresAt", () => {
    try {
      constructSellerQuote({
        providerId: PROVIDER,
        amount: 1,
        expiresAt: "2020-01-01T00:00:00.000Z",
        now: FIXED_NOW,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SellerQuoteError).code).toBe("EXPIRED_QUOTE");
    }
  });

  it("rejects invalid signature without echoing it", () => {
    const badSig = "NOT_A_SIGNATURE_OR_SECRET_VALUE_XXXXXXXXXXXXXXXXXXXX";
    try {
      constructSellerQuote({
        providerId: PROVIDER,
        amount: 1,
        signature: badSig,
        now: FIXED_NOW,
        ttlSeconds: 120,
      });
      expect.unreachable();
    } catch (err) {
      expect((err as SellerQuoteError).code).toBe("INVALID_SIGNATURE");
      expect((err as Error).message).not.toContain(badSig);
      expect(JSON.stringify(err)).not.toContain(badSig);
    }
  });

  it("accepts a valid optional signature", () => {
    const sig = "a".repeat(64);
    const quote = constructSellerQuote({
      providerId: PROVIDER,
      amount: "1.000000",
      signature: sig,
      now: FIXED_NOW,
      ttlSeconds: 120,
    });
    expect(quote.signature).toBe(sig);
  });
});

describe("constructSellerPaymentDetails", () => {
  it("nests the typed quote and defaults payee to providerId", () => {
    const details = constructSellerPaymentDetails({
      providerId: PROVIDER,
      amount: "2.500000",
      now: FIXED_NOW,
      ttlSeconds: 300,
      serviceName: "analytics",
      talosId: "talos-1",
    });

    expect(details.payee).toBe(PROVIDER);
    expect(details.price).toBe(2.5);
    expect(details.currency).toBe("USDC");
    expect(details.assetCode).toBe("USDC");
    expect(details.serviceName).toBe("analytics");
    expect(details.talosId).toBe("talos-1");
    expect(details.quote.amount).toBe("2.500000");
    expect(details.expiresAt).toBe(details.quote.expiresAt);
    expect(details.quote.expiresAt).toBe("2026-06-15T12:05:00.000Z");
  });

  it("allows an explicit payee override", () => {
    const payeeOk = "G" + "B".repeat(55);
    const details = constructSellerPaymentDetails({
      providerId: PROVIDER,
      payee: payeeOk,
      amount: 1,
      now: FIXED_NOW,
      ttlSeconds: 60,
    });
    expect(details.payee).toBe(payeeOk);
    expect(details.quote.providerId).toBe(PROVIDER);
  });
});
