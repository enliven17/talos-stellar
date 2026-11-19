#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MINIMUMS = {
  node: [20, 0, 0],
  pnpm: [9, 0, 0],
  python: [3, 11, 0],
};

const INSTALL_HINTS = {
  node: "Install Node.js 20 or newer from https://nodejs.org/.",
  pnpm: "Enable Corepack, then run `corepack prepare pnpm@9 --activate`.",
  python: "Install Python 3.11 or newer from https://www.python.org/downloads/.",
  uv: "Install uv using the instructions at https://docs.astral.sh/uv/getting-started/installation/.",
  rustc: "Install the stable Rust toolchain with rustup: https://rustup.rs/.",
  cargo: "Install the stable Rust toolchain with rustup: https://rustup.rs/.",
  rustTarget: "Run `rustup target add wasm32-unknown-unknown`.",
  docker: "Install Docker Desktop or Docker Engine: https://docs.docker.com/get-docker/.",
  stellar: "Optional: install the Stellar CLI with `cargo install --locked stellar-cli --features opt`.",
};

function runCommand(command, args, platform = process.platform) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: platform === "win32",
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `${command} exited with status ${result.status}`);
  }
  return result.stdout.trim();
}

function parseVersion(output) {
  const match = String(output).match(/(?:^|\D)(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? match.slice(1).map((part) => Number(part ?? 0)) : null;
}

function compareVersions(actual, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const difference = (actual[index] ?? 0) - minimum[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function probe(run, candidates) {
  for (const [command, args] of candidates) {
    try {
      const output = run(command, args);
      if (output) return { command, output };
    } catch {
      // Try another platform-specific executable name before reporting missing.
    }
  }
  return null;
}

function versionResult(name, output, minimum, hint) {
  if (!output) {
    return { name, ok: false, message: `${name} not found. ${hint}` };
  }

  const version = parseVersion(output);
  if (!version) {
    return { name, ok: false, message: `Could not read the ${name} version from “${output}”. ${hint}` };
  }

  const versionText = version.join(".");
  if (compareVersions(version, minimum) < 0) {
    const minimumText = minimum.join(".");
    return {
      name,
      ok: false,
      message: `${name} ${versionText} is too old; ${minimumText} or newer is required. ${hint}`,
    };
  }
  return { name, ok: true, message: `${name} ${versionText}` };
}

export function diagnose({ run = runCommand, platform = process.platform, nodeVersion = process.version } = {}) {
  const results = [];
  const node = versionResult("Node.js", nodeVersion, MINIMUMS.node, INSTALL_HINTS.node);
  results.push(node);

  const windows = platform === "win32";
  const pnpm = probe(run, windows
    ? [["pnpm", ["--version"]], ["pnpm.cmd", ["--version"]]]
    : [["pnpm", ["--version"]]]);
  results.push(versionResult("pnpm", pnpm?.output, MINIMUMS.pnpm, INSTALL_HINTS.pnpm));

  const pythonCandidates = windows
    ? [["py", ["-3", "--version"]], ["python", ["--version"]], ["python3", ["--version"]]]
    : [["python3", ["--version"]], ["python", ["--version"]]];
  const python = probe(run, pythonCandidates);
  results.push(versionResult("Python", python?.output, MINIMUMS.python, INSTALL_HINTS.python));

  const uv = probe(run, windows
    ? [["uv", ["--version"]], ["uv.exe", ["--version"]]]
    : [["uv", ["--version"]]]);
  results.push({
    name: "uv",
    ok: Boolean(uv),
    message: uv ? `uv ${parseVersion(uv.output)?.join(".") ?? uv.output}` : `uv not found. ${INSTALL_HINTS.uv}`,
  });

  const rustc = probe(run, [["rustc", ["--version"]]]);
  results.push({
    name: "Rust compiler",
    ...versionResult("Rust compiler", rustc?.output, [1, 0, 0], INSTALL_HINTS.rustc),
  });
  const cargo = probe(run, [["cargo", ["--version"]]]);
  results.push({
    name: "Cargo",
    ...versionResult("Cargo", cargo?.output, [1, 0, 0], INSTALL_HINTS.cargo),
  });

  const target = rustc && probe(run, [["rustup", ["target", "list", "--installed"]]]);
  const targetInstalled = target?.output.split(/\s+/).includes("wasm32-unknown-unknown") ?? false;
  results.push({
    name: "Rust Wasm target",
    ok: targetInstalled,
    message: targetInstalled
      ? "wasm32-unknown-unknown installed"
      : `wasm32-unknown-unknown is not installed. ${INSTALL_HINTS.rustTarget}`,
  });

  const docker = probe(run, windows
    ? [["docker", ["--version"]], ["docker.exe", ["--version"]]]
    : [["docker", ["--version"]]]);
  results.push({
    name: "Docker",
    ...versionResult("Docker", docker?.output, [1, 0, 0], INSTALL_HINTS.docker),
  });

  const stellar = probe(run, windows
    ? [["stellar", ["--version"]], ["stellar.exe", ["--version"]]]
    : [["stellar", ["--version"]]]);
  const stellarVersion = stellar?.output.split(/\s+/).slice(0, 2).join(" ");
  results.push({
    name: "Stellar CLI",
    ok: Boolean(stellar),
    optional: true,
    message: stellar ? stellarVersion : `not installed (optional). ${INSTALL_HINTS.stellar}`,
  });

  return {
    results,
    exitCode: results.some((result) => !result.ok && !result.optional) ? 1 : 0,
  };
}

export function formatReport({ results }) {
  const lines = ["Talos local toolchain doctor"];
  for (const result of results) {
    const marker = result.ok ? "✓" : result.optional ? "!" : "✗";
    lines.push(`${marker} ${result.message}`);
  }
  return lines.join("\n");
}

function main() {
  const report = diagnose();
  console.log(formatReport(report));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
