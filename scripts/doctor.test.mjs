import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnose, formatReport, runCommand } from "./doctor.mjs";

function tools(outputs) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`.trim();
    if (!(key in outputs)) throw new Error(`${command} was not found`);
    return outputs[key];
  };
}

function fakeTools(overrides = {}) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`.trim();
    if (key in overrides) {
      const outcome = overrides[key];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    if (!(key in healthyTools)) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
    }
    return healthyTools[key];
  };
}

function spawnError(command, code = "EACCES") {
  return Object.assign(new Error(`spawn ${command} ${code}: permission denied`), { code });
}

const healthyTools = {
  "pnpm --version": "9.15.0",
  "python3 --version": "Python 3.12.2",
  "uv --version": "uv 0.5.11",
  "rustc --version": "rustc 1.82.0 (f6e511eec 2024-10-15)",
  "cargo --version": "cargo 1.82.0 (8f40fc59f 2024-08-21)",
  "rustup target list --installed": "wasm32-unknown-unknown\nx86_64-apple-darwin",
  "docker --version": "Docker version 27.3.1, build ce12230",
  "stellar --version": "stellar 22.0.0",
};

test("accepts the minimum supported Node, pnpm, Python, Rust, Wasm target, Docker and optional CLI", () => {
  const report = diagnose({ run: tools(healthyTools), nodeVersion: "v20.0.0", platform: "darwin" });
  assert.equal(report.exitCode, 0);
  assert.ok(report.results.every((result) => result.ok));
  assert.match(formatReport(report), /Node\.js 20\.0\.0/);
});

test("fails for missing and outdated required tools with actionable guidance", () => {
  const report = diagnose({
    run: tools({
      "pnpm --version": "8.15.0",
      "python3 --version": "Python 3.10.14",
      "rustc --version": "rustc 1.82.0",
      "cargo --version": "cargo 1.82.0",
      "rustup target list --installed": "x86_64-unknown-linux-gnu",
      "docker --version": "Docker version 27.0.0",
    }),
    nodeVersion: "v18.19.0",
    platform: "linux",
  });

  assert.equal(report.exitCode, 1);
  assert.match(formatReport(report), /Node\.js 18\.19\.0 is too old/);
  assert.match(formatReport(report), /pnpm 8\.15\.0 is too old/);
  assert.match(formatReport(report), /Python 3\.10\.14 is too old/);
  assert.match(formatReport(report), /rustup target add wasm32-unknown-unknown/);
  assert.match(formatReport(report), /uv not found/);
});

test("uses Windows Python launcher and command alternatives", () => {
  const report = diagnose({
    run: tools({
      "pnpm --version": "9.0.0",
      "py -3 --version": "Python 3.11.0",
      "uv --version": "uv 0.5.0",
      "rustc --version": "rustc 1.82.0",
      "cargo --version": "cargo 1.82.0",
      "rustup target list --installed": "wasm32-unknown-unknown",
      "docker --version": "Docker version 25.0.0",
      "stellar --version": "stellar 22.0.0",
    }),
    nodeVersion: "v22.1.0",
    platform: "win32",
  });
  assert.equal(report.exitCode, 0);
  assert.equal(report.results.find((result) => result.name === "Python").ok, true);
});

test("treats Stellar CLI as optional and uv as a required contributor tool", () => {
  const report = diagnose({
    run: tools({
      "pnpm --version": "9.1.0",
      "python3 --version": "Python 3.11.1",
      "rustc --version": "rustc 1.82.0",
      "cargo --version": "cargo 1.82.0",
      "rustup target list --installed": "wasm32-unknown-unknown",
      "docker --version": "Docker version 27.0.0",
    }),
    nodeVersion: "v20.1.0",
    platform: "linux",
  });
  assert.equal(report.exitCode, 1);
  assert.equal(report.results.find((result) => result.name === "uv").optional, undefined);
  assert.equal(report.results.find((result) => result.name === "Stellar CLI").optional, true);
});

test("rejects a required executable that exists but cannot be spawned", () => {
  const report = diagnose({
    run: fakeTools({ "cargo --version": spawnError("cargo") }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  });
  const cargo = report.results.find((result) => result.name === "Cargo");

  assert.equal(report.exitCode, 1);
  assert.equal(cargo.ok, false);
  assert.equal(cargo.reason, "execution-failure");
  assert.match(cargo.message, /Cargo could not be executed \(cargo\).*EACCES/);
  assert.doesNotMatch(cargo.message, /not found/);
  assert.match(formatReport(report), /✗ Cargo could not be executed/);
});

test("keeps a missing binary distinct from a spawn failure and an unsupported version", () => {
  const missing = diagnose({
    run: fakeTools({ "pnpm --version": spawnError("pnpm", "ENOENT") }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  }).results.find((result) => result.name === "pnpm");
  const unsupported = diagnose({
    run: fakeTools({ "pnpm --version": "8.15.0" }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  }).results.find((result) => result.name === "pnpm");
  const execution = diagnose({
    run: fakeTools({ "pnpm --version": spawnError("pnpm") }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  }).results.find((result) => result.name === "pnpm");

  assert.equal(missing.reason, "missing");
  assert.match(missing.message, /pnpm not found/);
  assert.doesNotMatch(missing.message, /could not be executed|too old/);
  assert.equal(unsupported.reason, "unsupported");
  assert.match(unsupported.message, /pnpm 8\.15\.0 is too old/);
  assert.doesNotMatch(unsupported.message, /not found|could not be executed/);
  assert.equal(execution.reason, "execution-failure");
  assert.match(execution.message, /could not be executed/);
  assert.doesNotMatch(execution.message, /not found|too old/);
});

test("classifies a non-zero version probe as an execution failure", { skip: process.platform === "win32" }, () => {
  const directory = mkdtempSync(join(tmpdir(), "talos-doctor-"));
  try {
    const script = join(directory, "fake-tool");
    writeFileSync(script, "#!/bin/sh\necho 'permission denied' >&2\nexit 1\n");
    chmodSync(script, 0o755);
    assert.throws(
      () => runCommand(script, [], "linux"),
      (error) => error.code === "COMMAND_FAILED" && /permission denied/.test(error.message),
    );

    const base = fakeTools();
    const run = (command, args) => command === "pnpm" ? runCommand(script, args, "linux") : base(command, args);
    const report = diagnose({ run, nodeVersion: "v24.0.0", platform: "linux" });
    const pnpm = report.results.find((result) => result.name === "pnpm");

    assert.equal(report.exitCode, 1);
    assert.equal(pnpm.reason, "execution-failure");
    assert.match(pnpm.message, /pnpm could not be executed.*permission denied/);
    assert.doesNotMatch(pnpm.message, /not found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails when the Wasm target probe cannot be spawned", () => {
  const report = diagnose({
    run: fakeTools({ "rustup target list --installed": spawnError("rustup") }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  });
  const target = report.results.find((result) => result.name === "Rust Wasm target");

  assert.equal(report.exitCode, 1);
  assert.equal(target.reason, "execution-failure");
  assert.match(target.message, /Rust Wasm target could not be executed/);
  assert.doesNotMatch(target.message, /is not installed/);
});

test("keeps optional tool spawn failures as warnings without failing doctor", () => {
  const report = diagnose({
    run: fakeTools({ "stellar --version": spawnError("stellar") }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  });
  const stellar = report.results.find((result) => result.name === "Stellar CLI");

  assert.equal(report.exitCode, 0);
  assert.equal(stellar.ok, false);
  assert.equal(stellar.optional, true);
  assert.equal(stellar.reason, "execution-failure");
  assert.match(stellar.message, /Stellar CLI could not be executed/);
  assert.match(stellar.message, /Optional: install the Stellar CLI/);
  assert.match(formatReport(report), /! Stellar CLI could not be executed/);
});

test("preserves the optional missing-tool warning wording", () => {
  const report = diagnose({
    run: fakeTools({ "stellar --version": spawnError("stellar", "ENOENT") }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  });
  const stellar = report.results.find((result) => result.name === "Stellar CLI");

  assert.equal(report.exitCode, 0);
  assert.equal(stellar.reason, "missing");
  assert.match(stellar.message, /^not installed \(optional\)\./);
  assert.match(formatReport(report), /! not installed \(optional\)\./);
});

test("falls back to a working executable when an earlier candidate cannot be spawned", () => {
  const report = diagnose({
    run: fakeTools({
      "pnpm --version": spawnError("pnpm"),
      "pnpm.cmd --version": "9.15.0",
      "py -3 --version": "Python 3.12.2",
      "uv.exe --version": "uv 0.5.11",
      "rustup target list --installed": "wasm32-unknown-unknown",
      "docker.exe --version": "Docker version 27.3.1",
      "stellar.exe --version": "stellar 22.0.0",
    }),
    nodeVersion: "v24.0.0",
    platform: "win32",
  });

  assert.equal(report.exitCode, 0);
  assert.equal(report.results.find((result) => result.name === "pnpm").ok, true);
});

test("treats an empty version probe as an execution failure", () => {
  const report = diagnose({
    run: fakeTools({ "docker --version": "" }),
    nodeVersion: "v24.0.0",
    platform: "linux",
  });
  const docker = report.results.find((result) => result.name === "Docker");

  assert.equal(report.exitCode, 1);
  assert.equal(docker.reason, "execution-failure");
  assert.match(docker.message, /Docker could not be executed.*produced no output/);
});
