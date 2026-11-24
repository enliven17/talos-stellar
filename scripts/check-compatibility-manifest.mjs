#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_PATH = "compatibility.json";

const REQUIRED_TOOLCHAINS = ["node", "pnpm", "python", "rust"];
const REQUIRED_SCHEMAS = ["events", "logs", "databaseMigrations"];

function parseVersionRange(range, label) {
  const match = String(range).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) {
    throw new Error(`${label}: cannot parse version range "${range}"`);
  }
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function normalizeVersion(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a version string`);
  }
  return parseVersionRange(value, label);
}

function formatVersion([major, minor, patch]) {
  return `${major}.${minor}.${patch}`;
}

function sameVersion(left, right) {
  return left.every((part, index) => part === right[index]);
}

function assertManifestShape(manifest) {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("compatibility manifest must be a JSON object");
  }
  if (manifest.manifestVersion !== 1) {
    throw new Error("manifestVersion must be 1");
  }
  for (const name of REQUIRED_TOOLCHAINS) {
    if (!manifest.toolchains?.[name]) {
      throw new Error(`toolchains.${name} is missing`);
    }
  }
  if (typeof manifest.toolchains.rust.edition !== "string") {
    throw new Error("toolchains.rust.edition must be a string");
  }
  if (typeof manifest.toolchains.rust.channel !== "string") {
    throw new Error("toolchains.rust.channel must be a string");
  }
  if (typeof manifest.toolchains.rust.wasmTarget !== "string") {
    throw new Error("toolchains.rust.wasmTarget must be a string");
  }
  for (const name of REQUIRED_SCHEMAS) {
    if (manifest.schemas?.[name]?.version === undefined) {
      throw new Error(`schemas.${name}.version is missing`);
    }
  }
}

async function readText(rootDir, relativePath) {
  try {
    return await readFile(path.join(rootDir, relativePath), "utf8");
  } catch (error) {
    throw new Error(`cannot read ${relativePath}: ${error.message}`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseDoctorMinimum(doctorSource, name) {
  const pattern = new RegExp(`${name}:\\s*\\[\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\]`);
  const match = doctorSource.match(pattern);
  if (!match) {
    throw new Error(`scripts/doctor.mjs: cannot find MINIMUMS.${name}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function addVersionCheck(checks, id, expectedValue, actualValue, source) {
  const expected = normalizeVersion(expectedValue, id);
  const actual = actualValue;
  checks.push({
    id,
    expected: formatVersion(expected),
    actual: formatVersion(actual),
    source,
    ok: sameVersion(expected, actual),
  });
}

function addValueCheck(checks, id, expected, actual, source) {
  checks.push({
    id,
    expected: String(expected),
    actual: String(actual),
    source,
    ok: String(expected) === String(actual),
  });
}

async function collectRustEditions(rootDir) {
  const contractsDir = path.join(rootDir, "contracts");
  let entries;
  try {
    entries = await readdir(contractsDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot read contracts/: ${error.message}`);
  }

  const editions = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let cargoToml;
    try {
      cargoToml = await readFile(path.join(contractsDir, entry.name, "Cargo.toml"), "utf8");
    } catch {
      continue;
    }
    if (!/^\s*\[package\]/m.test(cargoToml)) continue;
    const match = cargoToml.match(/^\s*edition\s*=\s*"([^"]+)"/m);
    editions.set(entry.name, match?.[1] ?? "missing");
  }

  if (editions.size === 0) {
    throw new Error("contracts/: no crate Cargo.toml files found");
  }
  return editions;
}

/**
 * Compare the compatibility manifest with the versions the repository
 * actually declares. Throws when a source is missing or unparsable so CI
 * fails closed instead of silently passing.
 */
export async function checkCompatibility({
  rootDir = process.cwd(),
  manifestPath = MANIFEST_PATH,
} = {}) {
  const manifest = parseJson(await readText(rootDir, manifestPath), manifestPath);
  assertManifestShape(manifest);

  const checks = [];

  const packageJson = parseJson(await readText(rootDir, "package.json"), "package.json");
  const nodeRange = packageJson?.engines?.node;
  if (!nodeRange) {
    throw new Error("package.json: engines.node is missing");
  }
  addVersionCheck(
    checks,
    "node.minimum",
    manifest.toolchains.node.minimum,
    parseVersionRange(nodeRange, "package.json engines.node"),
    "package.json#engines.node",
  );

  const pyproject = await readText(rootDir, "packages/prime-agent/pyproject.toml");
  const requiresPython = pyproject.match(/^\s*requires-python\s*=\s*"([^"]+)"/m)?.[1];
  if (!requiresPython) {
    throw new Error("packages/prime-agent/pyproject.toml: requires-python is missing");
  }
  addVersionCheck(
    checks,
    "python.minimum",
    manifest.toolchains.python.minimum,
    parseVersionRange(requiresPython, "pyproject requires-python"),
    "packages/prime-agent/pyproject.toml#project.requires-python",
  );

  const doctorSource = await readText(rootDir, "scripts/doctor.mjs");
  addVersionCheck(
    checks,
    "node.contributorMinimum",
    manifest.toolchains.node.contributorMinimum,
    parseDoctorMinimum(doctorSource, "node"),
    "scripts/doctor.mjs MINIMUMS.node",
  );
  addVersionCheck(
    checks,
    "pnpm.minimum",
    manifest.toolchains.pnpm.minimum,
    parseDoctorMinimum(doctorSource, "pnpm"),
    "scripts/doctor.mjs MINIMUMS.pnpm",
  );
  addVersionCheck(
    checks,
    "python.contributorMinimum",
    manifest.toolchains.python.contributorMinimum,
    parseDoctorMinimum(doctorSource, "python"),
    "scripts/doctor.mjs MINIMUMS.python",
  );

  const rust = manifest.toolchains.rust;
  const editions = await collectRustEditions(rootDir);
  const editionMismatches = [...editions.entries()].filter(
    ([, edition]) => edition !== rust.edition,
  );
  checks.push({
    id: "rust.edition",
    expected: rust.edition,
    actual: editionMismatches.length
      ? editionMismatches.map(([crate, edition]) => `${crate}=${edition}`).join(", ")
      : rust.edition,
    source: "contracts/*/Cargo.toml",
    ok: editionMismatches.length === 0,
  });

  const contractsCi = await readText(rootDir, ".github/workflows/contracts-ci.yml");
  const devcontainer = await readText(rootDir, ".devcontainer/Dockerfile");
  addValueCheck(
    checks,
    "rust.channel",
    rust.channel,
    contractsCi.includes(`rust-toolchain@${rust.channel}`) &&
      devcontainer.includes(`--default-toolchain ${rust.channel}`)
      ? rust.channel
      : "mismatch",
    ".github/workflows/contracts-ci.yml, .devcontainer/Dockerfile",
  );
  addValueCheck(
    checks,
    "rust.wasmTarget",
    rust.wasmTarget,
    contractsCi.includes(rust.wasmTarget) && devcontainer.includes(rust.wasmTarget)
      ? rust.wasmTarget
      : "mismatch",
    ".github/workflows/contracts-ci.yml, .devcontainer/Dockerfile",
  );

  const eventsSource = await readText(rootDir, "packages/sdk/src/events.ts");
  const eventsVersion = eventsSource.match(/TALOS_EVENT_SCHEMA_VERSION\s*=\s*"([^"]+)"/)?.[1];
  if (eventsVersion === undefined) {
    throw new Error("packages/sdk/src/events.ts: TALOS_EVENT_SCHEMA_VERSION is missing");
  }
  addValueCheck(
    checks,
    "schemas.events.version",
    manifest.schemas.events.version,
    eventsVersion,
    "packages/sdk/src/events.ts#TALOS_EVENT_SCHEMA_VERSION",
  );

  const logSource = await readText(rootDir, "web/src/lib/log-schema.ts");
  const logVersion = logSource.match(/LOG_SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
  if (logVersion === undefined) {
    throw new Error("web/src/lib/log-schema.ts: LOG_SCHEMA_VERSION is missing");
  }
  addValueCheck(
    checks,
    "schemas.logs.version",
    manifest.schemas.logs.version,
    logVersion,
    "web/src/lib/log-schema.ts#LOG_SCHEMA_VERSION",
  );

  const journal = parseJson(
    await readText(rootDir, "web/drizzle/meta/_journal.json"),
    "web/drizzle/meta/_journal.json",
  );
  const latestMigration = journal?.entries?.at(-1)?.tag;
  if (latestMigration === undefined) {
    throw new Error("web/drizzle/meta/_journal.json: entries[-1].tag is missing");
  }
  addValueCheck(
    checks,
    "schemas.databaseMigrations.version",
    manifest.schemas.databaseMigrations.version,
    latestMigration,
    "web/drizzle/meta/_journal.json#entries[-1].tag",
  );

  return { manifest, checks, ok: checks.every((check) => check.ok) };
}

export function formatReport({ checks, ok }) {
  const lines = checks.map(
    (check) =>
      `${check.ok ? "ok  " : "FAIL"} ${check.id}: expected ${check.expected}, found ${check.actual} (${check.source})`,
  );
  lines.push(
    ok
      ? "OK: compatibility manifest matches the repository."
      : `FAILED: ${checks.filter((check) => !check.ok).length} compatibility mismatch(es).`,
  );
  return lines.join("\n");
}

async function main() {
  try {
    const result = await checkCompatibility();
    console.log(formatReport(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
