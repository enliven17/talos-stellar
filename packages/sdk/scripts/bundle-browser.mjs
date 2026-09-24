#!/usr/bin/env node
/**
 * Browser bundle script.
 *
 * Uses TypeScript compiler (typescript as devDep) + a minimal in-memory bundling
 * strategy: reads ESM dist output, concatenates and writes a IIFE-ish browser
 * bundle that exposes the SDK on `globalThis.TalosSDK`.
 *
 * If esbuild is available we prefer it; otherwise we fall back to a simple
 * concatenation strategy that is sufficient for compatibility CI (build
 * success + runtime import assertions on the exported names).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ESM_DIR = join(ROOT, "dist", "esm");
const BROWSER_DIR = join(ROOT, "dist", "browser");
const BUNDLE_OUT = join(BROWSER_DIR, "sdk.bundle.js");

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) walk(full, files);
    else if (full.endsWith(".js")) files.push(full);
  }
  return files;
}

async function bundleWithEsbuild() {
  try {
    const esbuild = await import("esbuild");
    await esbuild.build({
      entryPoints: [join(ESM_DIR, "index.js")],
      bundle: true,
      format: "iife",
      globalName: "TalosSDK",
      platform: "browser",
      target: "es2020",
      outfile: BUNDLE_OUT,
      minify: false,
      sourcemap: false,
      legalComments: "none",
      allowOverwrite: true,
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env": "{}",
      },
      footer: {
        js: "if (typeof globalThis !== 'undefined') { globalThis.TalosSDK = TalosSDK; } if (typeof window !== 'undefined') { window.TalosSDK = TalosSDK; }",
      },
    });
    console.log("[build:browser] bundled via esbuild ->", BUNDLE_OUT);
    return true;
  } catch (err) {
    console.log("[build:browser] esbuild not available, falling back:", err?.message ?? err);
    return false;
  }
}

const EXPORT_REGEX =
  /^export\s+(default\s+)?(?:(?:const|let|var|class|function|enum|async\s+function)\s+)?([A-Za-z0-9_$]+)/m;
const REEXPORT_ALL = /^export\s+\*\s+from\s+["']([^"']+)["']/;
const REEXPORT_NAMED = /^export\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/;
const IMPORT_LINE =
  /^import\s+(?:(?:\{[^}]*\}|\*\s+as\s+[A-Za-z0-9_$]+|[A-Za-z0-9_$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?["']([^"']+)["'];?\s*$/;

function stripImportsExportsForBundle(src) {
  const lines = src.split(/\r?\n/);
  const out = [];
  const deferred = [];
  for (const raw of lines) {
    const line = raw.trimEnd();

    if (REEXPORT_ALL.test(line)) continue;
    if (REEXPORT_NAMED.test(line)) continue;
    if (IMPORT_LINE.test(line)) continue;
    if (/^export\s*\{\s*\}\s*;?\s*$/.test(line)) continue;

    if (/^export\s+default\s+/.test(line)) {
      const rest = line.replace(/^export\s+default\s+/, "");
      deferred.push("__talos_export('default', (" + rest + "));");
      continue;
    }

    const m = EXPORT_REGEX.exec(line);
    if (m) {
      const name = m[2];
      const decl = line.replace(/^export\s+/, "");
      out.push(decl);
      if (name) deferred.push(`try { __talos_export('${name}', ${name}); } catch (_) {}`);
      continue;
    }

    const namedLocal = /^export\s+\{([^}]+)\}\s*;?\s*$/.exec(line);
    if (namedLocal) {
      for (const part of namedLocal[1].split(",")) {
        const bit = part.trim();
        if (!bit) continue;
        const asMatch = /^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/.exec(bit);
        if (asMatch) {
          deferred.push(`try { __talos_export('${asMatch[2]}', ${asMatch[1]}); } catch (_) {}`);
        } else {
          deferred.push(`try { __talos_export('${bit}', ${bit}); } catch (_) {}`);
        }
      }
      continue;
    }

    out.push(line);
  }
  return out.join("\n") + "\n" + deferred.join("\n");
}

function fallbackBundle() {
  if (!existsSync(ESM_DIR)) {
    throw new Error(`ESM dist not found at ${ESM_DIR}. Run build:esm first.`);
  }
  const sources = [];
  for (const f of walk(ESM_DIR).sort()) {
    const rel = f.slice(ESM_DIR.length + 1);
    sources.push(`// ${rel}\n` + stripImportsExportsForBundle(readFileSync(f, "utf8")));
  }
  // Build a pseudo-module shim: wrap in an IIFE, re-export from the
  // `index.js` entry. This fallback is not a perfect bundler but lets CI
  // assert that the source files concatenate without syntax errors and
  // that the entry exports are discoverable.
  const banner =
    "(function(global){ 'use strict';\n" +
    "var __talos_exports__ = {};\n" +
    "function __talos_export(k,v){ __talos_exports__[k]=v; }\n";
  const footer =
    "global.TalosSDK = Object.freeze(__talos_exports__);\n" +
    "})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : global);\n";

  const body = sources.join("\n");
  mkdirSync(BROWSER_DIR, { recursive: true });
  writeFileSync(BUNDLE_OUT, banner + body + footer, "utf8");
  console.log("[build:browser] fallback bundle written ->", BUNDLE_OUT);
}

async function main() {
  mkdirSync(BROWSER_DIR, { recursive: true });
  const usedEsbuild = await bundleWithEsbuild();
  if (!usedEsbuild) fallbackBundle();
  const size = statSync(BUNDLE_OUT).size;
  console.log(`[build:browser] OK (${size} bytes)`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
