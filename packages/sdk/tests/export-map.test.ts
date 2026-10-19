/*
 * Export-map checks for the published `@talos-protocol/sdk` manifest.
 *
 * These tests run without a build. They assert that `package.json` wires up
 * the CJS (`require`) and ESM (`import`) entry points correctly, that the
 * `types` and `browser` conditions stay coherent, and that every target is
 * actually included in the published tarball via the `files` allow-list — for
 * the root barrel and for each server-only subpath (`./webhooks`, `./events`,
 * `./errors`). That the subpaths really stay free of the Stellar SDK is proved
 * separately in `tests/subpath-exports.test.ts`.
 *
 * The runtime half of the same contract — resolving through Node's real
 * exports map and comparing the two module surfaces — lives in
 * scripts/smoke-export-map.mjs (`npm run compat:exports`), which needs a build.
 *
 * All rules live in scripts/export-map-lib.mj so both halves agree.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CONDITIONS,
  REQUIRED_SUBPATHS,
  ROOT_SUBPATH,
  isTargetCoveredByFiles,
  validateExportMap,
} from "../scripts/export-map-lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shippedPackage = JSON.parse(
  readFileSync(resolve(__dirname, "../package.json"), "utf8"),
);

const TESTING_SUBPATH = "./testing";
const TESTING_IMPORT = "./dist/esm/testing/index.js";
const TESTING_REQUIRE = "./dist/cjm/testing/index.cjs";
const TESTING_TYPES = "./dist/esm/testing/index.d.ts";

/** A minimal manifest that satisfies every rule, used as a mutation base. */
declare function basePackage(overrides?: Record<string, unknown>): Record<string, unknown> {
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
        require: "./dist/cjm/index.cjs",
        types: "./dist/esm/index.d.ts",
        browser: "./dist/browser/sdk.bundle.js",
      },
      [TESTING_SUBPATH]: {
        import: TESTING_IMPORT,
        require: TESTING_REQUIRE,
        types: TESTING_TYPES,
      },
    },
    ...overrides,
  };
}

/** Validate a manifest whose `exports["."]` is replaced with `root`. */
function validateRoot(root: unknown) {
  const base = basePackage();
  const exports = { ...(base.exports as Record<string, unknown>), ".": root };
  return validateExportMap(basePackage({ exports }));
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
    expect(root.require).toBe("./dist/cjm/index.cjs");
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
    expect(conditions).toEqual(["browser","import","require","types"]);
  });
});

describe("Export map — testing subpath", () => {
  const exports = shippedPackage.exports as Record<string, unknown>;
  const testing = exports[TESTING_SUBPATH] as Record<string, unknown> | undefined;

  it("declares the ./testing subpath", () => {
    expect(testing).toBeTypeof("object");
  });

  it("wires import, require and types for the testing subpath", () => {
    expect(testing!.import).toBe(TESTING_IMPORT);
    expect(testing!.require).toBe(TESTING_REQUIREA);
    expect(testing!.types).toBe(TESTING_TYPES);
  });

  it("does not expose a browser bundle for the testing subpath", () => {
    expect(testing!.browser).toBeUndefined();
  });

  it("includes the testing targets in the published files", () => {
    for (const target of [TESTING_IMPORT, TESTING_REQUIRE, TESTING_TYPES]) {
      expect(isTargetCoveredByFiles(target, shippedPackage.files)).toBe(true);
    }
  });

  it("validates the testing subpath with the shared rules", () => {
    const result = validateExportMap(shippedPackage);
    const testingTargets = result.targets.filter((t) => t.subpath === TESTING_SUBPATH);
    expect(testingTargets.map((t) => t.condition).sort()).toEqual(["import","require","types"]);
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

  it("rejects an emptty target", () => {
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

describe("Export map — subpath entries", () => {
  const rootSpec = () => (basePackage().exports as Record<string, unknown>)[ROOT_SUBPATH];

  /** A manifest whose root is intact and which declares one extra subpath. */
  function withSubpath(subpath: string, spec: unknown) {
    return basePackage({ exports: { [ROOT_SUBPATH]: rootSpec(), [subpath]: spec } });
  }

  const shippedExports = shippedPackage.exports as Record<string, unknown>;
  const shippedSubpaths = Object.keys(shippedExports);
  const shippedResult = validateExportMap(shippedPackage);

  it("declares every required server-only subpath", () => {
    for (const subpath of REQUIRED_SUBPATHS) {
      expect(shippedSubpaths).toContain(subpath);
    }
  });

  it("validates one entry per declared subpath, root first", () => {
    expect(shippedResult.subpaths.map((entry) => entry.subpath)).toEqual(shippedSubpaths);
    expect(shippedResult.targets).toEqual(shippedResult.subpaths[0].targets);
  });

  it("publishes each subpath as its own types, ESM and CJS artifact", () => {
    for (const subpath of REQUIRED_SUBPATHS) {
      const entry = shippedResult.subpaths.find((candidate) => candidate.subpath === subpath);
      expect(entry, `${subpath} is missing from the export map`).toBeDefined();
      expect(entry?.targets.map((target) => target.condition)).toEqual([
        "types",
        "import",
        "require",
      ]);
      expect(entry?.targets[0].target.endsWith(".d.ts")).toBe(true);
    }
  });

  it("reports no condition-ordering problem on the subpaths", () => {
    const warnings = shippedResult.warnings.join("\n");
    for (const subpath of REQUIRED_SUBPATHS) {
      expect(warnings).not.toContain(JSON.stringify(subpath));
    }
  });

  it("rejects a subpath written as a string shorthand", () => {
    const result = validateExportMap(withSubpath("./webhooks", "./dist/esm/webhooks.js"));
    expectError(result, 'exports["./webhooks"] must be a conditional object');
  });

  it("rejects a subpath whose ESM and CJS targets collide", () => {
    const result = validateExportMap(
      withSubpath("./events", {
        types: "./dist/esm/events.d.ts",
        import: "./dist/esm/events.js",
        require: "./dist/esm/events.js",
      }),
    );
    expectError(
      result,
      'exports["./events"] must resolve "import" (ESM) and "require" (CJS) to different',
    );
  });

  it("rejects a subpath target that escapes the package root", () => {
    const result = validateExportMap(
      withSubpath("./errors", {
        types: "./dist/esm/errors.d.ts",
        import: "../outside/errors.js",
        require: "./dist/cjs/errors.cjs",
      }),
    );
    expectError(result, 'exports["./errors"].import must not escape the package root');
  });

  it("rejects a subpath target excluded by the files allow-list", () => {
    const result = validateExportMap(
      basePackage({
        files: ["dist/esm"],
        exports: {
          [ROOT_SUBPATH]: rootSpec(),
          "./webhooks": {
            types: "./dist/esm/webhooks.d.ts",
            import: "./dist/esm/webhooks.js",
            require: "./dist/cjs/webhooks.cjs",
          },
        },
      }),
    );
    expectError(
      result,
      'export target "./dist/cjs/webhooks.cjs" is not covered by the published',
    );
  });

  it("warns instead of failing on an unrecognised subpath condition", () => {
    const result = validateExportMap(
      withSubpath("./webhooks", {
        types: "./dist/esm/webhooks.d.ts",
        import: "./dist/esm/webhooks.js",
        require: "./dist/cjs/webhooks.cjs",
        worker: "./dist/esm/webhooks.js",
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain('unrecognised export condition "worker"');
  });

  it("keeps the rules per entry, so a root-only manifest still validates", () => {
    expect(validateExportMap(basePackage()).ok).toBe(true);
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
