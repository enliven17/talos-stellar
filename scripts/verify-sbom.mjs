#!/usr/bin/env node
/**
 * verify-sbom.mjs
 *
 * Actionable SBOM verification gate for Talos Protocol.
 *
 * Validates CycloneDX and SPDX SBOM files for structural correctness and
 * content integrity. Designed to be called from CI (sbom-verify.yml) or
 * locally by contributors before merge.
 *
 * Checks (fail closed on ambiguous input):
 *   CycloneDX (.cdx.json):
 *     - File is non-empty and parses as valid JSON
 *     - bomFormat === "CycloneDX"
 *     - specVersion is present and non-empty
 *     - version is a positive integer
 *     - metadata.timestamp is a valid ISO-8601 datetime
 *     - metadata.component is present with non-empty name and version
 *     - components array exists and has at least one entry
 *     - each component has non-empty type, name, and version
 *     - serialNumber matches urn:uuid:<uuid> format when present
 *
 *   SPDX (.spdx):
 *     - File is non-empty
 *     - SPDXVersion header is present (SPDX-2.x)
 *     - DataLicense is present
 *     - SPDXID: SPDXRef-DOCUMENT is present
 *     - DocumentName is present
 *     - DocumentNamespace is present and non-empty
 *     - At least one PackageName entry exists
 *
 *   Privacy / safety:
 *     - Secret-pattern scan: rejects files containing PEM private-key blocks,
 *       JWT secrets, or common secret-variable patterns. Errors are
 *       reported without echoing the sensitive value.
 *
 * Usage:
 *   node scripts/verify-sbom.mjs --file path/to/sbom.cdx.json
 *   node scripts/verify-sbom.mjs --file path/to/sbom.spdx
 *   node scripts/verify-sbom.mjs --file a.cdx.json --file b.spdx
 *   node scripts/verify-sbom.mjs --dir dist-sbom/sdk
 *   pnpm sbom:verify -- --dir dist-sbom/sdk
 *
 * Exit codes:
 *   0 — all files verified
 *   1 — verification failure (actionable error messages printed)
 *   2 — usage / argument error
 *
 * Local command: node scripts/verify-sbom.mjs --file <path>
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Helpers ───────────────────────────────────────────────────────────────────

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/verify-sbom.mjs [--file <path>]... [--dir <path>] [--json]",
  );
  console.error("  --file   SBOM file to verify (.cdx.json or .spdx)");
  console.error("  --dir    Directory to scan for *.cdx.json and *.spdx files");
  console.error("  --json   Output results as JSON");
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { files: [], dirs: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) usage("--file requires a path");
      opts.files.push(resolve(v));
    } else if (a === "--dir") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) usage("--dir requires a path");
      opts.dirs.push(resolve(v));
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

// Collect all SBOM files from directories
function collectFromDir(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return { files: [], error: `not a directory: ${dir}` };
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const fp = join(dir, e.name);
    if (e.isFile()) {
      const ext = extname(e.name);
      if (ext === ".json" && e.name.endsWith(".cdx.json")) files.push(fp);
      else if (ext === ".spdx") files.push(fp);
    } else if (e.isDirectory()) {
      // recurse one level for dist-sbom/<component>/
      const sub = readdirSync(fp, { withFileTypes: true });
      for (const s of sub) {
        if (s.isFile()) {
          const sfp = join(fp, s.name);
          const sext = extname(s.name);
          if (sext === ".json" && s.name.endsWith(".cdx.json")) files.push(sfp);
          else if (sext === ".spdx") files.push(sfp);
        }
      }
    }
  }
  return { files, error: null };
}

// ── Privacy guard ─────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  // PEM private key blocks
  /-----BEGIN (RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/,
  // Generic JWT-format secret patterns
  /(?:^|[^a-z0-9])eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}/m,
  // Secret/password assignment lines
  /(?:secret|password|passwd|api_key|apikey|auth_token)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{8,}/im,
];

function checkPrivacy(content) {
  const violations = [];
  for (const re of SECRET_PATTERNS) {
    if (re.test(content)) {
      // Report the pattern class without echoing the matched value
      violations.push(
        `SBOM content matches sensitive-data pattern "${re.source.slice(0, 60)}…" — file must not contain secrets`,
      );
    }
  }
  return violations;
}

// ── CycloneDX validator ───────────────────────────────────────────────────────

const UUID_RE =
  /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function verifyCycloneDX(filePath, content) {
  const errors = [];
  const warnings = [];

  // Privacy guard first
  errors.push(...checkPrivacy(content));
  if (errors.length > 0) return { ok: false, errors, warnings };

  // Parse JSON
  let doc;
  try {
    doc = JSON.parse(content);
  } catch (e) {
    return {
      ok: false,
      errors: [`invalid JSON: ${e.message}`],
      warnings,
    };
  }

  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      ok: false,
      errors: ["CycloneDX root must be a JSON object"],
      warnings,
    };
  }

  // bomFormat
  if (doc.bomFormat !== "CycloneDX") {
    errors.push(
      `bomFormat must be "CycloneDX" (got ${JSON.stringify(doc.bomFormat)}) — is this actually a CycloneDX file?`,
    );
  }

  // specVersion
  if (!doc.specVersion || typeof doc.specVersion !== "string") {
    errors.push("missing or non-string specVersion — CycloneDX spec requires this field");
  }

  // version
  if (doc.version !== undefined) {
    if (!Number.isInteger(doc.version) || doc.version < 1) {
      errors.push(
        `version must be a positive integer (got ${JSON.stringify(doc.version)})`,
      );
    }
  } else {
    warnings.push("version field is absent — expected a positive integer per CycloneDX spec");
  }

  // serialNumber
  if (doc.serialNumber !== undefined) {
    if (!UUID_RE.test(doc.serialNumber)) {
      errors.push(
        `serialNumber must be urn:uuid:<uuid> format (got ${JSON.stringify(doc.serialNumber)})`,
      );
    }
  }

  // metadata
  if (!doc.metadata || typeof doc.metadata !== "object") {
    errors.push(
      "metadata object is missing — CycloneDX requires metadata.timestamp and metadata.component",
    );
  } else {
    // timestamp
    if (!doc.metadata.timestamp) {
      errors.push("metadata.timestamp is missing — required for reproducibility audits");
    } else if (!ISO8601_RE.test(doc.metadata.timestamp)) {
      errors.push(
        `metadata.timestamp is not a valid ISO-8601 datetime (got "${doc.metadata.timestamp}")` +
          " — use format: 2024-01-01T00:00:00Z",
      );
    }

    // component (the subject of the SBOM)
    if (!doc.metadata.component || typeof doc.metadata.component !== "object") {
      errors.push(
        "metadata.component is missing — required to identify the SBOM subject",
      );
    } else {
      const mc = doc.metadata.component;
      if (!mc.name || typeof mc.name !== "string" || !mc.name.trim()) {
        errors.push("metadata.component.name must be a non-empty string");
      }
      if (!mc.version || typeof mc.version !== "string" || !mc.version.trim()) {
        errors.push(
          "metadata.component.version must be a non-empty string — " +
            "run the SBOM generator after versioning the release",
        );
      }
    }
  }

  // components array
  if (!Array.isArray(doc.components)) {
    errors.push(
      "components array is missing — SBOM must enumerate at least one dependency",
    );
  } else if (doc.components.length === 0) {
    errors.push(
      "components array is empty — SBOM has no dependencies; " +
        "run the generator from an installed working directory (not a bare checkout)",
    );
  } else {
    // Validate each component
    const compErrors = [];
    for (let i = 0; i < doc.components.length; i++) {
      const c = doc.components[i];
      if (!c || typeof c !== "object") {
        compErrors.push(`components[${i}] is not an object`);
        continue;
      }
      if (!c.type || typeof c.type !== "string") {
        compErrors.push(`components[${i}] missing required "type" field`);
      }
      if (!c.name || typeof c.name !== "string" || !c.name.trim()) {
        compErrors.push(`components[${i}] missing or empty "name" field`);
      }
      if (!c.version || typeof c.version !== "string" || !c.version.trim()) {
        // version can be absent for OS packages; warn only
        warnings.push(
          `components[${i}] (${c.name || "?"}) has no version — consider pinning for reproducible builds`,
        );
      }
    }
    // Only surface up to 5 component errors to avoid log flooding
    errors.push(...compErrors.slice(0, 5));
    if (compErrors.length > 5) {
      errors.push(
        `… and ${compErrors.length - 5} more component validation errors — fix the above first`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── SPDX validator ────────────────────────────────────────────────────────────

function verifySPDX(filePath, content) {
  const errors = [];
  const warnings = [];

  // Privacy guard first
  errors.push(...checkPrivacy(content));
  if (errors.length > 0) return { ok: false, errors, warnings };

  if (!content.trim()) {
    return { ok: false, errors: ["SPDX file is empty"], warnings };
  }

  const lines = content.split(/\r?\n/);

  // Required top-level tags
  const has = (tag) => lines.some((l) => l.startsWith(`${tag}:`));
  const get = (tag) => {
    const line = lines.find((l) => l.startsWith(`${tag}:`));
    return line ? line.slice(tag.length + 1).trim() : null;
  };

  // SPDXVersion
  const spdxVersion = get("SPDXVersion");
  if (!spdxVersion) {
    errors.push(
      "SPDXVersion header is missing — required as the first meaningful line of an SPDX file",
    );
  } else if (!/^SPDX-2\.\d+$/.test(spdxVersion)) {
    errors.push(
      `SPDXVersion value "${spdxVersion}" does not match SPDX-2.x pattern — ` +
        "only SPDX 2.x is supported",
    );
  }

  // DataLicense
  if (!has("DataLicense")) {
    errors.push(
      'DataLicense header is missing — must be "CC0-1.0" per SPDX spec',
    );
  } else {
    const dl = get("DataLicense");
    if (dl !== "CC0-1.0") {
      warnings.push(
        `DataLicense is "${dl}" — SPDX mandates CC0-1.0 for the document itself`,
      );
    }
  }

  // SPDXID for document
  const hasDocId = lines.some(
    (l) => l.startsWith("SPDXID:") && l.includes("SPDXRef-DOCUMENT"),
  );
  if (!hasDocId) {
    errors.push(
      "SPDXID: SPDXRef-DOCUMENT is missing — required for the document element",
    );
  }

  // DocumentName
  if (!has("DocumentName")) {
    errors.push(
      "DocumentName is missing — set it to the component name + version, e.g. talos-sdk-0.1.0",
    );
  }

  // DocumentNamespace
  const ns = get("DocumentNamespace");
  if (!ns) {
    errors.push(
      "DocumentNamespace is missing — must be a unique URI per SBOM generation",
    );
  } else if (!ns.startsWith("https://") && !ns.startsWith("http://")) {
    errors.push(
      `DocumentNamespace "${ns}" must be an HTTP/HTTPS URI`,
    );
  }

  // At least one package
  const packageCount = lines.filter((l) => l.startsWith("PackageName:")).length;
  if (packageCount === 0) {
    errors.push(
      "No PackageName entries found — SPDX SBOM must describe at least one package. " +
        "Run the SPDX generator from the installed workspace root.",
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ── Per-file dispatcher ───────────────────────────────────────────────────────

function verifyFile(filePath) {
  const name = basename(filePath);

  // Read
  if (!existsSync(filePath)) {
    return {
      file: filePath,
      kind: "unknown",
      ok: false,
      errors: [
        `file not found: ${filePath} — pass a valid path with --file or --dir`,
      ],
      warnings: [],
    };
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (e) {
    return {
      file: filePath,
      kind: "unknown",
      ok: false,
      errors: [`cannot read file: ${e.message}`],
      warnings: [],
    };
  }

  if (!content.trim()) {
    return {
      file: filePath,
      kind: "unknown",
      ok: false,
      errors: [
        "file is empty — SBOM generator may have failed silently. " +
          "Re-run with `node scripts/verify-sbom.mjs --file <path>` after regenerating.",
      ],
      warnings: [],
    };
  }

  // Dispatch by extension
  if (name.endsWith(".cdx.json")) {
    const result = verifyCycloneDX(filePath, content);
    return { file: filePath, kind: "CycloneDX", ...result };
  }

  if (name.endsWith(".spdx")) {
    const result = verifySPDX(filePath, content);
    return { file: filePath, kind: "SPDX", ...result };
  }

  // Ambiguous: try to auto-detect
  if (name.endsWith(".json")) {
    // Could be CycloneDX without the .cdx suffix
    try {
      const doc = JSON.parse(content);
      if (doc && doc.bomFormat === "CycloneDX") {
        const result = verifyCycloneDX(filePath, content);
        return { file: filePath, kind: "CycloneDX (auto-detected)", ...result };
      }
    } catch {
      // fall through
    }
  }

  return {
    file: filePath,
    kind: "unknown",
    ok: false,
    errors: [
      `unrecognized SBOM format for "${name}" — ` +
        "expected *.cdx.json (CycloneDX) or *.spdx (SPDX 2.x). " +
        "Rename the file or ensure your generator writes the correct extension.",
    ],
    warnings: [],
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Expand directories
  const files = [...opts.files];
  for (const dir of opts.dirs) {
    const { files: found, error } = collectFromDir(dir);
    if (error) {
      console.error(`error: ${error}`);
      process.exit(2);
    }
    if (found.length === 0) {
      console.error(
        `warning: no *.cdx.json or *.spdx files found in ${dir} — ` +
          "ensure the SBOM generator ran before calling verify-sbom",
      );
    }
    files.push(...found);
  }

  if (files.length === 0) {
    usage("at least one --file or --dir argument is required");
  }

  // Deduplicate
  const unique = [...new Set(files)];

  const results = unique.map(verifyFile);

  if (opts.json) {
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(summary.failed > 0 ? 1 : 0);
  }

  // Human-readable output
  let anyFailed = false;
  for (const r of results) {
    const label = `[${r.kind}] ${r.file}`;
    if (r.ok) {
      console.log(`✓ ${label}`);
      for (const w of r.warnings) {
        console.warn(`  warning: ${w}`);
      }
    } else {
      console.error(`✗ ${label}`);
      for (const e of r.errors) {
        console.error(`  error: ${e}`);
      }
      for (const w of r.warnings) {
        console.warn(`  warning: ${w}`);
      }
      anyFailed = true;
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.ok).length;

  if (anyFailed) {
    console.error("");
    console.error(
      `✗ SBOM verification failed: ${total - passed}/${total} file(s) have errors.`,
    );
    console.error("  Fix the issues above, then re-run:");
    console.error("    node scripts/verify-sbom.mjs --file <path>");
    console.error(
      "  If the SBOM is stale, regenerate it first via the sbom-provenance workflow",
    );
    console.error("  or the relevant component generator (cyclonedx-npm, cyclonedx-py, etc.).");
    process.exit(1);
  } else {
    console.log("");
    console.log(`✓ SBOM verification passed: ${passed}/${total} file(s) verified.`);
  }
}

main();
