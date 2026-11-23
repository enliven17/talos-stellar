import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkPackage,
  collectPublishedTargets,
  discoverPackages,
  formatReport,
  validateTarget,
} from "./check-package-artifacts.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-package-artifacts.mjs");

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function makePackage(t, manifest, files = []) {
  const root = mkdtempSync(join(tmpdir(), "talos-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2));
  for (const file of files) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "built\n");
  }
  return root;
}

const manifest = {
  name: "@talos-protocol/sdk",
  main: "dist/esm/index.js",
  types: "dist/esm/index.d.ts",
  exports: {
    ".": {
      types: "./dist/esm/index.d.ts",
      import: "./dist/esm/index.js",
      require: "./dist/cjs/index.cjs",
    },
    "./webhooks": {
      import: ["./dist/esm/webhooks.js", "./dist/esm/webhooks-fallback.js"],
    },
    "./blocked": null,
  },
  bin: { talos: "./bin/talos.js" },
};

const builtFiles = [
  "dist/esm/index.js",
  "dist/esm/index.d.ts",
  "dist/cjs/index.cjs",
  "dist/esm/webhooks.js",
  "dist/esm/webhooks-fallback.js",
  "bin/talos.js",
];

test("collects exports, main, types, and bin targets with field labels", () => {
  assert.deepEqual(collectPublishedTargets(manifest), [
    { field: 'exports["."]["types"]', target: "./dist/esm/index.d.ts" },
    { field: 'exports["."]["import"]', target: "./dist/esm/index.js" },
    { field: 'exports["."]["require"]', target: "./dist/cjs/index.cjs" },
    { field: 'exports["./webhooks"]["import"][0]', target: "./dist/esm/webhooks.js" },
    { field: 'exports["./webhooks"]["import"][1]', target: "./dist/esm/webhooks-fallback.js" },
    { field: "main", target: "dist/esm/index.js" },
    { field: "types", target: "dist/esm/index.d.ts" },
    { field: 'bin["talos"]', target: "./bin/talos.js" },
  ]);
});

test("accepts a built package whose published entries all resolve", (t) => {
  const root = makePackage(t, manifest, builtFiles);

  const result = checkPackage({ packageDir: root, label: "packages/sdk", pkg: manifest });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.match(formatReport([result]), /✓ packages\/sdk: 8 published target\(s\)/);
});

test("rejects a published entry that is missing from the built package", (t) => {
  const root = makePackage(t, manifest, builtFiles.filter((file) => file !== "dist/cjs/index.cjs"));

  const result = checkPackage({ packageDir: root, label: "packages/sdk", pkg: manifest });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [
    'exports["."]["require"] -> ./dist/cjs/index.cjs: does not exist in the built package (run the package build first)',
  ]);
  assert.match(formatReport([result]), /✗ packages\/sdk: 1 invalid published target/);
});

test("rejects absolute and parent-escaping targets before reading them", (t) => {
  const root = makePackage(t, manifest, builtFiles);
  const outside = makePackage(t, { name: "outside" }, ["secret.js"]);

  for (const target of [
    "../secret.js",
    "./dist/../../secret.js",
    "/etc/passwd",
    "C:\\Windows\\system32\\config",
    "\\\\server\\share\\file.js",
  ]) {
    const error = validateTarget(root, target);
    assert.equal(typeof error, "string", `expected ${target} to be rejected`);
    assert.doesNotMatch(error, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(validateTarget(root, "../secret.js"), /must not escape the package root/);
  assert.match(validateTarget(root, "/etc/passwd"), /must be a path relative to the package root/);
  assert.equal(validateTarget(root, "dist/esm/index.js"), null);
  assert.equal(outside.startsWith(root), false);
});

test("rejects a target that escapes the package through a symlink", (t) => {
  const root = makePackage(t, manifest, builtFiles);
  const outside = makePackage(t, { name: "outside" }, ["secret.js"]);

  try {
    rmSync(join(root, "dist", "esm", "index.js"));
    symlinkSync(join(outside, "secret.js"), join(root, "dist", "esm", "index.js"));
  } catch (error) {
    t.skip(`symlinks are unavailable: ${error.code}`);
    return;
  }

  assert.match(
    validateTarget(root, "./dist/esm/index.js"),
    /resolves outside the package root through a symlink/,
  );
});

test("rejects directory targets and non-string export leaves", (t) => {
  const root = makePackage(t, manifest, builtFiles);
  assert.match(validateTarget(root, "./dist"), /is not a regular file/);

  const result = checkPackage({
    packageDir: root,
    label: "pkg",
    pkg: { exports: { ".": { import: 42 } } },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, ['exports["."]["import"] -> 42: must be a string, got number']);
});

test("does not require the built artifact when validating the manifest shape", (t) => {
  const root = makePackage(t, { name: "empty" }, []);

  assert.match(validateTarget(root, ""), /must not be empty/);
  assert.match(validateTarget(root, "dist/\0evil.js"), /must not contain NUL bytes/);
});

test("discovers non-private packages and skips private or entry-less ones", (t) => {
  const root = mkdtempSync(join(tmpdir(), "talos-artifacts-root-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const write = (name, pkg) => {
    const dir = join(root, "packages", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  };
  write("sdk", { name: "sdk", main: "dist/index.js" });
  write("internal", { name: "internal", private: true, main: "dist/index.js" });
  write("docs-only", { name: "docs-only" });

  assert.deepEqual(
    discoverPackages(root).map((entry) => entry.label),
    ["packages/sdk"],
  );
});

test("CLI passes a package whose built entries resolve", (t) => {
  const root = makePackage(t, manifest, builtFiles);

  const { status, stdout } = runCli("--package", root, "--json");
  assert.equal(status, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.packages[0].entries.length, 8);
});

test("CLI fails a package with a missing entry", (t) => {
  const root = makePackage(t, manifest, builtFiles.filter((file) => file !== "bin/talos.js"));

  const first = runCli("--package", root);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /1 invalid published target/);
  assert.match(first.stdout, /bin\["talos"\] -> \.\/bin\/talos\.js/);

  const json = runCli("--package", root, "--json");
  assert.equal(json.status, 1);
  assert.equal(JSON.parse(json.stdout).ok, false);
});

test("CLI rejects unknown arguments and packages without a manifest", (t) => {
  const unknown = runCli("--nope");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --nope/);

  const emptyDir = mkdtempSync(join(tmpdir(), "talos-artifacts-empty-"));
  t.after(() => rmSync(emptyDir, { recursive: true, force: true }));
  const missing = runCli("--package", emptyDir);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /could not read package manifest/);
});
