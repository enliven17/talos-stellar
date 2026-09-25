/**
 * Focused coverage for the backup/restore CI fixtures.
 *
 * Positive: fixture shape, encrypt→verify round-trip via verifyArtifact.
 * Negative: malformed manifest/plaintext, wrong passphrase, truncated blob,
 *           missing required fields, empty passphrase.
 * Boundary: minTotalRowsAfterSeed gate, oversized artifact refusal path.
 * Privacy: sanitizeErrorMessage never echoes ENC:: ciphertext.
 *
 * Local command:
 *   pnpm --dir web exec vitest run tests/backup-restore-fixture.test.ts
 */

import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { encryptWithPassword } from "../src/lib/backup-crypto";
import { verifyArtifact } from "../src/lib/backup-service";
import { sanitizeErrorMessage } from "../src/lib/backup-types";

const FIXTURE_DIR = path.join(__dirname, "fixtures", "backup-restore");
const PASS = "ci-passphrase-must-be-long-enough";

function readJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

describe("backup-restore fixtures (positive)", () => {
  it("ships seed.sql, manifest.json, and plaintext-min.json", () => {
    for (const f of ["seed.sql", "manifest.json", "plaintext-min.json"]) {
      expect(fs.existsSync(path.join(FIXTURE_DIR, f))).toBe(true);
    }
  });

  it("manifest declares expected seed rows and local commands", () => {
    const m = readJson("manifest.json") as Record<string, unknown>;
    expect(m.version).toBe(1);
    expect(m.name).toBe("backup-restore-ci-fixture");
    expect(m.expectedSeedRows).toEqual({
      tls_talos: 1,
      tls_patrons: 1,
      tls_revenues: 1,
    });
    expect(m.minTotalRowsAfterSeed).toBe(3);
    expect(m.fixtureTalosName).toBe("DR Test");
    const cmds = m.localCommands as Record<string, string>;
    expect(cmds.unit).toContain("backup-restore-fixture.test.ts");
    expect(cmds.drill).toContain("ci-backup-restore-drill.ts");
  });

  it("seed.sql inserts the three fixture rows with stable ids", () => {
    const sql = fs.readFileSync(path.join(FIXTURE_DIR, "seed.sql"), "utf8");
    expect(sql).toContain("dr-test-1");
    expect(sql).toContain("dr-patron-1");
    expect(sql).toContain("dr-rev-1");
    expect(sql).toContain("DR Test");
    expect(sql.toLowerCase()).not.toMatch(/password|secret|private[_-]?key|mnemonic/);
  });

  it("plaintext-min.json is a valid BackupArtifactPlaintext shape", () => {
    const pt = readJson("plaintext-min.json") as Record<string, unknown>;
    expect(pt.version).toBe("1.0");
    expect(pt.encryption).toBe("AES-256-GCM#PBKDF2-SHA256#200000");
    expect(pt.scope).toBe("system");
    expect(pt.tables).toBeTruthy();
    expect(pt.database).toBeTruthy();
    const tables = pt.tables as Record<string, unknown[]>;
    expect(tables.tls_talos[0]).toMatchObject({ id: "dr-test-1", name: "DR Test" });
  });

  it("encrypts fixture plaintext and verifyArtifact accepts it", async () => {
    const pt = readJson("plaintext-min.json");
    const blob = encryptWithPassword(JSON.stringify(pt), PASS);
    expect(blob.startsWith("ENC::")).toBe(true);
    const verified = await verifyArtifact({
      encrypted: blob,
      password: PASS,
      timeoutMs: 5_000,
      expectRowCountsAtLeast: 3,
    });
    expect(verified.rowCountTotal).toBe(3);
    expect(verified.scope).toBe("system");
    expect((verified.plaintext.tables.tls_talos as Array<{ name: string }>)[0].name).toBe(
      "DR Test",
    );
  });
});

describe("backup-restore fixtures (negative / fail-closed)", () => {
  it("rejects wrong passphrase", async () => {
    const pt = readJson("plaintext-min.json");
    const blob = encryptWithPassword(JSON.stringify(pt), PASS);
    await expect(
      verifyArtifact({ encrypted: blob, password: "wrong-password-xx", timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  it("rejects truncated ENC:: blob", async () => {
    await expect(
      verifyArtifact({ encrypted: "ENC::AAAA", password: PASS, timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  it("rejects plaintext missing required fields", async () => {
    const blob = encryptWithPassword(JSON.stringify({ version: "1.0" }), PASS);
    await expect(
      verifyArtifact({ encrypted: blob, password: PASS, timeoutMs: 5_000 }),
    ).rejects.toThrow(/missing required fields/i);
  });

  it("rejects empty passphrase on verify", async () => {
    const pt = readJson("plaintext-min.json");
    const blob = encryptWithPassword(JSON.stringify(pt), PASS);
    await expect(
      verifyArtifact({ encrypted: blob, password: "", timeoutMs: 5_000 }),
    ).rejects.toThrow();
  });

  it("fails closed when row count is below expectRowCountsAtLeast", async () => {
    const pt = readJson("plaintext-min.json") as Record<string, unknown>;
    const blob = encryptWithPassword(JSON.stringify(pt), PASS);
    await expect(
      verifyArtifact({
        encrypted: blob,
        password: PASS,
        timeoutMs: 5_000,
        expectRowCountsAtLeast: 10_000,
      }),
    ).rejects.toThrow(/below expected minimum/i);
  });

  it("sanitizeErrorMessage never returns ENC:: ciphertext", () => {
    const pt = readJson("plaintext-min.json");
    const blob = encryptWithPassword(JSON.stringify(pt), PASS);
    const out = sanitizeErrorMessage(`restore failed: ${blob}`);
    expect(out).not.toContain("ENC::");
    expect(out.length).toBeLessThanOrEqual(205);
  });
});

describe("backup-restore fixtures (boundary)", () => {
  it("manifest minTotalRowsAfterSeed equals sum of expectedSeedRows", () => {
    const m = readJson("manifest.json") as {
      expectedSeedRows: Record<string, number>;
      minTotalRowsAfterSeed: number;
    };
    const sum = Object.values(m.expectedSeedRows).reduce((a, b) => a + b, 0);
    expect(m.minTotalRowsAfterSeed).toBe(sum);
  });

  it("plaintext rowCountTotal matches seeded table lengths", () => {
    const pt = readJson("plaintext-min.json") as {
      database: { rowCounts: Record<string, number>; rowsRestored: number };
      tables: Record<string, unknown[]>;
      manifest: { rowCountTotal: number };
    };
    for (const [table, n] of Object.entries(pt.database.rowCounts)) {
      expect(pt.tables[table]?.length ?? 0).toBe(n);
    }
    expect(pt.manifest.rowCountTotal).toBe(pt.database.rowsRestored);
  });
});
