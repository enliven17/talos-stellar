#!/usr/bin/env node
/**
 * check-lockfile-drift.test.mjs
 *
 * Unit tests for scripts/check-lockfile-drift.mjs.
 *
 * Covers:
 *   - CLI argument parsing
 *   - JSON output format
 *   - Error handling for missing package managers
 *   - Structural validation (without requiring full toolchains)
 *
 * Run locally:
 *   node --test scripts/check-lockfile-drift.test.mjs
 *
 * Exit codes follow node:test conventions (0 = all pass, non-zero = failures).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "check-lockfile-drift.mjs");

let _tmpDir = null;

function getTmpDir() {
  if (!_tmpDir) {
    _tmpDir = join(tmpdir(), `lockfile-drift-test-${process.pid}`);
    mkdirSync(_tmpDir, { recursive: true });
  }
  return _tmpDir;
}

function tmpFile(name, content) {
  const fp = join(getTmpDir(), name);
  writeFileSync(fp, content, "utf8");
  return fp;
}

function runDrift(...args) {
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args],
