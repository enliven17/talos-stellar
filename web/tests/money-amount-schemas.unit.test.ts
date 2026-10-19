/**
 * Unit tests for the shared money-amount Zod helpers and the schemas
 * they are applied to.
 *
 * Covers:
 *  - moneyAmountNumber and moneyAmountString helpers (valid + invalid)
 *  - reportRevenueSchema.amount
 *  - recordDividendSchema.amount
 *  - signPaymentSchema.amount
 *  - buyTokenSchema.amount
 */

import { describe, it, expect } from "vitest";
import {
  moneyAmountNumber,
  moneyAmountString,
  MAX_MONEY_AMOUNT,
  reportRevenueSchema,
  recordDividendSchema,
  signPaymentSchema,
  buyTokenSchema,
} from "../src/lib/schemas";

// ── moneyAmountNumber ──────────────────────────────────────────────────────────

describe("moneyAmountNumber", () => {
  // ── valid ──
  it("accepts a small positive integer", () => {
    expect(moneyAmountNumber.safeParse(1).success).toBe(true);
  });

  it("accepts the maximum valid integer (10^12 - 1)", () => {
    expect(moneyAmountNumber.safeParse(999_999_999_999).success).toBe(true);
  });

  it("accepts a value with exactly 6 decimal places", () => {
    expect(moneyAmountNumber.safeParse(1.000001).success).toBe(true);
  });

  it("accepts a typical commerce amount", () => {
    expect(moneyAmountNumber.safeParse(250.5).success).toBe(true);
  });

  // ── invalid: zero / negative ──
  it("rejects zero", () => {
    expect(moneyAmountNumber.safeParse(0).success).toBe(false);
  });

  it("rejects a negative number", () => {
    expect(moneyAmountNumber.safeParse(-1).success).toBe(false);
  });

  // ── invalid: above max ──
  it("rejects 10^12 (exclusive upper bound)", () => {
    expect(moneyAmountNumber.safeParse(MAX_MONEY_AMOUNT).success).toBe(false);
  });

  it("rejects a value well above the limit", () => {
    expect(moneyAmountNumber.safeParse(9_999_999_999_999).success).toBe(false);
  });

  // ── invalid: too many decimals ──
  it("rejects 7 decimal places", () => {
    // 1.0000001 — 7 d.p.
    expect(moneyAmountNumber.safeParse(1.0000001).success).toBe(false);
  });

  // ── invalid: NaN / Infinity ──
  it("rejects NaN", () => {
    expect(moneyAmountNumber.safeParse(NaN).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(moneyAmountNumber.safeParse(Infinity).success).toBe(false);
  });

  it("rejects -Infinity", () => {
    expect(moneyAmountNumber.safeParse(-Infinity).success).toBe(false);
  });
});

// ── moneyAmountString ─────────────────────────────────────────────────────────

describe("moneyAmountString", () => {
  // ── valid ──
  it("accepts a simple numeric string", () => {
    expect(moneyAmountString.safeParse("1").success).toBe(true);
  });

  it("accepts the near-maximum boundary", () => {
    expect(moneyAmountString.safeParse("999999999999.999999").success).toBe(true);
  });

  it("accepts exactly 6 decimal places", () => {
    expect(moneyAmountString.safeParse("10.123456").success).toBe(true);
  });

  it("accepts an integer string with no decimal point", () => {
    expect(moneyAmountString.safeParse("500").success).toBe(true);
  });

  it("accepts a decimal string like '25.5'", () => {
    expect(moneyAmountString.safeParse("25.5").success).toBe(true);
  });

  // ── invalid: zero / negative ──
  it("rejects '0'", () => {
    expect(moneyAmountString.safeParse("0").success).toBe(false);
  });

  it("rejects '-5'", () => {
    expect(moneyAmountString.safeParse("-5").success).toBe(false);
  });

  it("rejects '0.000000' (exactly zero with decimals)", () => {
    expect(moneyAmountString.safeParse("0.000000").success).toBe(false);
  });

  // ── invalid: above max ──
  it("rejects a string equal to MAX_MONEY_AMOUNT", () => {
    expect(moneyAmountString.safeParse(String(MAX_MONEY_AMOUNT)).success).toBe(false);
  });

  it("rejects '9999999999999' (13-digit integer)", () => {
    expect(moneyAmountString.safeParse("9999999999999").success).toBe(false);
  });

  // ── invalid: too many decimals ──
  it("rejects 7 decimal places", () => {
    expect(moneyAmountString.safeParse("1.0000001").success).toBe(false);
  });

  // ── invalid: exponent / scientific notation ──
  it("rejects '1e6' (scientific notation)", () => {
    expect(moneyAmountString.safeParse("1e6").success).toBe(false);
  });

  it("rejects '1E-7' (negative exponent)", () => {
    expect(moneyAmountString.safeParse("1E-7").success).toBe(false);
  });

  it("rejects '1.5e2'", () => {
    expect(moneyAmountString.safeParse("1.5e2").success).toBe(false);
  });

  // ── invalid: empty / garbage ──
  it("rejects empty string", () => {
    expect(moneyAmountString.safeParse("").success).toBe(false);
  });

  it("rejects 'abc'", () => {
    expect(moneyAmountString.safeParse("abc").success).toBe(false);
  });

  it("rejects 'NaN'", () => {
    expect(moneyAmountString.safeParse("NaN").success).toBe(false);
  });

  it("rejects 'Infinity'", () => {
    expect(moneyAmountString.safeParse("Infinity").success).toBe(false);
  });
});

// ── Schema-level tests ────────────────────────────────────────────────────────

const BASE_REVENUE = { source: "commerce" };
const BASE_DIVIDEND = {};
const BASE_SIGN = { payee: "GPAYEE" };
const BASE_BUY = { buyerPublicKey: "GBUYER" };

// ── reportRevenueSchema ──

describe("reportRevenueSchema.amount", () => {
  it("accepts valid string amount", () => {
    expect(reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: "100" }).success).toBe(true);
  });

  it("accepts valid numeric amount", () => {
    expect(reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: 100 }).success).toBe(true);
  });

  it("rejects oversized string amount", () => {
    const r = reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: "1000000000001" });
    expect(r.success).toBe(false);
  });

  it("rejects oversized numeric amount", () => {
    const r = reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: 1_000_000_000_001 });
    expect(r.success).toBe(false);
  });

  it("rejects 7-decimal string amount", () => {
    const r = reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: "1.0000001" });
    expect(r.success).toBe(false);
  });

  it("rejects zero string amount", () => {
    const r = reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects scientific notation string", () => {
    const r = reportRevenueSchema.safeParse({ ...BASE_REVENUE, amount: "1e7" });
    expect(r.success).toBe(false);
  });
});

// ── recordDividendSchema ──

describe("recordDividendSchema.amount", () => {
  it("accepts valid string amount", () => {
    expect(recordDividendSchema.safeParse({ ...BASE_DIVIDEND, amount: "12.5" }).success).toBe(true);
  });

  it("accepts valid numeric amount", () => {
    expect(recordDividendSchema.safeParse({ ...BASE_DIVIDEND, amount: 12.5 }).success).toBe(true);
  });

  it("rejects oversized string amount", () => {
    const r = recordDividendSchema.safeParse({ ...BASE_DIVIDEND, amount: "1000000000001" });
    expect(r.success).toBe(false);
  });

  it("rejects oversized numeric amount", () => {
    const r = recordDividendSchema.safeParse({ ...BASE_DIVIDEND, amount: 1_000_000_000_001 });
    expect(r.success).toBe(false);
  });

  it("rejects 7-decimal string amount", () => {
    const r = recordDividendSchema.safeParse({ ...BASE_DIVIDEND, amount: "1.0000001" });
    expect(r.success).toBe(false);
  });

  it("rejects non-positive numeric amount", () => {
    const r = recordDividendSchema.safeParse({ ...BASE_DIVIDEND, amount: 0 });
    expect(r.success).toBe(false);
  });
});

// ── signPaymentSchema ──

describe("signPaymentSchema.amount", () => {
  it("accepts valid string amount", () => {
    expect(signPaymentSchema.safeParse({ ...BASE_SIGN, amount: "5.00" }).success).toBe(true);
  });

  it("accepts valid numeric amount", () => {
    expect(signPaymentSchema.safeParse({ ...BASE_SIGN, amount: 5 }).success).toBe(true);
  });

  it("rejects oversized string amount", () => {
    const r = signPaymentSchema.safeParse({ ...BASE_SIGN, amount: "1000000000001" });
    expect(r.success).toBe(false);
  });

  it("rejects oversized numeric amount", () => {
    const r = signPaymentSchema.safeParse({ ...BASE_SIGN, amount: 1_000_000_000_001 });
    expect(r.success).toBe(false);
  });

  it("rejects 7-decimal string amount", () => {
    const r = signPaymentSchema.safeParse({ ...BASE_SIGN, amount: "1.0000001" });
    expect(r.success).toBe(false);
  });

  it("rejects non-positive string amount", () => {
    const r = signPaymentSchema.safeParse({ ...BASE_SIGN, amount: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects scientific notation", () => {
    const r = signPaymentSchema.safeParse({ ...BASE_SIGN, amount: "1e7" });
    expect(r.success).toBe(false);
  });
});

// ── buyTokenSchema ──

describe("buyTokenSchema.amount", () => {
  it("accepts a valid positive integer", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: 10 }).success).toBe(true);
  });

  it("accepts the boundary value just below MAX_MONEY_AMOUNT", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: 999_999_999_999 }).success).toBe(true);
  });

  it("accepts 6 decimal places", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: 1.000001 }).success).toBe(true);
  });

  it("rejects zero", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: 0 }).success).toBe(false);
  });

  it("rejects negative", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: -1 }).success).toBe(false);
  });

  it("rejects MAX_MONEY_AMOUNT exactly (exclusive bound)", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: MAX_MONEY_AMOUNT }).success).toBe(false);
  });

  it("rejects above max", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: 9_999_999_999_999 }).success).toBe(false);
  });

  it("rejects NaN", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: NaN }).success).toBe(false);
  });

  it("rejects Infinity", () => {
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: Infinity }).success).toBe(false);
  });

  it("rejects 7 decimal places", () => {
    // 1.0000001 has 7 d.p.
    expect(buyTokenSchema.safeParse({ ...BASE_BUY, amount: 1.0000001 }).success).toBe(false);
  });
});
