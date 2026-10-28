#!/usr/bin/env node
/**
 * check-migration-drift.mjs
 *
 * Offline migration drift gate for web/drizzle.
 * Validates that Drizzle's journal and SQL migration files stay consistent
 * without needing Postgres or drizzle-kit.
 *
 * Checks (fail closed):
 *   - journal exists and is well-formed JSON
 *   - entries have contiguous unique idxs starting at 0
 *   - tags are unique and non-empty
 *   - every journal tag has a matching <tag>.sql file
 *   - bootstrap-roles.sql is present (CI / local Postgres prerequisite)
 *
 * Optional (--strict):
 *   - fail when orphan *.sql files exist (not listed in the journal)
 *   - fail when multiple *.sql files share the same numeric prefix (NNNN_)
 *
 * Usage:
 *   node scripts/check-migration-drift.mjs
 *   node scripts/check-migration-drift.mjs --strict
 *   node scripts/check-migration-drift.mjs --drizzle-dir path/to/drizzle
 *   pnpm migrations:check
 *
 * Exit codes:
 *   0 — no drift
 *   1 — drift / validation failure
 *   2 — usage / ambiguous input
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

function usage(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/check-migration-drift.mjs [--strict] [--drizzle-dir <path>] [--json]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    strict: false,
    json: false,
    drizzleDir: join(repoRoot, "web", "drizzle"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") opts.strict = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--drizzle-dir") {
      const v = argv[++i];
      if (!v || v.startsWith("-")) usage("--drizzle-dir requires a path");
      opts.drizzleDir = resolve(v);
    } else if (a === "--help" || a === "-h") usage();
    else usage(`unknown argument: ${a}`);
  }
  return opts;
}

function isMigrationSql(name) {
  // Match Drizzle tags like 0000_ambitious_brood.sql; exclude bootstrap helper.
  return /^\d{4}_.+\.sql$/.test(name);
}

function numericPrefix(name) {
  const m = /^(\d{4})_/.exec(name);
  return m ? m[1] : null;
}

function loadJournal(journalPath) {
  if (!existsSync(journalPath)) {
    return { ok: false, errors: [`missing journal: ${journalPath}`] };
  }
  let raw;
  try {
    raw = readFileSync(journalPath, "utf8");
  } catch (err) {
    return { ok: false, errors: [`cannot read journal: ${err.message}`] };
  }
  if (!raw.trim()) {
    return { ok: false, errors: ["journal is empty"] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, errors: [`malformed journal JSON: ${err.message}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errors: ["journal root must be an object"] };
  }
  if (!Array.isArray(parsed.entries)) {
    return { ok: false, errors: ["journal.entries must be an array"] };
  }
  if (parsed.entries.length === 0) {
    return { ok: false, errors: ["journal.entries is empty"] };
  }
  return { ok: true, journal: parsed, errors: [] };
}

function check(opts) {
  const errors = [];
  const warnings = [];
  const drizzleDir = opts.drizzleDir;

  if (!existsSync(drizzleDir) || !statSync(drizzleDir).isDirectory()) {
    return {
      ok: false,
      errors: [`drizzle directory missing or not a directory: ${drizzleDir}`],
      warnings,
      summary: {},
    };
  }

  const journalPath = join(drizzleDir, "meta", "_journal.json");
  const loaded = loadJournal(journalPath);
  if (!loaded.ok) {
    return { ok: false, errors: loaded.errors, warnings, summary: {} };
  }
  const { journal } = loaded;

  const tags = [];
  const idxs = [];
  for (let i = 0; i < journal.entries.length; i++) {
    const entry = journal.entries[i];
    if (!entry || typeof entry !== "object") {
      errors.push(`entries[${i}] is not an object`);
      continue;
    }
    if (typeof entry.idx !== "number" || !Number.isInteger(entry.idx)) {
      errors.push(`entries[${i}].idx must be an integer`);
    } else {
      idxs.push(entry.idx);
    }
    if (typeof entry.tag !== "string" || !entry.tag.trim()) {
      errors.push(`entries[${i}].tag must be a non-empty string`);
    } else {
      tags.push(entry.tag.trim());
    }
  }

  // Contiguous unique idxs starting at 0
  const sortedIdx = [...idxs].sort((a, b) => a - b);
  for (let i = 0; i < sortedIdx.length; i++) {
    if (sortedIdx[i] !== i) {
      errors.push(
        `journal idxs must be contiguous from 0 (expected ${i}, found ${sortedIdx[i]})`,
      );
      break;
    }
  }
  if (new Set(idxs).size !== idxs.length) {
    errors.push("journal contains duplicate idx values");
  }
  if (new Set(tags).size !== tags.length) {
    const seen = new Set();
    const dups = [];
    for (const t of tags) {
      if (seen.has(t)) dups.push(t);
      seen.add(t);
    }
    errors.push(`journal contains duplicate tags: ${[...new Set(dups)].join(", ")}`);
  }

  const files = readdirSync(drizzleDir);
  const sqlFiles = files.filter(isMigrationSql).sort();
  const sqlSet = new Set(sqlFiles);

  const missingSql = [];
  for (const tag of tags) {
    const name = `${tag}.sql`;
    if (!sqlSet.has(name)) missingSql.push(name);
  }
  if (missingSql.length) {
    errors.push(
      `journal tags missing SQL files: ${missingSql.join(", ")} (fail closed)`,
    );
  }

  if (!files.includes("bootstrap-roles.sql")) {
    errors.push("missing bootstrap-roles.sql (required before first migrate)");
  }

  const journalTags = new Set(tags);
  const orphans = sqlFiles.filter((f) => !journalTags.has(f.replace(/\.sql$/, "")));
  if (orphans.length) {
    const msg = `orphan migration SQL not in journal (${orphans.length}): ${orphans.join(", ")}`;
    if (opts.strict) errors.push(msg);
    else warnings.push(msg);
  }

  const byPrefix = new Map();
  for (const f of sqlFiles) {
    const p = numericPrefix(f);
    if (!p) continue;
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(f);
  }
  const collisions = [...byPrefix.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([p, list]) => `${p}: ${list.join(", ")}`);
  if (collisions.length) {
    const msg = `ambiguous numeric migration prefixes:\n  - ${collisions.join("\n  - ")}`;
    if (opts.strict) errors.push(msg);
    else warnings.push(msg);
  }

  const summary = {
    drizzleDir,
    journalEntries: tags.length,
    sqlFiles: sqlFiles.length,
    orphans: orphans.length,
    collisions: collisions.length,
    strict: opts.strict,
  };

  return { ok: errors.length === 0, errors, warnings, summary };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = check(opts);

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Migration drift gate — ${result.summary.drizzleDir || opts.drizzleDir}`);
    if (result.summary.journalEntries != null) {
      console.log(
        `journal entries: ${result.summary.journalEntries} | sql files: ${result.summary.sqlFiles} | orphans: ${result.summary.orphans} | prefix collisions: ${result.summary.collisions}`,
      );
    }
    for (const w of result.warnings) console.warn(`warning: ${w}`);
    for (const e of result.errors) console.error(`error: ${e}`);
    if (result.ok) {
      console.log(
        opts.strict
          ? "✓ migration drift check passed (--strict)"
          : "✓ migration drift check passed (structural). Use --strict to fail on orphans/prefix collisions.",
      );
    } else {
      console.error("✗ migration drift detected. Fix journal/SQL consistency before merge.");
      console.error("Local command: pnpm migrations:check");
      console.error("Strict mode:   pnpm migrations:check:strict");
    }
  }

  process.exit(result.ok ? 0 : 1);
}

main();
