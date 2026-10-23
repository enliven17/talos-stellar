/**
 * Export-map checks for the published `@talos-protocol/sdk` manifest.
 *
 * These tests run without a build. They assert that `package.json` wires up
 * the CJS (`require`) and ESM (`import`) entry points correctly, that the
 * `types` and `browser` conditions stay coherent, and that every target is
 * actually included in the published tarball via the `files` allow-list.
 *
 * The runtime half of the same contract — resolving through Node's real
 * exports map and comparing the two module surfaces — lives in
 * scripts/smoke-export-map.mjs (`npm run compat:exports`), which needs a build.
 *
 * All rules live in scripts/export-map-lib.mjs so both halves agree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CONDITIONS,
  isTargetCoveredByFiles,
  validateExportMap,
} from "../scripts/export-map-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedPackage = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
);

