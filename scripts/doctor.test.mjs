import assert from "node:assert/strict";
import test from "node:test";
import { diagnose, formatReport } from "./doctor.mjs";

function tools(outputs) {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`.trim();
    if (!(key in outputs)) throw new Error(`${command} was not found`);
    return outputs[key];
  };
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

test("distinguishes a binary that exists but cannot be spawned from a missing one", () => {
  const report = diagnose({
    run: (command, args) => {
      const key = `${command} ${args.join(" ")}`.trim();
      if (command === "pnpm") {
        const error = new Error("EACCES: permission denied, spawn pnpm");
        error.code = "EACCES";
        throw error;
      }
      if (!(key in healthyTools)) throw Object.assign(new Error(`${command} was not found`), { code: "ENOENT" });
      return healthyTools[key];
    },
    nodeVersion: "v20.0.0",
    platform: "linux",
  });

  const pnpm = report.results.find((result) => result.name === "pnpm");
  assert.equal(pnpm.ok, false);
  assert.match(pnpm.message, /pnpm is installed but could not be executed: permission denied/);
  assert.doesNotMatch(pnpm.message, /pnpm not found/);
  assert.equal(report.exitCode, 1);
  assert.match(formatReport(report), /✗ pnpm is installed/);
});

test("surfaces the failure output when a tool exits non-zero", () => {
  const report = diagnose({
    run: (command, args) => {
      if (command === "docker") throw new Error("Cannot connect to the Docker daemon");
      const key = `${command} ${args.join(" ")}`.trim();
      if (!(key in healthyTools)) throw Object.assign(new Error(`${command} was not found`), { code: "ENOENT" });
      return healthyTools[key];
    },
    nodeVersion: "v20.0.0",
    platform: "linux",
  });

  const docker = report.results.find((result) => result.name === "Docker");
  assert.equal(docker.ok, false);
  assert.match(docker.message, /could not be executed: Cannot connect to the Docker daemon/);
  assert.equal(report.exitCode, 1);
});

test("reads the Windows shell's 'not recognized' message as a missing tool", () => {
  const report = diagnose({
    run: (command, args) => {
      const key = `${command} ${args.join(" ")}`.trim();
      if (command === "pnpm" || command === "pnpm.cmd") {
        throw new Error("'pnpm' is not recognized as an internal or external command");
      }
      if (!(key in healthyTools)) throw Object.assign(new Error(`${command} was not found`), { code: "ENOENT" });
      return healthyTools[key];
    },
    nodeVersion: "v22.0.0",
    platform: "win32",
  });

  const pnpm = report.results.find((result) => result.name === "pnpm");
  assert.match(pnpm.message, /pnpm not found/);
  assert.doesNotMatch(pnpm.message, /could not be executed/);
});

test("an optional tool that fails to spawn is reported but does not fail the doctor", () => {
  const report = diagnose({
    run: (command, args) => {
      if (command === "stellar") throw new Error("stellar exited with status 127");
      const key = `${command} ${args.join(" ")}`.trim();
      if (!(key in healthyTools)) throw Object.assign(new Error(`${command} was not found`), { code: "ENOENT" });
      return healthyTools[key];
    },
    nodeVersion: "v20.0.0",
    platform: "linux",
  });

  const stellar = report.results.find((result) => result.name === "Stellar CLI");
  assert.equal(stellar.ok, false);
  assert.equal(stellar.optional, true);
  assert.match(stellar.message, /could not be executed/);
  assert.equal(report.exitCode, 0);
  assert.match(formatReport(report), /! Stellar CLI is installed/);
});

test("still reports the version of a tool that runs correctly after a failure elsewhere", () => {
  const report = diagnose({ run: tools(healthyTools), nodeVersion: "v20.5.0", platform: "linux" });
  const docker = report.results.find((result) => result.name === "Docker");
  assert.equal(docker.ok, true);
  assert.match(docker.message, /Docker 27\.3\.1/);
  assert.equal(report.exitCode, 0);
});
