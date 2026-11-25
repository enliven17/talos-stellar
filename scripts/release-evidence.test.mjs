import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { buildEvidenceBundle } from "./release-evidence.mjs";

const REVISION = "56e263152a911f0ec8e4b3b0988d9366db08641d";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "talos-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("builds a deterministic, self-contained bundle with explicit not-run checks", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "reports"));
  const bytes = Buffer.from('{"ok":true}\n');
  await writeFile(path.join(root, "reports", "doctor.json"), bytes);

  const input = {
    root,
    baselineRevision: REVISION,
    requiredChecks: ["contracts", "doctor", "web"],
    checkResults: [{ id: "doctor", status: "passed" }],
    artifactPaths: ["reports/doctor.json"],
  };
  const first = await buildEvidenceBundle(input);
  const second = await buildEvidenceBundle(input);

  assert.deepEqual(first, second);
  assert.deepEqual(first.checks, [
    { id: "contracts", status: "not-run" },
    { id: "doctor", status: "passed" },
    { id: "web", status: "not-run" },
  ]);
  assert.equal(first.artifacts[0].sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(Buffer.from(first.artifacts[0].contentBase64, "base64").toString(), bytes.toString());
  assert.equal(first.baselineRevision, REVISION);
});

test("rejects environment files and secret-bearing artifact content", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, ".env.production"), "PRIVATE_TOKEN=not-for-export\n");
  await mkdir(path.join(root, "reports"));
  await writeFile(path.join(root, "reports", "leak.txt"), "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n");

  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, artifactPaths: [".env.production"] }),
    /Private or non-portable artifact path refused/,
  );
  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, artifactPaths: ["reports/leak.txt"] }),
    /contains private environment or credential data/,
  );
});

test("rejects traversal, symlinks, duplicate inputs, and invalid revisions", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "reports"));
  await writeFile(path.join(root, "reports", "ok.txt"), "safe report");
  await symlink(path.join(root, "reports", "ok.txt"), path.join(root, "reports", "linked.txt"));

  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, artifactPaths: ["../outside.txt"] }),
    /escapes the repository/,
  );
  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, artifactPaths: ["reports/linked.txt"] }),
    /regular, non-symlink file/,
  );
  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: "deadbeef" }),
    /full 40- to 64-character hexadecimal/,
  );
  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, requiredChecks: ["doctor", "doctor"] }),
    /Duplicate required check/,
  );
  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, artifactPaths: ["reports/ok.txt", "reports/ok.txt"] }),
    /Duplicate artifact/,
  );
});

test("rejects oversized artifacts and invalid check statuses", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "reports"));
  await writeFile(path.join(root, "reports", "large.bin"), Buffer.alloc(2 * 1024 * 1024 + 1, 1));

  await assert.rejects(
    buildEvidenceBundle({ root, baselineRevision: REVISION, artifactPaths: ["reports/large.bin"] }),
    /exceeds the 2 MiB limit/,
  );
  await assert.rejects(
    buildEvidenceBundle({
      root,
      baselineRevision: REVISION,
      requiredChecks: ["doctor"],
      checkResults: [{ id: "doctor", status: "unknown" }],
    }),
    /Invalid status/,
  );
});
