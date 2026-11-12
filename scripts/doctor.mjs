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

export function classifyFailure(command, error) {
  const code = error?.code;
  const message = String(error?.message ?? error ?? "").trim();

  // The executable is not on PATH at all. On Windows the probe runs through a
  // shell, so a missing binary surfaces as the shell's own wording instead of
  // ENOENT — both spellings mean the same thing here.
  if (code === "ENOENT" || /not recognized as an internal or external command|command not found|not found/i.test(message)) {
    return { status: "missing", detail: "" };
  }

  // The executable is there but the system refused to start it.
  if (code === "EACCES" || code === "EPERM") {
    return { status: "failed", detail: "permission denied" };
  }

  // It started and exited non-zero, or the spawn itself failed for another
  // reason: report what we got so the reader can act on it.
  return { status: "failed", detail: message || `${command} could not be executed` };
}

function probe(run, candidates) {
  for (const [command, args] of candidates) {
    try {
      const output = run(command, args);
      if (output) return { command, output, status: "ok" };
    } catch (error) {
      const failure = classifyFailure(command, error);
      // A binary that exists but cannot run is a different problem from one
      // that is absent, and trying an alternative executable name will not fix
      // it — report it instead of falling through to "not found".
      if (failure.status === "failed") return { command, ...failure };
      // Otherwise try another platform-specific executable name.
    }
  }
  return { status: "missing" };
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

/**
 * Describes a tool whose executable was found but could not be run — a broken
 * install, a permission problem or a non-zero exit. Returns `null` when the
 * probe did not fail that way, so the caller can fall back to `versionResult`.
 */
export function failureResult(name, result, hint) {
  if (result?.status !== "failed") return null;
  const detail = result.detail ? `: ${result.detail}` : "";
  return {
    name,
    ok: false,
    message: `${name} is installed but could not be executed${detail}. ${hint}`,
  };
}

export function diagnose({ run = runCommand, platform = process.platform, nodeVersion = process.version } = {}) {
  const results = [];
  const node = versionResult("Node.js", nodeVersion, MINIMUMS.node, INSTALL_HINTS.node);
  results.push(node);

  const windows = platform === "win32";
  const pnpm = probe(run, windows
    ? [["pnpm", ["--version"]], ["pnpm.cmd", ["--version"]]]
    : [["pnpm", ["--version"]]]);
  results.push(
    failureResult("pnpm", pnpm, INSTALL_HINTS.pnpm)
      ?? versionResult("pnpm", pnpm?.output, MINIMUMS.pnpm, INSTALL_HINTS.pnpm),
  );

  const pythonCandidates = windows
    ? [["py", ["-3", "--version"]], ["python", ["--version"]], ["python3", ["--version"]]]
    : [["python3", ["--version"]], ["python", ["--version"]]];
  const python = probe(run, pythonCandidates);
  results.push(
    failureResult("Python", python, INSTALL_HINTS.python)
      ?? versionResult("Python", python?.output, MINIMUMS.python, INSTALL_HINTS.python),
  );

  const uv = probe(run, windows
    ? [["uv", ["--version"]], ["uv.exe", ["--version"]]]
    : [["uv", ["--version"]]]);
  results.push(failureResult("uv", uv, INSTALL_HINTS.uv) ?? {
    name: "uv",
    ok: Boolean(uv?.output),
    message: uv?.output
      ? `uv ${parseVersion(uv.output)?.join(".") ?? uv.output}`
      : `uv not found. ${INSTALL_HINTS.uv}`,
  });

  const rustc = probe(run, [["rustc", ["--version"]]]);
  results.push({
    name: "Rust compiler",
    ...(failureResult("Rust compiler", rustc, INSTALL_HINTS.rustc)
      ?? versionResult("Rust compiler", rustc?.output, [1, 0, 0], INSTALL_HINTS.rustc)),
  });
  const cargo = probe(run, [["cargo", ["--version"]]]);
  results.push({
    name: "Cargo",
    ...(failureResult("Cargo", cargo, INSTALL_HINTS.cargo)
      ?? versionResult("Cargo", cargo?.output, [1, 0, 0], INSTALL_HINTS.cargo)),
  });

  const target = rustc?.status !== "failed" && rustc?.output
    ? probe(run, [["rustup", ["target", "list", "--installed"]]])
    : null;
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
    ...(failureResult("Docker", docker, INSTALL_HINTS.docker)
      ?? versionResult("Docker", docker?.output, [1, 0, 0], INSTALL_HINTS.docker)),
  });

  const stellar = probe(run, windows
    ? [["stellar", ["--version"]], ["stellar.exe", ["--version"]]]
    : [["stellar", ["--version"]]]);
  const stellarVersion = stellar?.output?.split(/\s+/).slice(0, 2).join(" ");
  const stellarFailure = failureResult("Stellar CLI", stellar, INSTALL_HINTS.stellar);
  results.push(stellarFailure
    ? { ...stellarFailure, optional: true }
    : {
      name: "Stellar CLI",
      ok: Boolean(stellar?.output),
      optional: true,
      message: stellarVersion || `not installed (optional). ${INSTALL_HINTS.stellar}`,
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
