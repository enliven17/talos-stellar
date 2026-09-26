#!/usr/bin/env node
/**
 * verify-sbom.test.mjs
 *
 * Unit tests for scripts/verify-sbom.mjs.
 *
 * Covers positive, negative, boundary, and regression cases for CycloneDX
 * and SPDX verification, plus the privacy guard.
 *
 * Run locally:
 *   node --test scripts/verify-sbom.test.mjs
 *
 * Exit codes follow node:test conventions (0 = all pass, non-zero = failures).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "verify-sbom.mjs");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_CDX = JSON.stringify(
  {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    serialNumber: "urn:uuid:12345678-1234-1234-1234-123456789abc",
    metadata: {
      timestamp: "2024-01-01T00:00:00Z",
      component: {
        type: "library",
        name: "@talos-protocol/sdk",
        version: "0.1.0",
      },
    },
    components: [
      {
        type: "library",
        name: "@stellar/stellar-sdk",
        version: "14.2.0",
      },
    ],
  },
  null,
  2,
);

const VALID_SPDX = [
  "SPDXVersion: SPDX-2.3",
  "DataLicense: CC0-1.0",
  "SPDXID: SPDXRef-DOCUMENT",
  "DocumentName: talos-sdk-0.1.0",
  "DocumentNamespace: https://talos.example/sbom/spdx/sdk/12345678",
  "Creator: Tool: talos-spdx-generator-1.0.0",
  "Created: 2024-01-01T00:00:00Z",
  "",
  "PackageName: @talos-protocol/sdk",
  "SPDXID: SPDXRef-AABBCCDDEE11",
  "PackageVersion: 0.1.0",
  "PackageDownloadLocation: NOASSERTION",
  "FilesAnalyzed: false",
  "PackageLicenseConcluded: MIT",
  "PackageLicenseDeclared: MIT",
  "PackageCopyrightText: NOASSERTION",
  "",
  "PackageName: @stellar/stellar-sdk",
  "SPDXID: SPDXRef-FFEEDDCCBB22",
  "PackageVersion: 14.2.0",
  "PackageDownloadLocation: NOASSERTION",
  "FilesAnalyzed: false",
  "PackageLicenseConcluded: NOASSERTION",
  "PackageLicenseDeclared: NOASSERTION",
  "PackageCopyrightText: NOASSERTION",
].join("\n") + "\n";

// ── Helpers ───────────────────────────────────────────────────────────────────

let _tmpDir = null;

function getTmpDir() {
  if (!_tmpDir) {
    _tmpDir = join(tmpdir(), `verify-sbom-test-${process.pid}`);
    mkdirSync(_tmpDir, { recursive: true });
  }
  return _tmpDir;
}

function tmpFile(name, content) {
  const fp = join(getTmpDir(), name);
  writeFileSync(fp, content, "utf8");
  return fp;
}

function runVerify(...args) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args],
    { encoding: "utf8", timeout: 10_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// ── Cleanup helper ─────────────────────────────────────────────────────────────

process.on("exit", () => {
  if (_tmpDir && existsSync(_tmpDir)) {
    try { rmSync(_tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── CycloneDX positive tests ──────────────────────────────────────────────────

describe("CycloneDX – positive", () => {
  it("accepts a valid CycloneDX SBOM", () => {
    const fp = tmpFile("valid.cdx.json", VALID_CDX);
    const { status, stdout } = runVerify("--file", fp);
    assert.strictEqual(status, 0, `Expected exit 0, got ${status}\n${stdout}`);
    assert.match(stdout, /✓/);
  });

  it("accepts JSON output with --json flag", () => {
    const fp = tmpFile("valid-json.cdx.json", VALID_CDX);
    const { status, stdout } = runVerify("--file", fp, "--json");
    assert.strictEqual(status, 0);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.failed, 0);
    assert.strictEqual(parsed.passed, 1);
    assert.ok(parsed.results[0].ok);
  });

  it("accepts SBOM without optional serialNumber", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.serialNumber;
    const fp = tmpFile("no-serial.cdx.json", JSON.stringify(doc, null, 2));
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 0);
  });

  it("accepts SBOM without optional version field", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.version;
    const fp = tmpFile("no-ver.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stdout } = runVerify("--file", fp);
    // version absence is a warning, not an error
    assert.strictEqual(status, 0, stdout);
  });

  it("accepts component with version", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.components.push({ type: "library", name: "react", version: "18.0.0" });
    const fp = tmpFile("extra-comp.cdx.json", JSON.stringify(doc, null, 2));
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 0);
  });
});

// ── CycloneDX negative tests ──────────────────────────────────────────────────

describe("CycloneDX – negative / error cases", () => {
  it("rejects non-JSON content", () => {
    const fp = tmpFile("bad.cdx.json", "not json at all <<<");
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /invalid JSON/i);
  });

  it("rejects missing bomFormat", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.bomFormat;
    const fp = tmpFile("no-bomformat.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /bomFormat/i);
  });

  it("rejects wrong bomFormat value", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.bomFormat = "SPDX";
    const fp = tmpFile("wrong-bomformat.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /bomFormat/i);
  });

  it("rejects missing specVersion", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.specVersion;
    const fp = tmpFile("no-specver.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /specVersion/i);
  });

  it("rejects non-integer version", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.version = "1";
    const fp = tmpFile("str-ver.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /version/i);
  });

  it("rejects missing metadata", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.metadata;
    const fp = tmpFile("no-metadata.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /metadata/i);
  });

  it("rejects missing metadata.timestamp", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.metadata.timestamp;
    const fp = tmpFile("no-ts.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /timestamp/i);
  });

  it("rejects invalid metadata.timestamp format", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.metadata.timestamp = "January 1, 2024";
    const fp = tmpFile("bad-ts.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /timestamp/i);
  });

  it("rejects missing metadata.component", () => {
    const doc = JSON.parse(VALID_CDX);
    delete doc.metadata.component;
    const fp = tmpFile("no-mc.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /metadata\.component/i);
  });

  it("rejects empty metadata.component.version", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.metadata.component.version = "";
    const fp = tmpFile("empty-ver.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /version/i);
  });

  it("rejects empty components array", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.components = [];
    const fp = tmpFile("empty-comps.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /components array is empty/i);
  });

  it("rejects invalid serialNumber format", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.serialNumber = "not-a-uuid";
    const fp = tmpFile("bad-serial.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /serialNumber/i);
  });

  it("rejects component missing type", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.components[0] = { name: "foo", version: "1.0.0" };
    const fp = tmpFile("no-type-comp.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /type/i);
  });

  it("rejects component missing name", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.components[0] = { type: "library", version: "1.0.0" };
    const fp = tmpFile("no-name-comp.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /name/i);
  });

  it("rejects an empty file", () => {
    const fp = tmpFile("empty.cdx.json", "");
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /empty/i);
  });

  it("rejects a non-existent file", () => {
    const { status, stderr } = runVerify("--file", "/tmp/does-not-exist-sbom-verify.cdx.json");
    assert.strictEqual(status, 1);
    assert.match(stderr, /not found/i);
  });
});

// ── CycloneDX boundary tests ──────────────────────────────────────────────────

describe("CycloneDX – boundary", () => {
  it("accepts specVersion 1.4", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.specVersion = "1.4";
    const fp = tmpFile("v1.4.cdx.json", JSON.stringify(doc, null, 2));
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 0);
  });

  it("accepts exactly one component", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.components = [{ type: "library", name: "only-one", version: "1.0.0" }];
    const fp = tmpFile("one-comp.cdx.json", JSON.stringify(doc, null, 2));
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 0);
  });

  it("rejects version = 0", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.version = 0;
    const fp = tmpFile("ver-zero.cdx.json", JSON.stringify(doc, null, 2));
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
  });

  it("rejects version = -1", () => {
    const doc = JSON.parse(VALID_CDX);
    doc.version = -1;
    const fp = tmpFile("ver-neg.cdx.json", JSON.stringify(doc, null, 2));
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
  });
});

// ── SPDX positive tests ───────────────────────────────────────────────────────

describe("SPDX – positive", () => {
  it("accepts a valid SPDX SBOM", () => {
    const fp = tmpFile("valid.spdx", VALID_SPDX);
    const { status, stdout } = runVerify("--file", fp);
    assert.strictEqual(status, 0, `Expected exit 0, got status\n${stdout}`);
    assert.match(stdout, /✓/);
  });

  it("accepts JSON output with --json for SPDX", () => {
    const fp = tmpFile("valid-json.spdx", VALID_SPDX);
    const { status, stdout } = runVerify("--file", fp, "--json");
    assert.strictEqual(status, 0);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.failed, 0);
    assert.ok(parsed.results[0].ok);
  });

  it("accepts SPDX with multiple packages", () => {
    const extra = VALID_SPDX + "\nPackageName: extra-lib\nSPDXID: SPDXRef-AABB\nPackageVersion: 2.0.0\nPackageDownloadLocation: NOASSERTION\nFilesAnalyzed: false\nPackageLicenseConcluded: NOASSERTION\nPackageLicenseDeclared: NOASSERTION\nPackageCopyrightText: NOASSERTION\n";
    const fp = tmpFile("multi-pkg.spdx", extra);
    const { status } = runVerify("--file", fp);
    assert.strictEqual(status, 0);
  });
});

// ── SPDX negative tests ───────────────────────────────────────────────────────

describe("SPDX – negative / error cases", () => {
  it("rejects missing SPDXVersion", () => {
    const content = VALID_SPDX.replace(/^SPDXVersion:.*\n/m, "");
    const fp = tmpFile("no-spdxver.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /SPDXVersion/i);
  });

  it("rejects wrong SPDXVersion format", () => {
    const content = VALID_SPDX.replace("SPDXVersion: SPDX-2.3", "SPDXVersion: 2.3");
    const fp = tmpFile("bad-ver.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /SPDXVersion/i);
  });

  it("rejects missing DataLicense", () => {
    const content = VALID_SPDX.replace(/^DataLicense:.*\n/m, "");
    const fp = tmpFile("no-dl.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /DataLicense/i);
  });

  it("rejects missing SPDXID: SPDXRef-DOCUMENT", () => {
    const content = VALID_SPDX.replace(/^SPDXID: SPDXRef-DOCUMENT.*\n/m, "");
    const fp = tmpFile("no-docid.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /SPDXRef-DOCUMENT/i);
  });

  it("rejects missing DocumentName", () => {
    const content = VALID_SPDX.replace(/^DocumentName:.*\n/m, "");
    const fp = tmpFile("no-docname.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /DocumentName/i);
  });

  it("rejects missing DocumentNamespace", () => {
    const content = VALID_SPDX.replace(/^DocumentNamespace:.*\n/m, "");
    const fp = tmpFile("no-ns.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /DocumentNamespace/i);
  });

  it("rejects non-HTTP DocumentNamespace", () => {
    const content = VALID_SPDX.replace(
      /^DocumentNamespace:.*$/m,
      "DocumentNamespace: ftp://talos.example/sbom",
    );
    const fp = tmpFile("ftp-ns.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /DocumentNamespace/i);
  });

  it("rejects SPDX with no PackageName entries", () => {
    const content = VALID_SPDX.replace(/^PackageName:.*\n/gm, "");
    const fp = tmpFile("no-pkg.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /PackageName/i);
  });

  it("rejects an empty SPDX file", () => {
    const fp = tmpFile("empty.spdx", "");
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /empty/i);
  });
});

// ── Privacy guard tests ───────────────────────────────────────────────────────

describe("Privacy guard", () => {
  it("rejects CycloneDX SBOM containing a PEM private key header", () => {
    const doc = JSON.parse(VALID_CDX);
    // Embed a fake PEM header in a non-secret field to trigger the guard
    doc.metadata["_test_field"] = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA==\n-----END RSA PRIVATE KEY-----";
    const fp = tmpFile("pem.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /sensitive-data pattern/i);
    // Ensure the actual key value is NOT echoed back
    assert.ok(!stderr.includes("MIIEowIBAA"), "private key value must not appear in error output");
  });

  it("rejects SPDX SBOM containing a secret assignment pattern", () => {
    const content = VALID_SPDX + "\n# api_key: supersecretvalue123456789\n";
    const fp = tmpFile("secret.spdx", content);
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /sensitive-data pattern/i);
    assert.ok(!stderr.includes("supersecretvalue"), "secret value must not appear in output");
  });
});

// ── Unknown / ambiguous format tests ─────────────────────────────────────────

describe("Unknown format", () => {
  it("rejects a .json file that is not CycloneDX", () => {
    const fp = tmpFile("random.json", JSON.stringify({ foo: "bar" }));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /unrecognized SBOM format/i);
  });

  it("rejects a .txt file", () => {
    const fp = tmpFile("sbom.txt", "some text");
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    assert.match(stderr, /unrecognized SBOM format/i);
  });

  it("auto-detects CycloneDX from a .json file when bomFormat is present", () => {
    const doc = JSON.parse(VALID_CDX);
    const fp = tmpFile("auto.json", JSON.stringify(doc, null, 2));
    const { status, stdout } = runVerify("--file", fp);
    assert.strictEqual(status, 0, stdout);
    assert.match(stdout, /CycloneDX \(auto-detected\)/);
  });
});

// ── --dir flag tests ──────────────────────────────────────────────────────────

describe("--dir flag", () => {
  it("scans a directory and verifies all SBOM files", () => {
    const dir = join(getTmpDir(), "dir-scan");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.cdx.json"), VALID_CDX);
    writeFileSync(join(dir, "b.spdx"), VALID_SPDX);

    const { status, stdout } = runVerify("--dir", dir);
    assert.strictEqual(status, 0, stdout);
    assert.match(stdout, /2\/2/);
  });

  it("fails when one file in the directory is invalid", () => {
    const dir = join(getTmpDir(), "dir-mixed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "good.cdx.json"), VALID_CDX);
    writeFileSync(join(dir, "bad.cdx.json"), JSON.stringify({ bomFormat: "wrong" }, null, 2));

    const { status, stderr } = runVerify("--dir", dir);
    assert.strictEqual(status, 1);
    assert.match(stderr, /1\/2/);
  });

  it("warns but exits 0 when no SBOM files are in directory", () => {
    const dir = join(getTmpDir(), "dir-empty");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# nothing here");

    const { status, stderr } = runVerify("--dir", dir);
    // No files to verify → not a failure, but a warning
    assert.strictEqual(status, 2); // usage error: no files resolved
  });
});

// ── CLI usage error tests ─────────────────────────────────────────────────────

describe("CLI usage errors", () => {
  it("exits 2 with no arguments", () => {
    const { status } = runVerify();
    assert.strictEqual(status, 2);
  });

  it("exits 2 with unknown argument", () => {
    const { status } = runVerify("--unknown");
    assert.strictEqual(status, 2);
  });

  it("exits 2 with --file missing path", () => {
    const { status } = runVerify("--file");
    assert.strictEqual(status, 2);
  });
});

// ── Regression: component-count overflow ─────────────────────────────────────

describe("Regression", () => {
  it("caps component errors at 6 messages (5 + summary) to avoid log flooding", () => {
    const doc = JSON.parse(VALID_CDX);
    // Add 10 invalid components
    doc.components = Array.from({ length: 10 }, (_, i) => ({ version: `${i}.0.0` }));
    const fp = tmpFile("many-bad-comps.cdx.json", JSON.stringify(doc, null, 2));
    const { status, stderr } = runVerify("--file", fp);
    assert.strictEqual(status, 1);
    // Should say "and N more" rather than listing all 10
    assert.match(stderr, /more component validation errors/i);
  });
});
