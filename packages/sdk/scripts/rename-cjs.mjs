#!/usr/bin/env node
/**
 * Post-build step for CJS output: renames every `*.js` in `dist/cjs/` to
 * `*.cjs`, and `*.js.map` to `*.cjs.map`, and rewrites the `index.cjs` file
 * so it can be loaded with `require(...)` as a Node CJS entry.
 *
 * We also rewrite any inter-module `require("./foo.js")` calls inside the
 * compiled output to `require("./foo.cjs")` so cross-module references still
 * resolve after the rename.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CJS_DIR = join(ROOT, "dist", "cjs");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

if (!existsSync(CJS_DIR)) {
  console.warn("[rename-cjs] dist/cjs missing — skipping");
  process.exit(0);
}

// Phase 1: rewrite .js sources in-memory to point require() at .cjs
const allJs = walk(CJS_DIR).filter((f) => f.endsWith(".js"));
for (const file of allJs) {
  let contents = readFileSync(file, "utf8");
  // require("./something.js") -> require("./something.cjs")
  // require("../foo.js") -> require("../foo.cjs")
  contents = contents.replace(
    /require\(\s*(['"])((?:\.\.?\/)+[^"'\\]+)\.js\1\s*\)/g,
    (m, q, base) => `require(${q}${base}.cjs${q})`,
  );
  // SourceMappingURL references
  contents = contents.replace(
    /\/\/# sourceMappingURL=(.+)\.js\.map/g,
    "//# sourceMappingURL=$1.cjs.map",
  );
  writeFileSync(file, contents, "utf8");
}

// Phase 2: rename files
const allFiles = walk(CJS_DIR);
const renamePlan = [];
for (const f of allFiles) {
  const ext = extname(f);
  const dir = dirname(f);
  const base = basename(f, ext);
  if (ext === ".js") {
    renamePlan.push([f, join(dir, `${base}.cjs`)]);
  } else if (ext === ".map" && base.endsWith(".js")) {
    const realBase = base.slice(0, -".js".length);
    renamePlan.push([f, join(dir, `${realBase}.cjs.map`)]);
  }
}

for (const [from, to] of renamePlan) {
  renameSync(from, to);
  console.log("  %s -> %s", from.slice(CJS_DIR.length + 1), to.slice(CJS_DIR.length + 1));
}

// Ensure the cjs entry exists at the expected path.
const finalEntry = join(CJS_DIR, "index.cjs");
if (!existsSync(finalEntry)) {
  console.error("[rename-cjs] FAILED — entry missing:", finalEntry);
  process.exit(1);
}
console.log("[rename-cjs] CJS entry: %s", finalEntry);
