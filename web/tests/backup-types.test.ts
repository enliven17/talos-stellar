/**
 * Tests for `web/src/lib/backup-types.ts` — Zod schemas and the
 * privacy-safe error sanitizer.
 */

import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage, TriggerBackupRequestSchema, RESTORE_CONFIRM_VALUE, RESTORE_CONFIRM_HEADER } from "../src/lib/backup-types";

describe("sanitizeErrorMessage", () => {
  it("returns 'unknown error' for null / undefined input", () => {
    expect(sanitizeErrorMessage(null)).toBe("unknown error");
    expect(sanitizeErrorMessage(undefined)).toBe("unknown error");
  });

  it("handles Error objects by reading the message", () => {
    expect(sanitizeErrorMessage(new Error("bad thing"))).toBe("bad thing");
  });

  it("redacts ENC:: base64 blobs", () => {
    const raw = "decrypt failed: ENC::abcdefghij1234567890ABCDEF==";
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain("ENC::");
    expect(out).not.toContain("abcdefghij");
  });

  it("redacts 32-char hex blobs (tokens / sha leakage)", () => {
    const raw = "auth failed with 0123456789abcdef0123456789abcdef";
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("redacts long base64 blobs", () => {
    const raw = "got blob YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODk=";
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain("YWJjZGVm");
  });

  it("redacts absolute file paths inside the message", () => {
    const raw = "Failed to read /var/data/secret.sql at offset 0";
    const out = sanitizeErrorMessage(raw);
    expect(out).not.toContain("/var/data/secret.sql");
  });

  it("caps output length", () => {
    const raw = "x".repeat(2000);
    const out = sanitizeErrorMessage(raw);
    expect(out.length).toBeLessThanOrEqual(205);
  });

  it("collapses whitespace", () => {
    expect(sanitizeErrorMessage("a\n\t b   c")).toBe("a b c");
  });

  it("never returns an empty string for a non-empty input", () => {
    expect(sanitizeErrorMessage(" ").trim()).toBe("unknown error");
  });
});

describe("TriggerBackupRequestSchema", () => {
  it("accepts minimal valid request", () => {
    const parsed = TriggerBackupRequestSchema.parse({ scope: "system" });
    expect(parsed.scope).toBe("system");
    expect(parsed.triggeredBy).toBe("api");
  });

  it("rejects unknown scope", () => {
    expect(() =>
      TriggerBackupRequestSchema.parse({ scope: "nope" }),
    ).toThrow();
  });

  it("rejects talosId longer than 256 chars", () => {
    expect(() =>
      TriggerBackupRequestSchema.parse({ scope: "system", talosId: "x".repeat(257) }),
    ).toThrow();
  });
});

describe("RESTORE_CONFIRM constants", () => {
  it("uses canonical header name", () => {
    expect(RESTORE_CONFIRM_HEADER).toBe("x-confirm");
    expect(RESTORE_CONFIRM_VALUE).toBe("yes");
  });
});
