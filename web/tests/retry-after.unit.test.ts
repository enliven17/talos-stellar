import { afterEach, describe, expect, it } from "vitest";
import {
  ABSOLUTE_MAX_RETRY_AFTER_SECONDS,
  DEFAULT_MAX_RETRY_AFTER_SECONDS,
  DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
  MAX_VALID_EPOCH_MS,
  MIN_RETRY_AFTER_SECONDS,
  computeRetryAfterSeconds,
  formatResetEpochSeconds,
  formatResetIsoString,
  isValidResetAt,
  resolveMaxRetryAfterSeconds,
  resolveUnknownResetRetryAfterSeconds,
} from "@/lib/retry-after";

const ORIGINAL_MAX_ENV = process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
const ORIGINAL_UNKNOWN_ENV = process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;

afterEach(() => {
  if (ORIGINAL_MAX_ENV === undefined) {
    delete process.env.QUOTA_MAX_RETRY_AFTER_SECONDS;
  } else {
    process.env.QUOTA_MAX_RETRY_AFTER_SECONDS = ORIGINAL_MAX_ENV;
  }

  if (ORIGINAL_UNKNOWN_ENV === undefined) {
    delete process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS;
  } else {
    process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS = ORIGINAL_UNKNOWN_ENV;
  }
});

describe("resolveMaxRetryAfterSeconds", () => {
  it("returns default 3600 when unset", () => {
    expect(resolveMaxRetryAfterSeconds({})).toBe(DEFAULT_MAX_RETRY_AFTER_SECONDS);
    expect(DEFAULT_MAX_RETRY_AFTER_SECONDS).toBe(3_600);
  });

  it("accepts valid boundaries and trimmed integer values", () => {
    expect(resolveMaxRetryAfterSeconds({ QUOTA_MAX_RETRY_AFTER_SECONDS: "1" })).toBe(1);
    expect(
      resolveMaxRetryAfterSeconds({
        QUOTA_MAX_RETRY_AFTER_SECONDS: String(ABSOLUTE_MAX_RETRY_AFTER_SECONDS),
      }),
    ).toBe(86_400);
    expect(resolveMaxRetryAfterSeconds({ QUOTA_MAX_RETRY_AFTER_SECONDS: " 120 " })).toBe(120);
  });

  it.each(["", "   ", "0", "-5", "1.5", "60s", "NaN", "Infinity", "86401", "99999999999999999999"])(
    "falls back to default for invalid value %j",
    (raw) => {
      expect(resolveMaxRetryAfterSeconds({ QUOTA_MAX_RETRY_AFTER_SECONDS: raw })).toBe(
        DEFAULT_MAX_RETRY_AFTER_SECONDS,
      );
    },
  );
});

describe("resolveUnknownResetRetryAfterSeconds", () => {
  it("returns default 60 when unset", () => {
    expect(resolveUnknownResetRetryAfterSeconds({})).toBe(
      DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
    );
    expect(DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS).toBe(60);
  });

  it("accepts valid boundaries and trimmed integer values", () => {
    expect(
      resolveUnknownResetRetryAfterSeconds({ QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS: "1" }),
    ).toBe(1);
    expect(
      resolveUnknownResetRetryAfterSeconds({
        QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS: String(ABSOLUTE_MAX_RETRY_AFTER_SECONDS),
      }),
    ).toBe(86_400);
    expect(
      resolveUnknownResetRetryAfterSeconds({ QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS: " 45 " }),
    ).toBe(45);
  });

  it.each(["", "   ", "0", "-5", "1.5", "60s", "NaN", "Infinity", "86401"])(
    "falls back to default for invalid value %j",
    (raw) => {
      expect(
        resolveUnknownResetRetryAfterSeconds({ QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS: raw }),
      ).toBe(DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS);
    },
  );
});

describe("isValidResetAt & formatting helpers", () => {
  it("accepts finite positive epoch ms within ECMAScript Date range", () => {
    expect(isValidResetAt(1)).toBe(true);
    expect(isValidResetAt(1_753_401_600_000)).toBe(true);
    expect(isValidResetAt(MAX_VALID_EPOCH_MS)).toBe(true);
  });

  it.each([
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    -5_000,
    Number.MAX_SAFE_INTEGER,
    MAX_VALID_EPOCH_MS + 1,
    "1753401600000",
    {},
  ])("rejects invalid resetAt %p", (value) => {
    expect(isValidResetAt(value)).toBe(false);
    expect(formatResetEpochSeconds(value)).toBeNull();
    expect(formatResetIsoString(value)).toBeNull();
  });

  it("formats valid resetAt values into seconds and ISO strings", () => {
    expect(formatResetEpochSeconds(1)).toBe("1");
    expect(formatResetEpochSeconds(1_753_401_600_000)).toBe("1753401600");
    expect(formatResetIsoString(1_753_401_600_000)).toBe("2025-07-25T00:00:00.000Z");
    expect(formatResetIsoString(MAX_VALID_EPOCH_MS)).toBe(
      new Date(MAX_VALID_EPOCH_MS).toISOString(),
    );
  });
});

describe("computeRetryAfterSeconds", () => {
  const nowMs = 1_753_350_000_000;

  it("computes rounded-up whole seconds within cap", () => {
    expect(computeRetryAfterSeconds(nowMs + 100, { nowMs, env: {} })).toBe(1);
    expect(computeRetryAfterSeconds(nowMs + 45_000, { nowMs, env: {} })).toBe(45);
    expect(computeRetryAfterSeconds(nowMs + 45_001, { nowMs, env: {} })).toBe(46);
    expect(computeRetryAfterSeconds(nowMs + 3_600_000, { nowMs, env: {} })).toBe(3_600);
  });

  it("caps long daily, monthly, and far-future reset delays at 3600s by default", () => {
    const twentyHoursMs = 20 * 60 * 60 * 1_000;
    const thirtyOneDaysMs = 31 * 24 * 60 * 60 * 1_000;

    expect(computeRetryAfterSeconds(nowMs + twentyHoursMs, { nowMs, env: {} })).toBe(3_600);
    expect(computeRetryAfterSeconds(nowMs + thirtyOneDaysMs, { nowMs, env: {} })).toBe(3_600);
    expect(computeRetryAfterSeconds(MAX_VALID_EPOCH_MS, { nowMs, env: {} })).toBe(3_600);
  });

  it("honors explicit options cap and clamps it at the 86400s hard ceiling", () => {
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1_000;

    expect(
      computeRetryAfterSeconds(nowMs + thirtyDaysMs, {
        nowMs,
        maxRetryAfterSeconds: 300,
        env: {},
      }),
    ).toBe(300);
    expect(
      computeRetryAfterSeconds(nowMs + thirtyDaysMs, {
        nowMs,
        maxRetryAfterSeconds: 120.9,
        env: {},
      }),
    ).toBe(120);
    expect(
      computeRetryAfterSeconds(nowMs + thirtyDaysMs, {
        nowMs,
        maxRetryAfterSeconds: 100_000,
        env: {},
      }),
    ).toBe(86_400);
    // Invalid option values fall back to env/default
    expect(
      computeRetryAfterSeconds(nowMs + thirtyDaysMs, {
        nowMs,
        maxRetryAfterSeconds: 0,
        env: { QUOTA_MAX_RETRY_AFTER_SECONDS: "180" },
      }),
    ).toBe(180);
    expect(
      computeRetryAfterSeconds(nowMs + thirtyDaysMs, {
        nowMs,
        maxRetryAfterSeconds: Number.NaN,
        env: {},
      }),
    ).toBe(3_600);
  });

  it("reads QUOTA_MAX_RETRY_AFTER_SECONDS and QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS from process.env", () => {
    process.env.QUOTA_MAX_RETRY_AFTER_SECONDS = "15";
    process.env.QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS = "45";

    expect(computeRetryAfterSeconds(nowMs + 120_000, { nowMs })).toBe(15);
    expect(computeRetryAfterSeconds(null)).toBe(15);
  });

  it("clamps valid past or current reset timestamps to 1 second", () => {
    expect(computeRetryAfterSeconds(nowMs - 5_000, { nowMs, env: {} })).toBe(
      MIN_RETRY_AFTER_SECONDS,
    );
    expect(computeRetryAfterSeconds(nowMs, { nowMs, env: {} })).toBe(MIN_RETRY_AFTER_SECONDS);
    expect(computeRetryAfterSeconds(1, { nowMs, env: {} })).toBe(MIN_RETRY_AFTER_SECONDS);
  });

  it.each([
    undefined,
    null,
    NaN,
    Infinity,
    -Infinity,
    0,
    -1,
    -5_000,
    Number.MAX_SAFE_INTEGER,
    MAX_VALID_EPOCH_MS + 1,
    "not-a-timestamp",
  ])("returns finite fallback delay for unknown/invalid resetAt %p", (badResetAt) => {
    expect(computeRetryAfterSeconds(badResetAt, { nowMs, env: {} })).toBe(
      DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS,
    );
  });

  it("caps unknown-reset fallback by maxRetryAfterSeconds", () => {
    expect(
      computeRetryAfterSeconds(null, {
        nowMs,
        maxRetryAfterSeconds: 30,
        unknownResetRetryAfterSeconds: 120,
        env: {},
      }),
    ).toBe(30);
    expect(
      computeRetryAfterSeconds(Number.NaN, {
        nowMs,
        env: {
          QUOTA_MAX_RETRY_AFTER_SECONDS: "15",
          QUOTA_UNKNOWN_RESET_RETRY_AFTER_SECONDS: "90",
        },
      }),
    ).toBe(15);
  });

  it("handles invalid or extreme nowMs safely without producing NaN or Infinity", () => {
    const validReset = Date.now() + 25_000;
    const fromNaN = computeRetryAfterSeconds(validReset, { nowMs: Number.NaN, env: {} });
    expect(Number.isFinite(fromNaN)).toBe(true);
    expect(fromNaN).toBeGreaterThanOrEqual(1);
    expect(fromNaN).toBeLessThanOrEqual(3_600);

    expect(computeRetryAfterSeconds(validReset, { nowMs: -Number.MAX_VALUE, env: {} })).toBe(
      DEFAULT_MAX_RETRY_AFTER_SECONDS,
    );
  });
});
