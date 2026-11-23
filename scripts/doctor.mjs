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

export const FAILURE_REASONS = Object.freeze({
  MISSING: "missing",
  UNSUPPORTED: "unsupported",
  EXECUTION_FAILURE: "execution-failure",
});

function sentence(...parts) {
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function detailSentence(message) {
  return /[.!?]$/.test(message) ? message : `${message}.`;
}

function isMissingError(error) {
  if (error?.code === "ENOENT") return true;
  return /not found|not recognized as an internal or external command|\bENOENT\b/i.test(String(error?.message ?? ""));
}

function describeExecutionFailure(error) {
  return String(error?.message ?? error ?? "").replace(/\s+/g, " ").trim() || "the executable could not be started";
}

export function runCommand(command, args, platform = process.platform) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: platform === "win32",
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(result.stderr?.trim() || `${command} exited with status ${result.status}`);
    error.code = result.status === 127 || result.status === 9009 ? "ENOENT" : "COMMAND_FAILED";
    throw error;
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

export function probe(run, candidates) {
  let failure = null;
  for (const [command, args] of candidates) {
    try {
      const output = run(command, args);
      if (output) return { command, output };
      if (failure?.reason !== FAILURE_REASONS.EXECUTION_FAILURE) {
        failure = {
          command,
          reason: FAILURE_REASONS.EXECUTION_FAILURE,
          message: `${command} produced no output`,
        };
      }
    } catch (error) {
      const reason = isMissingError(error) ? FAILURE_REASONS.MISSING : FAILURE_REASONS.EXECUTION_FAILURE;
      if (reason === FAILURE_REASONS.EXECUTION_FAILURE || failure?.reason !== FAILURE_REASONS.EXECUTION_FAILURE) {
        failure = {
          command,
          reason,
          message: describeExecutionFailure(error),
        };
      }
    }
  }
  return failure;
}

function failureResult(name, probed, hint, missingMessage) {
  if (probed?.reason === FAILURE_REASONS.EXECUTION_FAILURE) {
    return {
      name,
      ok: false,
      reason: FAILURE_REASONS.EXECUTION_FAILURE,
      message: sentence(`${name} could not be executed (${probed.command}).`, detailSentence(probed.message), hint),
    };
  }
  return {
    name,
    ok: false,
    reason: FAILURE_REASONS.MISSING,
    message: missingMessage ?? `${name} not found. ${hint}`,
  };
}

function presenceResult(name, probed, { describe, hint, missingMessage, optional = false }) {
  const optionalField = optional ? { optional: true } : {};
  if (!probed || probed.reason === FAILURE_REASONS.MISSING) {
    return { name, ok: false, reason: FAILURE_REASONS.MISSING, message: missingMessage, ...optionalField };
  }
  if (probed.reason === FAILURE_REASONS.EXECUTION_FAILURE) {
    return { ...failureResult(name, probed, hint, missingMessage), ...optionalField };
  }
  return { name, ok: true, message: describe(probed), ...optionalField };
}

function versionResult(name, output, minimum, hint, id) {
  const expected = `>=${minimum.join(".")}`;
  if (!output) {
    return {
      id,
      name,
      ok: false,
      severity: "error",
      code: "tool_missing",
      expected,
      observed: null,
      message: `${name} not found. ${hint}`,
    };
  }

  const version = parseVersion(output);
  if (!version) {
    return {
      id,
      name,
      ok: false,
      severity: "error",
      code: "version_unrecognized",
      expected,
      observed: null,
      message: `Could not read the ${name} version; expected ${expected}. ${hint}`,
    };
  }

  const versionText = version.join(".");
  if (compareVersions(version, minimum) < 0) {
    const minimumText = minimum.join(".");
    return {
      id,
      name,
      ok: false,
      severity: "error",
      code: "version_mismatch",
      expected,
      observed: versionText,
      message: `${name} ${versionText} is too old; ${minimumText} or newer is required. ${hint}`,
    };
  }
  return {
    id,
    name,
    ok: true,
    severity: "info",
    code: "ok",
    expected,
    observed: versionText,
    message: `${name} ${versionText}`,
  };
}

function probedVersionResult(name, probed, minimum, hint) {
  if (!probed || probed.reason) return failureResult(name, probed, hint);
  return versionResult(name, probed.output, minimum, hint);
}

export function diagnose({ run = runCommand, platform = process.platform, nodeVersion = process.version } = {}) {
  const results = [];
  const node = versionResult("Node.js", nodeVersion, MINIMUMS.node, INSTALL_HINTS.node, "node");
  results.push(node);

  const windows = platform === "win32";
  const pnpm = probe(run, windows
    ? [["pnpm", ["--version"]], ["pnpm.cmd", ["--version"]]]
    : [["pnpm", ["--version"]]]);
  results.push(versionResult("pnpm", pnpm?.output, MINIMUMS.pnpm, INSTALL_HINTS.pnpm, "pnpm"));

  const pythonCandidates = windows
    ? [["py", ["-3", "--version"]], ["python", ["--version"]], ["python3", ["--version"]]]
    : [["python3", ["--version"]], ["python", ["--version"]]];
  const python = probe(run, pythonCandidates);
  results.push(versionResult("Python", python?.output, MINIMUMS.python, INSTALL_HINTS.python, "python"));

  const uv = probe(run, windows
    ? [["uv", ["--version"]], ["uv.exe", ["--version"]]]
    : [["uv", ["--version"]]]);
  const uvVersion = uv ? parseVersion(uv.output) : null;
  const uvObserved = uvVersion?.join(".") ?? null;
  results.push({
    id: "uv",
    name: "uv",
    ok: Boolean(uvVersion),
    severity: uvVersion ? "info" : "error",
    code: uv ? (uvVersion ? "ok" : "version_unrecognized") : "tool_missing",
    expected: "installed (any version)",
    observed: uvObserved,
    message: uvVersion
      ? `uv ${uvObserved}`
      : uv
        ? `Could not read the uv version; expected an installed version. ${INSTALL_HINTS.uv}`
        : `uv not found. ${INSTALL_HINTS.uv}`,
  });

  const rustc = probe(run, [["rustc", ["--version"]]]);
  results.push({
    ...versionResult("Rust compiler", rustc?.output, [1, 0, 0], INSTALL_HINTS.rustc, "rustc"),
  });
  const cargo = probe(run, [["cargo", ["--version"]]]);
  results.push({
    ...versionResult("Cargo", cargo?.output, [1, 0, 0], INSTALL_HINTS.cargo, "cargo"),
  });

  const target = rustc && probe(run, [["rustup", ["target", "list", "--installed"]]]);
  const targetInstalled = target?.output.split(/\s+/).includes("wasm32-unknown-unknown") ?? false;
  results.push({
    id: "rust_wasm_target",
    name: "Rust Wasm target",
    ok: targetInstalled,
    severity: targetInstalled ? "info" : "error",
    code: targetInstalled ? "ok" : "target_missing",
    expected: "wasm32-unknown-unknown",
    observed: targetInstalled ? "installed" : "not installed",
    message: targetInstalled
      ? "wasm32-unknown-unknown installed"
      : `wasm32-unknown-unknown is not installed. ${INSTALL_HINTS.rustTarget}`,
  });

  const docker = probe(run, windows
    ? [["docker", ["--version"]], ["docker.exe", ["--version"]]]
    : [["docker", ["--version"]]]);
  results.push({
    ...versionResult("Docker", docker?.output, [1, 0, 0], INSTALL_HINTS.docker, "docker"),
  });

  const stellar = probe(run, windows
    ? [["stellar", ["--version"]], ["stellar.exe", ["--version"]]]
    : [["stellar", ["--version"]]]);
  const parsedStellarVersion = stellar ? parseVersion(stellar.output) : null;
  const stellarVersion = parsedStellarVersion?.join(".") ?? null;
  results.push({
    id: "stellar",
    name: "Stellar CLI",
    ok: Boolean(stellar),
    severity: stellar ? "info" : "warning",
    code: !stellar ? "optional_tool_missing" : parsedStellarVersion ? "ok" : "version_unrecognized",
    expected: "optional",
    observed: stellarVersion,
    optional: true,
    message: stellar
      ? (stellarVersion ? `stellar ${stellarVersion}` : "installed (version unavailable; optional)")
      : `not installed (optional). ${INSTALL_HINTS.stellar}`,
  });

  const failedRequired = results.some((result) => !result.ok && !result.optional);
  return { results, exitCode: failedRequired ? 1 : 0 };
}

export function formatReport({ results }) {
  const lines = ["Talos local toolchain doctor"];
  for (const result of results) {
    const marker = result.ok ? "✓" : result.optional ? "!" : "✗";
    lines.push(`${marker} ${result.message}`);
  }
  return lines.join("\n");
}

export function formatJsonReport({ results, exitCode }) {
  return JSON.stringify({ exitCode, findings: results }, null, 2);
}

function main(args = process.argv.slice(2)) {
  const report = diagnose();
  console.log(args.includes("--json") ? formatJsonReport(report) : formatReport(report));
  process.exitCode = report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
