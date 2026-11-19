#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ESM_DIR = resolve(ROOT, "dist", "esm");
const CJS_DIR = resolve(ROOT, "dist", "cjs");

let esbuild;
try {
  esbuild = await import("esbuild");
} catch (err) {
  console.error("[build:cli] esbuild could not be loaded:", err?.message ?? err);
  process.exit(1);
}

mkdirSync(ESM_DIR, { recursive: true });
mkdirSync(CJS_DIR, { recursive: true });

// Build ESM CLI
await esbuild.build({
  entryPoints: [resolve(ROOT, "src", "cli.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outfile: resolve(ESM_DIR, "cli.js"),
  external: ["@stellar/stellar-sdk", "node:*"],
});

// Build CJS CLI
await esbuild.build({
  entryPoints: [resolve(ROOT, "src", "cli.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: resolve(CJS_DIR, "cli.cjs"),
  external: ["@stellar/stellar-sdk", "node:*"],
});

console.log("[build:cli] built dist/esm/cli.js and dist/cjs/cli.cjs");
