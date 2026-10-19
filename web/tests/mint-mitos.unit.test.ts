/**
 * Unit tests for mint-mitos.ts security helpers.
 *
 * Tests the two exported, side-effect-free functions:
 *   - assertTestnetPassphrase  (network guard)
 *   - writeSecretsFile         (0600-file output helper)
 *
 * The tests do NOT exercise the Stellar SDK or the database; those paths
 * require live network access and are covered by the broader e2e suite.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, statSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Networks } from "@stellar/stellar-sdk";

// Dynamically import the helpers so the module-level side-effects
// (env var checks) are not triggered during import.
import {
  assertTestnetPassphrase,
  writeSecretsFile,
} from "../scripts/mint-mitos";

// ── assertTestnetPassphrase ───────────────────────────────────────────────

describe("assertTestnetPassphrase", () => {
  it("passes silently when passphrase is TESTNET and allowNetwork is false", () => {
    expect(() =>
      assertTestnetPassphrase(Networks.TESTNET, false),
    ).not.toThrow();
  });

  it("passes silently when passphrase is TESTNET and allowNetwork is true", () => {
    expect(() =>
      assertTestnetPassphrase(Networks.TESTNET, true),
    ).not.toThrow();
  });

  it("throws when passphrase is MAINNET (PUBLIC) and allowNetwork is false", () => {
    expect(() =>
      assertTestnetPassphrase(Networks.PUBLIC, false),
    ).toThrow(/non-testnet network passphrase/);
  });

  it("throws when passphrase is an arbitrary string and allowNetwork is false", () => {
    expect(() =>
      assertTestnetPassphrase("Private SDF Network ; September 2015", false),
    ).toThrow(/non-testnet network passphrase/);
  });

  it("warns but does NOT throw when passphrase is MAINNET and allowNetwork is true", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() =>
      assertTestnetPassphrase(Networks.PUBLIC, true),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--allow-network"));
    warnSpy.mockRestore();
  });

  it("error message includes the configured passphrase", () => {
    const badPassphrase = "bad-network-passphrase";
    expect(() =>
      assertTestnetPassphrase(badPassphrase, false),
    ).toThrow(badPassphrase);
  });
});

// ── writeSecretsFile ──────────────────────────────────────────────────────

describe("writeSecretsFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mint-mitos-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a valid JSON file", () => {
    const outPath = join(tmpDir, "secrets.json");
    const secrets = { Vega: "SVEGA_SECRET", Atlas: "SATLAS_SECRET" };

    writeSecretsFile(secrets, outPath);

    const raw = readFileSync(outPath, "utf8");
    const parsed = JSON.parse(raw);

    expect(parsed.secrets).toEqual(secrets);
    expect(parsed.warning).toBeTruthy();
    expect(parsed.generatedAt).toBeTruthy();
  });

  it("file permissions are 0600 on POSIX", () => {
    // Skip on Windows where chmod is a no-op
    if (process.platform === "win32") return;

    const outPath = join(tmpDir, "secrets.json");
    writeSecretsFile({ Vega: "SVEGA_SECRET" }, outPath);

    const stat = statSync(outPath);
    // stat.mode & 0o777 extracts rwxrwxrwx bits
    const perms = stat.mode & 0o777;
    expect(perms).toBe(0o600);
  });

  it("file content does not include the string 'SECRET' at the top level (only nested)", () => {
    const outPath = join(tmpDir, "secrets.json");
    writeSecretsFile({ Vega: "SVEGA_SECRET_KEY_EXAMPLE" }, outPath);

    const raw = readFileSync(outPath, "utf8");
    const parsed = JSON.parse(raw);

    // The secrets live inside parsed.secrets, not at the top level
    expect(Object.keys(parsed)).toEqual(
      expect.arrayContaining(["warning", "generatedAt", "secrets"]),
    );
    expect(parsed.secrets["Vega"]).toBe("SVEGA_SECRET_KEY_EXAMPLE");
  });

  it("includes a warning message in the output", () => {
    const outPath = join(tmpDir, "secrets.json");
    writeSecretsFile({}, outPath);

    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.warning).toMatch(/secret/i);
  });

  it("overwrites an existing file", () => {
    const outPath = join(tmpDir, "secrets.json");
    writeSecretsFile({ Vega: "FIRST" }, outPath);
    writeSecretsFile({ Vega: "SECOND" }, outPath);

    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.secrets["Vega"]).toBe("SECOND");
  });
});
