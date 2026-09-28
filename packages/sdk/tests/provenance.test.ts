import { describe, it, expect } from "vitest";
import {
  GENERATED_TYPES_PROVENANCE,
  GENERATED_TYPES_TOOL,
  GENERATED_TYPES_TOOL_VERSION,
  GENERATED_TYPES_SOURCE,
  GENERATED_TYPES_PACKAGE,
} from "../src/provenance.js";
import { GENERATED_TYPES_PROVENANCE as indexProvenance } from "../src/index.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Generated types provenance", () => {
  it("GENERATED_TYPES_PROVENANCE has correct shape (all fields non-empty strings)", () => {
    expect(typeof GENERATED_TYPES_PROVENANCE.tool).toBe("string");
    expect(GENERATED_TYPES_PROVENANCE.tool.length).toBeGreaterThan(0);

    expect(typeof GENERATED_TYPES_PROVENANCE.toolVersion).toBe("string");
    expect(GENERATED_TYPES_PROVENANCE.toolVersion.length).toBeGreaterThan(0);

    expect(typeof GENERATED_TYPES_PROVENANCE.source).toBe("string");
    expect(GENERATED_TYPES_PROVENANCE.source.length).toBeGreaterThan(0);

    expect(typeof GENERATED_TYPES_PROVENANCE.pkg).toBe("string");
    expect(GENERATED_TYPES_PROVENANCE.pkg.length).toBeGreaterThan(0);
  });

  it("GENERATED_TYPES_TOOL is 'openapi-typescript'", () => {
    expect(GENERATED_TYPES_TOOL).toBe("openapi-typescript");
  });

  it("GENERATED_TYPES_SOURCE contains 'openapi.snapshot.json'", () => {
    expect(GENERATED_TYPES_SOURCE).toContain("openapi.snapshot.json");
  });

  it("GENERATED_TYPES_PACKAGE is '@talos-protocol/sdk'", () => {
    expect(GENERATED_TYPES_PACKAGE).toBe("@talos-protocol/sdk");
  });

  it("provenance is exported from the SDK index", () => {
    // Imported as indexProvenance from ../src/index.js — verify it is the same object
    expect(indexProvenance).toBeDefined();
    expect(indexProvenance.tool).toBe(GENERATED_TYPES_TOOL);
    expect(indexProvenance.toolVersion).toBe(GENERATED_TYPES_TOOL_VERSION);
    expect(indexProvenance.source).toBe(GENERATED_TYPES_SOURCE);
    expect(indexProvenance.pkg).toBe(GENERATED_TYPES_PACKAGE);
  });

  it("provenance fields are stable (regression: exact value checks)", () => {
    expect(GENERATED_TYPES_TOOL).toBe("openapi-typescript");
    expect(GENERATED_TYPES_TOOL_VERSION).toBe("^7.4.3");
    expect(GENERATED_TYPES_SOURCE).toBe(
      "web/tests/fixtures/openapi.snapshot.json"
    );
    expect(GENERATED_TYPES_PACKAGE).toBe("@talos-protocol/sdk");
  });

  it("generated-types.ts file header contains @provenance", () => {
    const filePath = resolve(__dirname, "../src/generated-types.ts");
    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("@provenance");
  });

  it("GENERATED_TYPES_PROVENANCE object matches the individual constants", () => {
    expect(GENERATED_TYPES_PROVENANCE).toEqual({
      tool: GENERATED_TYPES_TOOL,
      toolVersion: GENERATED_TYPES_TOOL_VERSION,
      source: GENERATED_TYPES_SOURCE,
      pkg: GENERATED_TYPES_PACKAGE,
    });
  });
});
