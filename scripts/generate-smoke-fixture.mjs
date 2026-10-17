#!/usr/bin/env node
/**
 * generate-smoke-fixture.mjs
 *
 * Deterministic regeneration for the full-stack smoke fixture
 * `web/tests/fixtures/smoke-fixture.json`.
 *
 * - Output is canonical JSON: sorted keys, 2-space indent, trailing newline.
 * - Deterministic: no timestamps, no randomness, no env, no network — every
 *   run on any machine produces byte-identical output.
 * - Fail closed: the generated fixture is validated before writing; invalid
 *   or ambiguous content aborts with a non-zero exit and no partial writes.
 * - Privacy-safe: never reads, generates, or logs secrets, seeds, keys, or
 *   payment material. All fixture values are placeholders.
 *
 * Usage:
 *   node scripts/generate-smoke-fixture.mjs            # regenerate
 *   node scripts/generate-smoke-fixture.mjs --check    # CI drift check
 *
 * pnpm aliases (root package.json):
 *   pnpm smoke:fixture:gen
 *   pnpm smoke:fixture:check
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import {
  buildSmokeFixture,
  canonicalize,
  findDrift,
  validateSmokeFixture,
  FIXTURE_REL_PATH,
} from "./smoke-fixture.lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const fixturePath = resolve(repoRoot, FIXTURE_REL_PATH);
const isCheck = process.argv.includes("--check");

const expected = canonicalize(buildSmokeFixture());

// Fail closed: refuse to emit or accept a fixture that does not validate.
const validation = validateSmokeFixture(JSON.parse(expected));
if (!validation.ok) {
  console.error(
    `smoke-fixture: internal fixture definition is invalid — aborting (${validation.errors.length} error(s)):`,
  );
  for (const message of validation.errors) console.error(`  - ${message}`);
  process.exit(1);
}

if (isCheck) {
  if (!existsSync(fixturePath)) {
    console.error(`smoke-fixture: ${FIXTURE_REL_PATH} is missing. Run: pnpm smoke:fixture:gen`);
    process.exit(1);
  }

  let actual;
  try {
    actual = readFileSync(fixturePath, "utf8");
  } catch {
    console.error(`smoke-fixture: unable to read ${FIXTURE_REL_PATH}`);
    process.exit(1);
  }

  const drift = findDrift(expected, actual);
  if (drift) {
    console.error(`smoke-fixture: fixture drift — ${drift}. Run: pnpm smoke:fixture:gen`);
    process.exit(1);
  }

  console.log("smoke-fixture: check ok — fixture is deterministic and canonical");
  process.exit(0);
}

mkdirSync(dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, expected, "utf8");
console.log(`smoke-fixture: wrote ${FIXTURE_REL_PATH} (${Buffer.byteLength(expected, "utf8")} bytes, canonical)`);
