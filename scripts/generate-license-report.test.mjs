import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateLicenseReport, normalizeLicenseReport } from "./generate-license-report.mjs";

test("normalizes, deduplicates, and sorts dependency records", () => {
  const records = normalizeLicenseReport({
    MIT: [
      { name: "z-package", versions: ["2.0.0", "2.0.0"] },
      { name: "a-package", versions: ["1.0.0"] },
    ],
  });

  assert.deepEqual(records.map(({ name, versions, license }) => ({ name, versions, license })), [
    { name: "a-package", versions: ["1.0.0"], license: "MIT" },
    { name: "z-package", versions: ["2.0.0"], license: "MIT" },
  ]);
});

test("fails closed for missing or malformed license metadata", () => {
  assert.throws(() => normalizeLicenseReport({ UNKNOWN: [{ name: "pkg", versions: ["1.0.0"] }] }), /missing or ambiguous/);
  assert.throws(() => normalizeLicenseReport({ MIT: [{ name: "pkg", versions: [] }] }), /has no version/);
  assert.throws(() => normalizeLicenseReport({ MIT: "not-an-array" }), /invalid license group/);
  assert.throws(() => normalizeLicenseReport(null), /invalid license report/);
});

test("generates both artifacts on a successful end-to-end run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "license-report-"));
  const result = await generateLicenseReport({
    cwd,
    runLicenseCommand: async () => ({ "Apache-2.0": [{ name: "a-package", versions: ["1.0.0"], homepage: "https://example.test/a" }] }),
  });

  assert.equal(result.count, 1);
  assert.match(await readFile(join(cwd, "dist/licenses/dependency-licenses.json"), "utf8"), /a-package/);
  assert.match(await readFile(join(cwd, "dist/licenses/dependency-licenses.md"), "utf8"), /Apache-2\.0/);
});

test("keeps empty reports valid at the boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "license-report-empty-"));
  const result = await generateLicenseReport({ cwd, runLicenseCommand: async () => ({}) });
  assert.equal(result.count, 0);
});

test("writes the diagnostic artifact before failing on Unknown licenses", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "license-report-unknown-"));
  await assert.rejects(
    generateLicenseReport({
      cwd,
      runLicenseCommand: async () => ({ Unknown: [{ name: "unknown-package", versions: ["1.0.0"] }] }),
    }),
    /missing or ambiguous/,
  );
  assert.match(await readFile(join(cwd, "dist/licenses/dependency-licenses.json"), "utf8"), /unknown-package/);
});

test("retries once, then reports dependency failure explicitly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "license-report-retry-"));
  let calls = 0;
  await assert.rejects(
    generateLicenseReport({
      cwd,
      runLicenseCommand: async () => {
        calls += 1;
        throw new Error("pnpm could not generate the dependency license report");
      },
    }),
    /pnpm could not generate the dependency license report/,
  );
  assert.equal(calls, 2);
});

test("does not retry beyond the bounded attempt limit", async () => {
  let calls = 0;
  await assert.rejects(
    generateLicenseReport({
      runLicenseCommand: async () => {
        calls += 1;
        throw new Error("dependency unavailable");
      },
      maxAttempts: 99,
    }),
    /dependency unavailable/,
  );
  assert.equal(calls, 2);
});