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

/** A minimal manifest that satisfies every rule, used as a mutation base. */
function basePackage(overrides: Record<string, unknown> = {}) {
  return {
    name: "@talos-protocol/sdk",
    version: "0.1.0",
    type: "module",
    main: "dist/esm/index.js",
    types: "dist/esm/index.d.ts",
    files: ["dist"],
    exports: {
      ".": {
        import: "./dist/esm/index.js",
        require: "./dist/cjs/index.cjs",
        types: "./dist/esm/index.d.ts",
        browser: "./dist/browser/sdk.bundle.js",
      },
    },
    ...overrides,
  };
}

/** Validate a manifest whose `exports["."]` is replaced with `root`. */
function validateRoot(root: unknown) {
  return validateExportMap(basePackage({ exports: { ".": root } }));
}

function expectError(result: ReturnType<typeof validateExportMap>, fragment: string) {
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain(fragment);
}

describe("Export map — shipped manifest (positive)", () => {
  const result = validateExportMap(shippedPackage);

  it("passes every export-map rule", () => {
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("declares every required condition", () => {
    const root = (shippedPackage.exports as Record<string, unknown>)["."] as Record<
      string,
      unknown
    >;
    for (const condition of REQUIRED_CONDITIONS) {
      expect(Object.keys(root)).toContain(condition);
    }
  });

  it("resolves ESM and CJS to distinct dist files", () => {
    const root = (shippedPackage.exports as Record<string, unknown>)["."] as Record<
      string,
      unknown
    >;
    expect(root.import).toBe("./dist/esm/index.js");
    expect(root.require).toBe("./dist/cjs/index.cjs");
    expect(root.import).not.toBe(root.require);
  });

  it("publishes the browser bundle and type declarations alongside them", () => {
    const root = (shippedPackage.exports as Record<string, unknown>)["."] as Record<
      string,
      unknown
    >;
    expect(root.browser).toBe("./dist/browser/sdk.bundle.js");
    expect(root.types).toBe("./dist/esm/index.d.ts");
  });

  it("is published as an ES module so the import target loads as ESM", () => {
    expect(shippedPackage.type).toBe("module");
  });

  it("covers every export target with the files allow-list", () => {
    expect(Array.isArray(shippedPackage.files)).toBe(true);
    for (const { target } of result.targets) {
      expect(isTargetCoveredByFiles(target, shippedPackage.files)).toBe(true);
    }
  });

  it("reports each declared target exactly once", () => {
    const conditions = result.targets.map((target) => target.condition).sort();
    expect(conditions).toEqual(["browser", "import", "require", "types"]);
  });
});

describe("Export map — missing and malformed input (negative)", () => {
  it("rejects a manifest with no exports field", () => {
    const result = validateExportMap(basePackage({ exports: undefined }));
    expectError(result, '"exports"');
  });

  it("rejects a non-object package", () => {
    expectError(validateExportMap(null), "JSON object");
  });

  it("rejects an exports object without the root subpath", () => {
    const result = validateExportMap(
      basePackage({ exports: { "./other": { default: "./dist/esm/index.js" } } }),
    );
    expectError(result, 'exports must declare the "." subpath');
  });

  it("rejects a string shorthand instead of a conditional object", () => {
    const result = validateExportMap(
      basePackage({ exports: { ".": "./dist/esm/index.js" } }),
    );
    expectError(result, "conditional object");
  });

  for (const condition of REQUIRED_CONDITIONS) {
    it(`rejects a root export missing the "${condition}" condition`, () => {
      const root = { ...(basePackage().exports as Record<string, Record<string, string>>)["."] };
      delete root[condition];
      expectError(validateRoot(root), `missing the required "${condition}" condition`);
    });
  }

  it("rejects import and require pointing at the same file", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      require: "./dist/esm/index.js",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, "different");
  });

  it("rejects a target that escapes the package root", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      require: "../outside/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, "escape");
  });

  it("rejects a target that is not package-relative", () => {
    const result = validateRoot({
      import: "dist/esm/index.js",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, '"./"');
  });

  it("rejects an empty target", () => {
    const result = validateRoot({
      import: "",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, '"./"');
  });

  it("rejects a non-string target", () => {
    const result = validateRoot({
      import: null,
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, "must be a string");
  });

  it("rejects an array target instead of explicit conditions", () => {
    const result = validateRoot({
      import: ["./dist/esm/index.js"],
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, "array");
  });

  it("rejects a types target that is not a .d.ts file", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.ts",
    });
    expectError(result, ".d.ts");
  });

  it("rejects an ESM target with a CJS extension", () => {
    const result = validateRoot({
      import: "./dist/esm/index.cjs",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, "must end with");
  });

  it("rejects a target excluded by the files allow-list", () => {
    const pkg = basePackage({ files: ["dist/esm"] });
    const result = validateExportMap(pkg);
    expectError(result, "not covered by the published");
  });
});

describe("Export map — boundary and optional conditions", () => {
  it("allows browser to be omitted", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a default condition without a warning", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
      default: "./dist/esm/index.js",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).not.toContain("unrecognised");
  });

  it("supports nested conditions and flattens their targets", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      types: "./dist/esm/index.d.ts",
      require: {
        types: "./dist/cjs/index.d.ts",
        default: "./dist/cjs/index.cjs",
      },
    });
    expect(result.ok).toBe(true);
    expect(result.targets.map((t) => t.condition)).toContain("require.default");
  });

  it("warns about unrecognised conditions instead of failing", () => {
    const result = validateRoot({
      import: "./dist/esm/index.js",
      require: "./dist/cjs/index.cjs",
      types: "./dist/esm/index.d.ts",
      deno: "./dist/esm/index.js",
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("unrecognised");
  });

  it("always returns arrays for errors, warnings, and targets", () => {
    const result = validateExportMap(undefined);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
    expect(Array.isArray(result.targets)).toBe(true);
    expect(typeof result.ok).toBe("boolean");
  });
});

describe("Export map — regression and privacy", () => {
  it("does not fall back to a single entry point", () => {
    // Regression: a package that only ships ESM must not pass the CJS/ESM gate.
    const result = validateRoot({
      import: "./dist/esm/index.js",
      types: "./dist/esm/index.d.ts",
    });
    expectError(result, '"require"');
  });

  it("keeps error messages free of host paths and secrets", () => {
    const badManifests = [
      basePackage({ exports: { ".": "../.env" } }),
      basePackage({ exports: { ".": { import: "/etc/passwd", require: null, types: 42 } } }),
      basePackage({ exports: undefined }),
    ];
    for (const manifest of badManifests) {
      const result = validateExportMap(manifest);
      const joined = [...result.errors, ...result.warnings].join("\n");
      expect(joined).not.toContain(process.cwd());
      expect(joined).not.toMatch(/file:\/\//);
    }
  });
});
