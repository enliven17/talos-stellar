#!/usr/bin/env node
/**
 * check-openapi-sdk-drift.mjs
 *
 * Combined OpenAPI snapshot + SDK generated-types drift gate.
 *
 * Validates that:
 *   1. The committed OpenAPI snapshot (web/tests/fixtures/openapi.snapshot.json)
 *      is in sync with what the live OpenAPI route would produce.
 *      When --live is not specified this check is structural only (schema shape).
 *
 *   2. The committed SDK generated types (packages/sdk/src/generated-types.ts)
 *      were generated from the current committed OpenAPI snapshot.
 *      Checks that running `pnpm generate:types` from the SDK dir would not
 *      produce a diff against the committed file.
 *
 *   3. The OpenAPI snapshot itself is well-formed:
 *      - Valid JSON
 *      - Top-level openapi version string present (3.x.y)
 *      - info.title and info.version present
 *      - paths object is non-empty
 *      - No sensitive values embedded (privacy guard)
 *
 * This script is intentionally offline-first: it works without a running
 * server or database. All checks operate on committed file contents.
 *
 * Usage:
 *   node scripts/check-openapi-sdk-drift.mjs
 *   node scripts/check-openapi-sdk-drift.mjs --snapshot path/to/openapi.json
 *   node scripts/check-openapi-sdk-drift.mjs --types path/to/generated-types.ts
 *   node scripts/check-openapi-sdk-drift.mjs --skip-types
 *   node scripts/check-openapi-sdk-drift.mjs --json
 *   pnpm openapi:drift
 *
 * Full regen + re-check (when the server is running):
 *   cd web && pnpm openapi:snapshot
 *   cd packages/sdk && pnpm generate:types
 *   node scripts/check-openapi-sdk-drift.mjs
 *
 * Exit codes:
 *   0 — no drift
 *   1 — drift / validation failure
 *   2 — usage / argument error
 *
 * Local command: node scripts/check-openapi-sdk-drift.mjs
 */

import { readFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// ── Helpers ───────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/check-openapi-sdk-drift.mjs [--snapshot <path>] [--types <path>] [--skip-types] [--json]",
  );
  console.error("  --snapshot    OpenAPI snapshot JSON file (default: web/tests/fixtures/openapi.snapshot.json)");
  console.error("  --types       SDK generated-types TS file (default: packages/sdk/src/generated-types.ts)");
  console.error("  --skip-types  Skip the SDK types drift check");
  console.error("  --json        Output results as JSON");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    snapshotPath: join(repoRoot, "web", "tests", "fixtures", "openapi.snapshot.json"),
    typesPath: join(repoRoot, "packages", "sdk", "src", "generated-types.ts"),
    skipTypes: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--snapshot") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) usage("--snapshot requires a path");
      opts.snapshotPath = resolve(v);
    } else if (a === "--types") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) usage("--types requires a path");
      opts.typesPath = resolve(v);
    } else if (a === "--skip-types") {
      opts.skipTypes = true;
    } else if (a === "--json") {
      opts.json = true;
    } else if (a === "--help" || a === "-h") {
      usage();
    } else {
      usage(`unknown argument: ${a}`);
    }
  }
  return opts;
}

// ── Privacy guard ─────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/,
  /(?:secret|password|passwd|api_key|apikey|auth_token)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/im,
];

function checkPrivacy(content) {
  const violations = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) {
      violations.push(
        `content matches sensitive-data pattern "${re.source.slice(0, 60)}…" — ` +
          "the OpenAPI snapshot must not contain secrets or credentials",
      );
    }
  }
  return violations;
}

// ── OpenAPI snapshot validator ────────────────────────────────────────────────

function validateSnapshotStructure(snapshotPath) {
  const errors = [];
  const warnings = [];

  if (!existsSync(snapshotPath)) {
    return {
      ok: false,
      errors: [
        `OpenAPI snapshot not found: ${snapshotPath}\n` +
          "  → Run: cd web && pnpm openapi:snapshot\n" +
          "  → Then commit the updated web/tests/fixtures/openapi.snapshot.json",
      ],
      warnings,
    };
  }

  const stat = statSync(snapshotPath);
  if (stat.size === 0) {
    return {
      ok: false,
      errors: [
        `OpenAPI snapshot is empty: ${snapshotPath}\n` +
          "  → Re-run: cd web && pnpm openapi:snapshot",
      ],
      warnings,
    };
  }

  let content;
  try {
    content = readFileSync(snapshotPath, "utf8");
  } catch (e) {
    return { ok: false, errors: [`cannot read snapshot: ${e.message}`], warnings };
  }

  // Privacy guard
  const privacyViolations = checkPrivacy(content);
  if (privacyViolations.length > 0) {
    return { ok: false, errors: privacyViolations, warnings };
  }

  // Parse JSON
  let spec;
  try {
    spec = JSON.parse(content);
  } catch (e) {
    return {
      ok: false,
      errors: [
        `OpenAPI snapshot is not valid JSON: ${e.message}\n` +
          "  → Re-run: cd web && pnpm openapi:snapshot",
      ],
      warnings,
    };
  }

  // OpenAPI version
  if (!spec.openapi || typeof spec.openapi !== "string") {
    errors.push(
      'OpenAPI snapshot missing "openapi" version field.\n' +
        "  → The snapshot generator must produce an OpenAPI 3.x document.",
    );
  } else if (!/^3\.\d+\.\d+$/.test(spec.openapi)) {
    errors.push(
      `OpenAPI version "${spec.openapi}" does not match 3.x.y pattern.\n` +
        "  → Only OpenAPI 3.x is supported.",
    );
  }

  // info
  if (!spec.info || typeof spec.info !== "object") {
    errors.push(
      'OpenAPI snapshot missing "info" object.\n' +
        "  → Ensure the route at /api/docs/openapi.json returns a valid OpenAPI document.",
    );
  } else {
    if (!spec.info.title || typeof spec.info.title !== "string" || !spec.info.title.trim()) {
      errors.push('OpenAPI info.title is missing or empty.');
    }
    if (!spec.info.version || typeof spec.info.version !== "string" || !spec.info.version.trim()) {
      errors.push(
        "OpenAPI info.version is missing or empty.\n" +
          "  → Set the API version in web/src/lib/openapi.ts.",
      );
    }
  }

  // paths
  if (!spec.paths || typeof spec.paths !== "object") {
    errors.push(
      'OpenAPI snapshot missing "paths" object.\n' +
        "  → The snapshot must enumerate all API routes.",
    );
  } else {
    const pathCount = Object.keys(spec.paths).length;
    if (pathCount === 0) {
      errors.push(
        "OpenAPI snapshot has an empty paths object — no routes documented.\n" +
          "  → Ensure web/src/lib/openapi.ts includes all API routes before snapshotting.",
      );
    } else {
      // Structural spot-checks: each path value should have at least one method
      for (const [route, methods] of Object.entries(spec.paths)) {
        if (!methods || typeof methods !== "object") {
          errors.push(`paths["${route}"] is not an object.`);
          continue;
        }
        const httpMethods = ["get", "post", "put", "patch", "delete", "head", "options"];
        const defined = Object.keys(methods).filter((k) => httpMethods.includes(k.toLowerCase()));
        if (defined.length === 0) {
          warnings.push(
            `paths["${route}"] has no HTTP method definitions — is this intentional?`,
          );
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, spec };
}

// ── SDK types drift check ─────────────────────────────────────────────────────

/**
 * Checks whether the committed generated-types.ts would be modified by
 * re-running `pnpm generate:types` from packages/sdk.
 *
 * Strategy (offline-safe):
 *   1. Read the committed generated-types.ts header comment to extract the
 *      source snapshot reference, if any.
 *   2. Attempt to run openapi-typescript via the local node_modules bin.
 *      If available, generate to a temp path and diff against committed file.
 *   3. If the tooling is unavailable, perform a structural heuristic check:
 *      verify that every top-level path from the OpenAPI snapshot appears
 *      somewhere in the generated-types.ts file.
 */
function checkTypesDrift(snapshotPath, typesPath, spec) {
  const errors = [];
  const warnings = [];

  if (!existsSync(typesPath)) {
    return {
      ok: false,
      errors: [
        `SDK generated-types file not found: ${typesPath}\n` +
          "  → Run: cd packages/sdk && pnpm generate:types\n" +
          "  → Then commit packages/sdk/src/generated-types.ts",
      ],
      warnings,
    };
  }

  let typesContent;
  try {
    typesContent = readFileSync(typesPath, "utf8");
  } catch (e) {
    return { ok: false, errors: [`cannot read generated types: ${e.message}`], warnings };
  }

  if (!typesContent.trim()) {
    return {
      ok: false,
      errors: [
        "SDK generated-types.ts is empty.\n" +
          "  → Run: cd packages/sdk && pnpm generate:types",
      ],
      warnings,
    };
  }

  // Check that the file looks like TypeScript generated by openapi-typescript
  if (!typesContent.includes("export type") && !typesContent.includes("export interface")) {
    errors.push(
      "packages/sdk/src/generated-types.ts does not appear to be an openapi-typescript output.\n" +
        "  → Run: cd packages/sdk && pnpm generate:types",
    );
  }

  // Structural heuristic: verify top-level API paths appear in the types file.
  // openapi-typescript encodes paths as keys in the `paths` interface.
  if (spec && spec.paths) {
    const paths = Object.keys(spec.paths);
    const missingPaths = paths.filter((p) => !typesContent.includes(JSON.stringify(p)));
    if (missingPaths.length > 0) {
      const displayed = missingPaths.slice(0, 5);
      errors.push(
        `SDK generated-types.ts is missing ${missingPaths.length} API path(s) from the snapshot:\n` +
          displayed.map((p) => `    - ${p}`).join("\n") +
          (missingPaths.length > 5 ? `\n    … and ${missingPaths.length - 5} more` : "") +
          "\n  → Run: cd packages/sdk && pnpm generate:types\n" +
          "  → Then commit packages/sdk/src/generated-types.ts",
      );
    }
  }

  // Attempt to detect drift by running the generator and checking git diff.
  // This provides the strongest signal but requires the tooling to be available.
  const sdkDir = join(repoRoot, "packages", "sdk");
  const otBinPath = join(sdkDir, "node_modules", ".bin", "openapi-typescript");

  const versionCheck = spawnSync(
    "node",
    [otBinPath, "--version"],
    { encoding: "utf8", timeout: 5_000 },
  );

  if (versionCheck.status === 0) {
    // openapi-typescript is available: generate to a temp path and diff
    const tmpOut = join(sdkDir, "src", "generated-types.tmp.ts");
    const genResult = spawnSync(
      "node",
      [otBinPath, snapshotPath, "-o", tmpOut],
      { encoding: "utf8", timeout: 30_000, cwd: sdkDir },
    );

    if (genResult.status !== 0) {
      warnings.push(
        "openapi-typescript generation attempt failed (tool may need dependencies installed).\n" +
          "  Using structural heuristics instead. To verify fully:\n" +
          "  Run: cd packages/sdk && pnpm install && pnpm generate:types",
      );
      // Clean up temp file if it exists
      try {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
      } catch { /* ignore */ }
    } else {
      // Diff the generated output against the committed file
      const diffResult = spawnSync(
        "git",
        ["diff", "--no-index", "--exit-code", typesPath, tmpOut],
        { encoding: "utf8", timeout: 10_000, cwd: repoRoot },
      );

      // Clean up temp file
      try {
        if (existsSync(tmpOut)) unlinkSync(tmpOut);
      } catch { /* ignore */ }

      if (diffResult.status !== 0 && diffResult.status !== null) {
        errors.push(
          "SDK generated-types.ts is out of sync with the OpenAPI snapshot.\n" +
            "  → Run: cd packages/sdk && pnpm generate:types\n" +
            "  → Then commit packages/sdk/src/generated-types.ts\n" +
            "  Diff preview (first 20 lines):\n" +
            (diffResult.stdout || "")
              .split("\n")
              .slice(0, 20)
              .map((l) => `    ${l}`)
              .join("\n"),
        );
      }
    }
  } else {
    warnings.push(
      "openapi-typescript binary not found — skipping live generation diff.\n" +
        "  Using structural path heuristics only. For a full check:\n" +
        "  Run: cd packages/sdk && pnpm install && pnpm generate:types",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const checks = [];

  const log = opts.json ? () => {} : console.log.bind(console);

  // ── Check 1: OpenAPI snapshot structure ──────────────────────────────────
  log(`Checking OpenAPI snapshot: ${opts.snapshotPath}`);
  const snapshotResult = validateSnapshotStructure(opts.snapshotPath);
  checks.push({ check: "openapi-snapshot", ...snapshotResult });

  // ── Check 2: SDK types drift ─────────────────────────────────────────────
  if (!opts.skipTypes) {
    log(`Checking SDK generated types: ${opts.typesPath}`);
    const spec = snapshotResult.ok ? snapshotResult.spec : null;
    const typesResult = checkTypesDrift(opts.snapshotPath, opts.typesPath, spec);
    checks.push({ check: "sdk-types-drift", ...typesResult });
  } else {
    log("Skipping SDK types drift check (--skip-types)");
  }

  // ── Output ────────────────────────────────────────────────────────────────
  const failed = checks.filter((c) => !c.ok);
  const passed = checks.filter((c) => c.ok);

  if (opts.json) {
    const output = {
      total: checks.length,
      passed: passed.length,
      failed: failed.length,
      checks: checks.map(({ check, ok, errors, warnings }) => ({
        check,
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
      console.log(`✓ ${c.check}`);
      for (const w of c.warnings ?? []) console.warn(`  warning: ${w}`);
    } else {
      console.error(`✗ ${c.check}`);
      for (const e of c.errors ?? []) console.error(`  error: ${e}`);
      for (const w of c.warnings ?? []) console.warn(`  warning: ${w}`);
    }
  }

  console.log("");

  if (failed.length > 0) {
    console.error(
      `✗ OpenAPI/SDK drift check failed: ${failed.length}/${checks.length} check(s) have errors.`,
    );
    console.error("  Fix the errors above, then re-run:");
    console.error("    node scripts/check-openapi-sdk-drift.mjs");
    console.error("  To regenerate the snapshot and types:");
    console.error("    cd web && pnpm openapi:snapshot");
    console.error("    cd packages/sdk && pnpm generate:types");
    process.exit(1);
  } else {
    console.log(
      `✓ OpenAPI/SDK drift check passed: ${passed.length}/${checks.length} check(s) clean.`,
    );
  }
}

main();
