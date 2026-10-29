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
