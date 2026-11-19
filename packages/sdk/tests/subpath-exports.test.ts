/**
 * Subpath export contracts for `@talos-protocol/sdk`.
 *
 * `./webhooks`, `./events` and `./errors` exist so a serverless handler can
 * verify a webhook or decode an event stream without importing the root
 * barrel, which drags in `client.ts` and, through it, `@stellar/stellar-sdk`.
 *
 * Two independent proofs that the split actually holds:
 *
 *   1. A static walk of the `src` import graph, which needs no build and
 *      reports exactly which modules and bare specifiers each entry reaches.
 *   2. An esbuild metafile bundle of each entry, which is what a bundler would
 *      ship — the acceptance criterion for the issue is that no Stellar SDK
 *      code appears in it.
 *
 * The root barrel is bundled as the control in both, so a walk or a metafile
 * that silently matched nothing would fail instead of passing vacuously.
 *
 * The manifest half of the same contract (conditions, CJS/ESM targets,
 * `files` coverage) lives in tests/export-map.test.ts and
 * scripts/smoke-export-map.mjs.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { REQUIRED_SUBPATHS, validateExportMap } from "../scripts/export-map-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const SRC_DIR = join(PKG_ROOT, "src");

const STELLAR_PACKAGE = "@stellar/stellar-sdk";

/** Subpath key -> the source module published behind it. */
const ENTRY_MODULES = new Map(
  REQUIRED_SUBPATHS.map((subpath) => [subpath, `${subpath.slice(2)}.ts`]),
);

/**
 * Client-side modules a server-only entry must never reach. `stellar.ts` and
 * `signing.ts` are the two direct wrappers over the Stellar SDK; `client.ts`
 * reaches it too and also carries HTTP concerns.
 */
const FORBIDDEN_MODULES = ["client.ts", "stellar.ts", "signing.ts"];

/** Every `from "..."` / `import("...")` specifier in a module. */
const SPECIFIER_PATTERN = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

/**
 * Resolve a relative specifier the way TypeScript does: sources are `.ts` and
 * import each other with the compiled `.js` suffix.
 */
function resolveSource(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const withoutExtension = base.replace(/\.(js|mjs|cjs)$/, "");
  for (const candidate of [
    `${withoutExtension}.ts`,
    `${withoutExtension}.mts`,
    join(withoutExtension, "index.ts"),
    base,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Transitive closure of a source entry point: the files it reaches and the
 * bare (external) specifiers those files import.
 */
function collectGraph(entry: string) {
  const files = new Set<string>();
  const externals = new Set<string>();
  const queue = [entry];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.add(file);

    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SPECIFIER_PATTERN)) {
      const specifier = match[1];
      const resolved = resolveSource(specifier, file);
      if (resolved) {
        queue.push(resolved);
        continue;
      }
      if (!specifier.startsWith(".")) externals.add(specifier);
    }
  }

  const relative = [...files].map((file) => file.replace(/\\/g, "/").slice(SRC_DIR.length + 1));
  return { relative: relative.sort(), externals: [...externals].sort() };
}

function packageExports() {
  return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
}

/** Bundle an entry exactly as a serverless build would, and return its metafile. */
async function bundle(entry: string) {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: PKG_ROOT,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const output = Object.keys(result.metafile.outputs)[0];
  return {
    bytes: result.metafile.outputs[output].bytes,
    inputs: Object.keys(result.metafile.outputs[output].inputs),
    externalImports: result.metafile.outputs[output].imports
      .filter((specifier) => specifier.external)
      .map((specifier) => specifier.path),
  };
}

describe("Subpath exports — source module graph", () => {
  it.each(REQUIRED_SUBPATHS)("%s resolves to a published source module", (subpath) => {
    const module = ENTRY_MODULES.get(subpath) as string;
    expect(existsSync(join(SRC_DIR, module))).toBe(true);
    const declared = packageExports().exports[subpath];
    expect(declared.import).toBe(`./dist/esm/${module.replace(/\.ts$/, ".js")}`);
    expect(declared.require).toBe(`./dist/cjs/${module.replace(/\.ts$/, ".cjs")}`);
    expect(declared.types).toBe(`./dist/esm/${module.replace(/\.ts$/, ".d.ts")}`);
  });

  it.each(REQUIRED_SUBPATHS)("%s stays out of the client and the Stellar SDK", (subpath) => {
    const graph = collectGraph(join(SRC_DIR, ENTRY_MODULES.get(subpath) as string));
    expect(graph.externals).not.toContain(STELLAR_PACKAGE);
    for (const forbidden of FORBIDDEN_MODULES) {
      expect(graph.relative).not.toContain(forbidden);
    }
  });

  it("walks the graph past the entry module itself", () => {
    // Guards the walk against a vacuous pass: webhooks pulls in chaos.ts.
    const graph = collectGraph(join(SRC_DIR, "webhooks.ts"));
    expect(graph.relative).toContain("webhooks.ts");
    expect(graph.relative).toContain("chaos.ts");
  });

  it("proves the root barrel is what drags in the Stellar SDK", () => {
    const graph = collectGraph(join(SRC_DIR, "index.ts"));
    expect(graph.relative).toContain("client.ts");
    expect(graph.relative).toContain("stellar.ts");
    expect(graph.externals).toContain(STELLAR_PACKAGE);
  });
});

describe("Subpath exports — esbuild metafile bundles", () => {
  // esbuild starts a service process per suite run; the first bundle pays for it.
  const BUNDLE_TIMEOUT_MS = 60_000;

  it.each(REQUIRED_SUBPATHS)(
    "bundles %s without @stellar/stellar-sdk",
    async (subpath) => {
      const meta = await bundle(`src/${ENTRY_MODULES.get(subpath) as string}`);
      expect(meta.inputs.filter((input) => input.includes("stellar-sdk"))).toEqual([]);
      expect(meta.externalImports.filter((path) => path.includes("@stellar"))).toEqual([]);
    },
    BUNDLE_TIMEOUT_MS,
  );

  it(
    "keeps every subpath bundle a small fraction of the client bundle",
    async () => {
      const client = await bundle("src/client.ts");
      expect(client.inputs.filter((input) => input.includes("stellar-sdk"))).not.toEqual([]);

      for (const subpath of REQUIRED_SUBPATHS) {
        const meta = await bundle(`src/${ENTRY_MODULES.get(subpath) as string}`);
        expect(meta.bytes).toBeLessThan(client.bytes / 10);
      }
    },
    BUNDLE_TIMEOUT_MS,
  );

  it("publishes each subpath as a distinct ESM and CJS artifact", () => {
    const result = validateExportMap(packageExports());
    expect(result.ok).toBe(true);

    for (const subpath of REQUIRED_SUBPATHS) {
      const entry = result.subpaths.find((candidate) => candidate.subpath === subpath);
      expect(entry, `${subpath} is not declared in the export map`).toBeDefined();
      const conditions = (entry as NonNullable<typeof entry>).targets.map((t) => t.condition);
      expect(conditions).toContain("import");
      expect(conditions).toContain("require");
      expect(conditions).toContain("types");
      // "types" first keeps TypeScript from resolving past it into the JS target.
      expect(conditions[0]).toBe("types");
    }
  });
});
