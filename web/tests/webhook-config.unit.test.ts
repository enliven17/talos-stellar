import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  parsePositiveIntEnv,
  DEFAULT_MAX_ATTEMPTS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  DELIVERY_TIMEOUT_MS,
  MAX_PAYLOAD_BYTES,
  DEFAULT_LEASE_TTL_SECONDS,
  HEARTBEAT_EXTEND_SECONDS,
  DEFAULT_SECRET_ROTATION_GRACE_SECONDS,
  MIN_SECRET_ROTATION_GRACE_SECONDS,
  MAX_SECRET_ROTATION_GRACE_SECONDS,
} from "@/lib/webhooks/config";

const WEBHOOK_ENV_VARS = [
  "WEBHOOK_DEFAULT_MAX_ATTEMPTS",
  "WEBHOOK_BACKOFF_BASE_MS",
  "WEBHOOK_BACKOFF_MAX_MS",
  "WEBHOOK_DELIVERY_TIMEOUT_MS",
  "WEBHOOK_MAX_PAYLOAD_BYTES",
  "WEBHOOK_LEASE_TTL_SECONDS",
  "WEBHOOK_HEARTBEAT_EXTEND_SECONDS",
  "WEBHOOK_SECRET_ROTATION_GRACE_SECONDS",
] as const;

describe("parsePositiveIntEnv helper", () => {
  const TEST_KEY = "TEST_NUMERIC_ENV_VAR";

  beforeEach(() => {
    delete process.env[TEST_KEY];
  });

  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  describe("absent or empty env vars → default value", () => {
    it("returns defaultValue when env var is unset", () => {
      expect(parsePositiveIntEnv(TEST_KEY, 42)).toBe(42);
    });

    it("returns defaultValue when env var is empty string", () => {
      process.env[TEST_KEY] = "";
      expect(parsePositiveIntEnv(TEST_KEY, 42)).toBe(42);
    });
  });

  describe("valid positive integers", () => {
    const validCases: Array<[string, number, number]> = [
      ["1", 10, 1],
      ["5", 10, 5],
      ["42", 10, 42],
      ["1000", 10, 1000],
      ["+50", 10, 50],
      ["  100  ", 10, 100],
    ];

    it.each(validCases)(
      'parses "%s" with default %i to %i',
      (raw, def, expected) => {
        process.env[TEST_KEY] = raw;
        expect(parsePositiveIntEnv(TEST_KEY, def)).toBe(expected);
      },
    );
  });

  describe("invalid non-numeric values → fail fast (throws Error)", () => {
    const invalidCases = [
      "1s", // Common typo mentioned in issue #989
      "100ms",
      "5m",
      "abc",
      "foo",
      "1.5",
      "0.5",
      "1.0",
      "NaN",
      "Infinity",
      "-Infinity",
      "0x10",
      "0o10",
      "0b10",
      "1e3",
      "   ",
      "true",
      "false",
      "null",
      "undefined",
    ];

    it.each(invalidCases)('throws Error for invalid value "%s"', (raw) => {
      process.env[TEST_KEY] = raw;
      expect(() => parsePositiveIntEnv(TEST_KEY, 10)).toThrow(
        /must be a positive integer/,
      );
    });
  });

  describe("negative values and zero → fail fast (throws Error)", () => {
    const nonPositiveCases = ["0", "-1", "-5", "-1000", "-0"];

    it.each(nonPositiveCases)(
      'throws Error for non-positive value "%s"',
      (raw) => {
        process.env[TEST_KEY] = raw;
        expect(() => parsePositiveIntEnv(TEST_KEY, 10)).toThrow(
          /must be a positive integer/,
        );
      },
    );
  });

  describe("boundary options (min and max constraints)", () => {
    it("respects custom min bound", () => {
      process.env[TEST_KEY] = "299";
      expect(() =>
        parsePositiveIntEnv(TEST_KEY, 500, { min: 300 }),
      ).toThrow(/must be a positive integer/);

      process.env[TEST_KEY] = "300";
      expect(parsePositiveIntEnv(TEST_KEY, 500, { min: 300 })).toBe(300);
    });

    it("respects custom max bound", () => {
      process.env[TEST_KEY] = "101";
      expect(() =>
        parsePositiveIntEnv(TEST_KEY, 50, { max: 100 }),
      ).toThrow(/must be a positive integer/);

      process.env[TEST_KEY] = "100";
      expect(parsePositiveIntEnv(TEST_KEY, 50, { max: 100 })).toBe(100);
    });

    it("accepts values strictly within [min, max]", () => {
      process.env[TEST_KEY] = "500";
      expect(
        parsePositiveIntEnv(TEST_KEY, 1000, { min: 300, max: 2_592_000 }),
      ).toBe(500);
    });
  });

  describe("huge values → fail fast (throws Error)", () => {
    const hugeCases = [
      "999999999999999999999999999999", // Exceeds safe integer
      String(Number.MAX_SAFE_INTEGER + 1),
      "10000000000000000", // 1e16 > MAX_SAFE_INTEGER
    ];

    it.each(hugeCases)('throws Error for huge value "%s"', (raw) => {
      process.env[TEST_KEY] = raw;
      expect(() => parsePositiveIntEnv(TEST_KEY, 10)).toThrow(
        /must be a positive integer/,
      );
    });

    it("throws Error when value exceeds explicit max option", () => {
      process.env[TEST_KEY] = "5000000";
      expect(() =>
        parsePositiveIntEnv(TEST_KEY, 86400, {
          min: 300,
          max: 2_592_000,
        }),
      ).toThrow(/must be a positive integer/);
    });
  });

  describe("onError: fallback mode", () => {
    it("logs a warning and returns defaultValue on invalid value", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env[TEST_KEY] = "1s";

      const result = parsePositiveIntEnv(TEST_KEY, 1000, {
        onError: "fallback",
      });
      expect(result).toBe(1000);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `[webhooks] Invalid value for ${TEST_KEY}: "1s"`,
        ),
      );
      warnSpy.mockRestore();
    });

    it("logs a warning and returns defaultValue on negative value", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env[TEST_KEY] = "-10";

      const result = parsePositiveIntEnv(TEST_KEY, 5, {
        onError: "fallback",
      });
      expect(result).toBe(5);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("logs a warning and returns defaultValue on out-of-bounds huge value", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      process.env[TEST_KEY] = "999999";

      const result = parsePositiveIntEnv(TEST_KEY, 50, {
        max: 100,
        onError: "fallback",
      });
      expect(result).toBe(50);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });
});

describe("Webhook configuration module evaluation", () => {
  beforeEach(() => {
    for (const key of WEBHOOK_ENV_VARS) {
      delete process.env[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const key of WEBHOOK_ENV_VARS) {
      delete process.env[key];
    }
  });

  describe("default configuration values", () => {
    it("preserves all documented default values when env vars are unset", () => {
      expect(DEFAULT_MAX_ATTEMPTS).toBe(5);
      expect(BACKOFF_BASE_MS).toBe(1_000);
      expect(BACKOFF_MAX_MS).toBe(60_000);
      expect(DELIVERY_TIMEOUT_MS).toBe(10_000);
      expect(MAX_PAYLOAD_BYTES).toBe(64_000);
      expect(DEFAULT_LEASE_TTL_SECONDS).toBe(300);
      expect(HEARTBEAT_EXTEND_SECONDS).toBe(300);
      expect(DEFAULT_SECRET_ROTATION_GRACE_SECONDS).toBe(86_400);
      expect(MIN_SECRET_ROTATION_GRACE_SECONDS).toBe(300);
      expect(MAX_SECRET_ROTATION_GRACE_SECONDS).toBe(2_592_000);
    });

    it("ensures no defaults are NaN", () => {
      const numericSettings = [
        DEFAULT_MAX_ATTEMPTS,
        BACKOFF_BASE_MS,
        BACKOFF_MAX_MS,
        DELIVERY_TIMEOUT_MS,
        MAX_PAYLOAD_BYTES,
        DEFAULT_LEASE_TTL_SECONDS,
        HEARTBEAT_EXTEND_SECONDS,
        DEFAULT_SECRET_ROTATION_GRACE_SECONDS,
      ];

      for (const val of numericSettings) {
        expect(Number.isNaN(val)).toBe(false);
        expect(Number.isFinite(val)).toBe(true);
        expect(val).toBeGreaterThan(0);
      }
    });
  });

  describe("valid environment variable overrides", () => {
    it("dynamically loads valid numeric overrides from env vars", async () => {
      process.env.WEBHOOK_DEFAULT_MAX_ATTEMPTS = "10";
      process.env.WEBHOOK_BACKOFF_BASE_MS = "2000";
      process.env.WEBHOOK_BACKOFF_MAX_MS = "120000";
      process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = "15000";
      process.env.WEBHOOK_MAX_PAYLOAD_BYTES = "128000";
      process.env.WEBHOOK_LEASE_TTL_SECONDS = "600";
      process.env.WEBHOOK_HEARTBEAT_EXTEND_SECONDS = "450";
      process.env.WEBHOOK_SECRET_ROTATION_GRACE_SECONDS = "172800";

      const mod = await import("@/lib/webhooks/config");
      expect(mod.DEFAULT_MAX_ATTEMPTS).toBe(10);
      expect(mod.BACKOFF_BASE_MS).toBe(2000);
      expect(mod.BACKOFF_MAX_MS).toBe(120000);
      expect(mod.DELIVERY_TIMEOUT_MS).toBe(15000);
      expect(mod.MAX_PAYLOAD_BYTES).toBe(128000);
      expect(mod.DEFAULT_LEASE_TTL_SECONDS).toBe(600);
      expect(mod.HEARTBEAT_EXTEND_SECONDS).toBe(450);
      expect(mod.DEFAULT_SECRET_ROTATION_GRACE_SECONDS).toBe(172800);
    });
  });

  describe("invalid / negative / huge env vars fail fast at startup", () => {
    it("throws at startup when WEBHOOK_BACKOFF_BASE_MS is a typo string like '1s'", async () => {
      process.env.WEBHOOK_BACKOFF_BASE_MS = "1s";
      await expect(import("@/lib/webhooks/config")).rejects.toThrow(
        /Invalid value for WEBHOOK_BACKOFF_BASE_MS: "1s"/,
      );
    });

    it("throws at startup when WEBHOOK_DEFAULT_MAX_ATTEMPTS is negative", async () => {
      process.env.WEBHOOK_DEFAULT_MAX_ATTEMPTS = "-1";
      await expect(import("@/lib/webhooks/config")).rejects.toThrow(
        /Invalid value for WEBHOOK_DEFAULT_MAX_ATTEMPTS: "-1"/,
      );
    });

    it("throws at startup when WEBHOOK_DEFAULT_MAX_ATTEMPTS is zero", async () => {
      process.env.WEBHOOK_DEFAULT_MAX_ATTEMPTS = "0";
      await expect(import("@/lib/webhooks/config")).rejects.toThrow(
        /Invalid value for WEBHOOK_DEFAULT_MAX_ATTEMPTS: "0"/,
      );
    });

    it("throws at startup when WEBHOOK_SECRET_ROTATION_GRACE_SECONDS is huge (exceeds max)", async () => {
      process.env.WEBHOOK_SECRET_ROTATION_GRACE_SECONDS = "99999999";
      await expect(import("@/lib/webhooks/config")).rejects.toThrow(
        /Invalid value for WEBHOOK_SECRET_ROTATION_GRACE_SECONDS: "99999999"/,
      );
    });

    it("throws at startup when WEBHOOK_SECRET_ROTATION_GRACE_SECONDS is below min (300s)", async () => {
      process.env.WEBHOOK_SECRET_ROTATION_GRACE_SECONDS = "60";
      await expect(import("@/lib/webhooks/config")).rejects.toThrow(
        /Invalid value for WEBHOOK_SECRET_ROTATION_GRACE_SECONDS: "60"/,
      );
    });

    it("throws at startup when WEBHOOK_DELIVERY_TIMEOUT_MS is non-numeric '10s'", async () => {
      process.env.WEBHOOK_DELIVERY_TIMEOUT_MS = "10s";
      await expect(import("@/lib/webhooks/config")).rejects.toThrow(
        /Invalid value for WEBHOOK_DELIVERY_TIMEOUT_MS: "10s"/,
      );
    });
  });

  describe("Integration with delivery backoff calculation", () => {
    it("never produces NaN delays when calculating backoff with valid settings", async () => {
      const { calculateBackoff } = await import("@/lib/webhooks/delivery");

      for (let attempt = 1; attempt <= 10; attempt++) {
        const nextAttempt = calculateBackoff(attempt);
        expect(nextAttempt).toBeInstanceOf(Date);
        expect(Number.isNaN(nextAttempt.getTime())).toBe(false);
        expect(nextAttempt.getTime()).toBeGreaterThan(Date.now() - 100);
      }
    });
  });
});
