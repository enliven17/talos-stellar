#!/usr/bin/env node
/**
 * check-lockfile-drift.mjs
 *
 * Lockfile drift gate for all package managers in the Talos monorepo.
 *
 * Validates that:
 *   1. pnpm: `pnpm install --frozen-lockfile` succeeds (root + web)
 *   2. uv: `uv sync --frozen --all-extras --all-groups` succeeds (prime-agent)
 *   3. cargo: `cargo check --locked` succeeds (contracts)
 *
 * This script is intentionally offline-first: it works without network access
 * when lockfiles are in sync. All checks operate on committed file contents.
 *
 * Usage:
 *   node scripts/check-lockfile-drift.mjs
 *   node scripts/check-lockfile-drift.mjs --json
 *   pnpm lockfile:check
 *
 * Exit codes:
 *   0 — no drift (all lockfiles in sync)
 *   1 — drift / validation failure
 *   2 — usage / argument error
 *
 * Local command: node scripts/check-lockfile-drift.mjs
 */

import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

let jsonMode = false;

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/check-lockfile-drift.mjs [--json]",
  );
  console.error("  --json        Output results as JSON");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  return opts;
}

function log(msg) {
  if (!jsonMode) {
    console.log(msg);
  }
}

function runCommand(name, cmd, args, cwd, opts = {}) {
  const { timeout = 120_000, env = process.env } = opts;
  const start = Date.now();
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout,
    cwd,
    env: { ...env, CI: "true" },
  });
  const duration = Date.now() - start;

  return {
    name,
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    duration,
    timedOut: result.status === null && result.signal === "SIGTERM",
  };
}

function checkPnpmLockfile(lockfilePath, packageJsonPath, cwd, name) {
  if (!existsSync(lockfilePath)) {
    return {
      name,
      ok: false,
      errors: [`Lockfile not found: ${lockfilePath}`],
      warnings: [],
    };
  }
  if (!existsSync(packageJsonPath)) {
    return {
      name,
      ok: false,
      errors: [`Package manifest not found: ${packageJsonPath}`],
      warnings: [],
    };
  }

  // Check if pnpm is available
  const pnpmCheck = spawnSync("pnpm", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (pnpmCheck.status !== 0) {
    return {
      name,
      ok: false,
      errors: [`pnpm not available in PATH. Install pnpm to verify lockfile.`],
      warnings: [],
    };
  }

  const result = runCommand(name, "pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], cwd);

  if (result.ok) {
    return {
      name,
      ok: true,
      errors: [],
      warnings: [],
    };
  }

  // Parse the error to provide actionable feedback
  const errors = [];
  const stderr = result.stderr;
  const stdout = result.stdout;
  const output = stderr + stdout;

  if (output.includes("LOCKFILE_MISMATCH") || output.includes("lockfile") && output.includes("out of date")) {
    errors.push(
      `${name} lockfile is out of sync with package.json.\n` +
        `  → Run: pnpm install (in ${cwd})\n` +
        `  → Then commit the updated ${lockfilePath.replace(repoRoot + "/", "")}`,
    );
  } else if (output.includes("ENOENT") || output.includes("not found")) {
    errors.push(
      `${name} lockfile references missing dependencies.\n` +
        `  → Run: pnpm install (in ${cwd})\n` +
        `  → Then commit the updated ${lockfilePath.replace(repoRoot + "/", "")}`,
    );
  } else if (output.includes("peer") && output.includes("conflict")) {
    errors.push(
      `${name} has peer dependency conflicts.\n` +
        `  → Resolve conflicts in package.json, then run pnpm install (in ${cwd})`,
    );
  } else {
    // Generic fallback - show first few lines of output
    const preview = output.split("\n").slice(0, 15).map((l) => `    ${l}`).join("\n");
    errors.push(
      `${name} frozen install failed (${result.duration}ms):\n${preview}\n` +
        `  → Run: pnpm install (in ${cwd}) to see full output`,
    );
  }

  return { name, ok: false, errors, warnings: [] };
}

function checkUvLockfile(lockfilePath, pyprojectPath, cwd, name) {
  if (!existsSync(lockfilePath)) {
    return {
      name,
      ok: false,
      errors: [`Lockfile not found: ${lockfilePath}`],
      warnings: [],
    };
  }
  if (!existsSync(pyprojectPath)) {
    return {
      name,
      ok: false,
      errors: [`Project manifest not found: ${pyprojectPath}`],
      warnings: [],
    };
  }

  // Check if uv is available
  const uvCheck = spawnSync("uv", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (uvCheck.status !== 0) {
    return {
      name,
      ok: false,
      errors: [`uv not available in PATH. Install uv to verify lockfile.`],
      warnings: [],
    };
  }

  const result = runCommand(
    name,
    "uv",
    ["sync", "--frozen", "--all-extras", "--all-groups"],
    cwd,
  );

  if (result.ok) {
    return { name, ok: true, errors: [], warnings: [] };
  }

  const errors = [];
  const output = result.stderr + result.stdout;

  if (output.includes("lock") && (output.includes("mismatch") || output.includes("out of date") || output.includes("changed"))) {
    errors.push(
      `${name} lockfile is out of sync with pyproject.toml.\n` +
        `  → Run: uv sync --all-extras --all-groups (in ${cwd})\n` +
        `  → Then commit the updated ${lockfilePath.replace(repoRoot + "/", "")}`,
    );
  } else if (output.includes("No solution found") || output.includes("conflict")) {
    errors.push(
      `${name} has unresolvable dependency conflicts.\n` +
        `  → Resolve conflicts in pyproject.toml, then run uv sync (in ${cwd})`,
    );
  } else {
    const preview = output.split("\n").slice(0, 15).map((l) => `    ${l}`).join("\n");
    errors.push(
      `${name} frozen sync failed (${result.duration}ms):\n${preview}\n` +
        `  → Run: uv sync --all-extras --all-groups (in ${cwd}) to see full output`,
    );
  }

  return { name, ok: false, errors, warnings: [] };
}

function checkCargoLockfile(lockfilePath, cargoTomlPath, cwd, name) {
  if (!existsSync(lockfilePath)) {
    return {
      name,
      ok: false,
      errors: [`Lockfile not found: ${lockfilePath}`],
      warnings: [],
    };
  }
  if (!existsSync(cargoTomlPath)) {
    return {
      name,
      ok: false,
      errors: [`Cargo manifest not found: ${cargoTomlPath}`],
      warnings: [],
    };
  }

  // Check if cargo is available
  const cargoCheck = spawnSync("cargo", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (cargoCheck.status !== 0) {
    return {
      name,
      ok: false,
      errors: [`cargo not available in PATH. Install Rust toolchain to verify lockfile.`],
      warnings: [],
    };
  }

  // cargo check --locked is faster than build and validates the lockfile
  const result = runCommand(name, "cargo", ["check", "--locked", "--workspace"], cwd);

  if (result.ok) {
    return { name, ok: true, errors: [], warnings: [] };
  }

  const errors = [];
  const output = result.stderr + result.stdout;

  if (output.includes("Cargo.lock") && (output.includes("needs to be updated") || output.includes("out of date") || output.includes("mismatch"))) {
    errors.push(
      `${name} Cargo.lock is out of sync with Cargo.toml.\n` +
        `  → Run: cargo update (in ${cwd})\n` +
        `  → Then commit the updated ${lockfilePath.replace(repoRoot + "/", "")}`,
    );
  } else if (output.includes("failed to select a version") || output.includes("conflict")) {
    errors.push(
      `${name} has unresolvable dependency conflicts.\n` +
        `  → Resolve conflicts in Cargo.toml, then run cargo update (in ${cwd})`,
    );
  } else {
    const preview = output.split("\n").slice(0, 15).map((l) => `    ${l}`).join("\n");
    errors.push(
      `${name} locked check failed (${result.duration}ms):\n${preview}\n` +
        `  → Run: cargo check --locked (in ${cwd}) to see full output`,
    );
  }

  return { name, ok: false, errors, warnings: [] };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  jsonMode = opts.json;

  const checks = [];

  // ── Check 1: Root pnpm lockfile (workspace) ──────────────────────────────
  log("Checking root pnpm lockfile...");
  checks.push(
    checkPnpmLockfile(
      join(repoRoot, "pnpm-lock.yaml"),
      join(repoRoot, "package.json"),
      repoRoot,
      "root pnpm",
    ),
  );

  // ── Check 2: Web pnpm lockfile ───────────────────────────────────────────
  log("Checking web pnpm lockfile...");
  checks.push(
    checkPnpmLockfile(
      join(repoRoot, "web", "pnpm-lock.yaml"),
      join(repoRoot, "web", "package.json"),
      join(repoRoot, "web"),
      "web pnpm",
    ),
  );

  // ── Check 3: Prime Agent uv lockfile ─────────────────────────────────────
  log("Checking prime-agent uv lockfile...");
  checks.push(
    checkUvLockfile(
      join(repoRoot, "packages", "prime-agent", "uv.lock"),
      join(repoRoot, "packages", "prime-agent", "pyproject.toml"),
      join(repoRoot, "packages", "prime-agent"),
      "prime-agent uv",
    ),
  );

  // ── Check 4: Contracts Cargo lockfile ────────────────────────────────────
  log("Checking contracts Cargo lockfile...");
  checks.push(
    checkCargoLockfile(
      join(repoRoot, "contracts", "Cargo.lock"),
      join(repoRoot, "contracts", "Cargo.toml"),
      join(repoRoot, "contracts"),
      "contracts cargo",
    ),
  );

  // ── Output ────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  const passed = checks.filter((c) => c.ok);

  if (opts.json) {
    const output = {
      total: checks.length,
      passed: passed.length,
      failed: failed.length,
      checks: checks.map(({ name, ok, errors, warnings }) => ({
        name,
        ok,
        errors,
        warnings,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(failed.length > 0 ? 1 : 0);
  }

  // Human-readable
  for (const c of checks) {
    if (c.ok) {
      console.log(`✓ ${c.name}`);
      for (const w of c.warnings ?? []) console.warn(`  warning: ${w}`);
    } else {
      console.error(`✗ ${c.name}`);
      for (const e of c.errors ?? []) console.error(`  error: ${e}`);
      for (const w of c.warnings ?? []) console.warn(`  warning: ${w}`);
    }
  }

  console.log("");

  if (failed.length > 0) {
    console.error(
      `✗ Lockfile drift check failed: ${failed.length}/${checks.length} check(s) have errors.`,
    );
    console.error("  Fix the errors above, then re-run:");
    console.error("    node scripts/check-lockfile-drift.mjs");
    console.error("  To update all lockfiles locally:");
    console.error("    pnpm install          # root + web (workspace)");
    console.error("    cd packages/prime-agent && uv sync --all-extras --all-groups");
    console.error("    cd contracts && cargo update");
    process.exit(1);
  } else {
    console.log(
      `✓ Lockfile drift check passed: ${passed.length}/${checks.length} check(s) clean.`,
    );
  }
}

main();