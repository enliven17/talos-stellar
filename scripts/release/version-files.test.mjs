import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readVersion, writeVersion } from "./version-files.mjs";

function withTmpDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-version-files-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("readVersion/writeVersion round-trip a package.json", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "sdk", version: "0.1.0", dependencies: { a: "1" } }, null, 2));

    assert.equal(readVersion(file, "json"), "0.1.0");
    writeVersion(file, "json", "0.2.0");
    assert.equal(readVersion(file, "json"), "0.2.0");

    const parsed = JSON.parse(readFileSync(file, "utf8"));
    assert.equal(parsed.dependencies.a, "1", "unrelated fields must survive the rewrite");
  });
});

test("readVersion/writeVersion round-trip a Cargo.toml-style file", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "Cargo.toml");
    writeFileSync(
      file,
      ['[package]', 'name = "talos-registry"', 'version = "0.1.0"', 'edition = "2021"', ""].join("\n"),
    );

    assert.equal(readVersion(file, "toml"), "0.1.0");
    writeVersion(file, "toml", "0.2.0");
    assert.equal(readVersion(file, "toml"), "0.2.0");

    const text = readFileSync(file, "utf8");
    assert.match(text, /name = "talos-registry"/, "unrelated lines must survive the rewrite");
  });
});

test("readVersion throws for a missing file", () => {
  withTmpDir((dir) => {
    assert.throws(() => readVersion(path.join(dir, "missing.json"), "json"), /not found/);
  });
});

test("readVersion throws when a toml file has no version line", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "Cargo.toml");
    writeFileSync(file, "[package]\nname = \"x\"\n");
    assert.throws(() => readVersion(file, "toml"), /no version/);
  });
});

test("readVersion throws when a json file has no version field", () => {
  withTmpDir((dir) => {
    const file = path.join(dir, "package.json");
    writeFileSync(file, JSON.stringify({ name: "x" }));
    assert.throws(() => readVersion(file, "json"), /no "version"/);
  });
});
