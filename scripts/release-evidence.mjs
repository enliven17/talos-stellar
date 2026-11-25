#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_BUNDLE_ARTIFACT_BYTES = 10 * 1024 * 1024;
const CHECK_ID = /^[a-z][a-z0-9._-]{0,63}$/;
const REVISION = /^[a-f0-9]{40,64}$/i;
const PRIVATE_PATH = /(^|\/)(?:\.env(?:[.-].*)?|secrets?)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
const PRIVATE_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/,
  /\bS[A-Z2-7]{55}\b/,
  /(?:^|\n)\s*[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|SEED)[A-Z0-9_]*\s*=\s*\S+/i,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
];

function assertCheckId(id) {
  if (!CHECK_ID.test(id)) throw new Error(`Invalid check identifier: ${id}`);
}

function parsePair(value, label) {
  const separator = value.indexOf("=");
  if (separator < 1) throw new Error(`${label} must use name=value syntax`);
  return [value.slice(0, separator), value.slice(separator + 1)];
}

async function readArtifact(root, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath) || /^[a-z]:[\\/]/i.test(relativePath) || relativePath.startsWith("\\\\")) {
    throw new Error(`Artifact path must be relative to the repository: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Artifact path escapes the repository: ${relativePath}`);
  }
  if (PRIVATE_PATH.test(normalized) || normalized.split("/").some((part) => part === ".git" || part === "node_modules")) {
    throw new Error(`Private or non-portable artifact path refused: ${relativePath}`);
  }

  const absolute = path.resolve(root, normalized);
  const rootReal = await realpath(root);
  const fileReal = await realpath(absolute);
  if (fileReal !== rootReal && !fileReal.startsWith(rootReal + path.sep)) {
    throw new Error(`Artifact path escapes the repository: ${relativePath}`);
  }
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Artifact must be a regular, non-symlink file: ${relativePath}`);
  }
  if (metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds the 2 MiB limit: ${relativePath}`);
  }

  const bytes = await readFile(absolute);
  const content = bytes.toString("utf8");
  if (PRIVATE_CONTENT.some((pattern) => pattern.test(content))) {
    throw new Error(`Artifact contains private environment or credential data: ${relativePath}`);
  }

  return {
    path: normalized,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    contentBase64: bytes.toString("base64"),
  };
}

export async function buildEvidenceBundle({
  root = process.cwd(),
  baselineRevision,
  requiredChecks = [],
  checkResults = [],
  artifactPaths = [],
} = {}) {
  if (typeof baselineRevision !== "string" || !REVISION.test(baselineRevision)) {
    throw new Error("A full 40- to 64-character hexadecimal baseline revision is required");
  }

  const statuses = new Map();
  const seenResults = new Set();
  for (const id of requiredChecks) {
    assertCheckId(id);
    if (statuses.has(id)) throw new Error(`Duplicate required check: ${id}`);
    statuses.set(id, "not-run");
  }
  for (const result of checkResults) {
    assertCheckId(result.id);
    if (!["passed", "failed", "not-run"].includes(result.status)) {
      throw new Error(`Invalid status for check ${result.id}: ${result.status}`);
    }
    if (seenResults.has(result.id)) throw new Error(`Duplicate check result: ${result.id}`);
    seenResults.add(result.id);
    statuses.set(result.id, result.status);
  }

  const checks = [...statuses.entries()]
    .map(([id, status]) => ({ id, status }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const artifacts = [];
  const seenPaths = new Set();
  let totalBytes = 0;
  for (const artifactPath of artifactPaths) {
    const artifact = await readArtifact(root, artifactPath);
    if (seenPaths.has(artifact.path)) throw new Error(`Duplicate artifact: ${artifact.path}`);
    seenPaths.add(artifact.path);
    totalBytes += artifact.sizeBytes;
    if (totalBytes > MAX_BUNDLE_ARTIFACT_BYTES) {
      throw new Error("Artifacts exceed the 10 MiB total bundle limit");
    }
    artifacts.push(artifact);
  }
  artifacts.sort((a, b) => a.path.localeCompare(b.path));

  return {
    schemaVersion: 1,
    baselineRevision: baselineRevision.toLowerCase(),
    checks,
    artifacts,
  };
}

function parseArgs(args) {
  const options = { requiredChecks: [], checkResults: [], artifactPaths: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === "--baseline") options.baselineRevision = value;
    else if (flag === "--required-check") options.requiredChecks.push(value);
    else if (flag === "--check") {
      const [id, status] = parsePair(value, "--check");
      options.checkResults.push({ id, status });
    } else if (flag === "--artifact") options.artifactPaths.push(value);
    else if (flag === "--output") options.outputPath = value;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.baselineRevision) throw new Error("--baseline is required");
  return options;
}

async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    const root = process.cwd();
    const bundle = await buildEvidenceBundle({ ...options, root });
    const outputPath = options.outputPath ?? "dist/release-evidence.json";
    if (path.isAbsolute(outputPath) || path.resolve(root, outputPath) === root ||
        !path.resolve(root, outputPath).startsWith(root + path.sep)) {
      throw new Error("Output path must be inside the repository");
    }
    const absoluteOutput = path.resolve(root, outputPath);
    await mkdir(path.dirname(absoluteOutput), { recursive: true });
    await writeFile(absoluteOutput, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "w" });
    console.log(`Release evidence bundle written to ${path.relative(root, absoluteOutput)}`);
  } catch (error) {
    console.error(`Release evidence refused: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
