import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("generate-schemas --check", () => {
  let tempDir: string;
  let originalSchemaContent: string;
  const schemaPath = path.resolve(__dirname, "../src/generated/schemas/createTalos.json");

  beforeEach(() => {
    // Create a temporary directory for test output
    tempDir = mkdtempSync(path.join(__dirname, "temp-schemas-"));

    // Save the original schema content
    if (require("node:fs").existsSync(schemaPath)) {
      originalSchemaContent = readFileSync(schemaPath, "utf8");
    }
  });

  afterEach(() => {
    // Clean up the temporary directory
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    // Restore the original schema content if it was modified
    if (originalSchemaContent) {
      writeFileSync(schemaPath, originalSchemaContent, "utf8");
    }
  });

  it("fails when generated schemas differ from existing files", () => {
    const realScriptPath = path.resolve(__dirname, "../scripts/generate-schemas.ts");
    const webDir = path.resolve(__dirname, "..");

    // Generate schemas first to ensure they're up to date
    execSync(`npx tsx "${realScriptPath}"`, { cwd: webDir });

    // Run check mode - should pass
    execSync(`npx tsx "${realScriptPath}" --check`, { cwd: webDir });

    // Modify a schema file to make it stale
    writeFileSync(schemaPath, JSON.stringify({ modified: true }), "utf8");

    // Run check mode - should fail
    expect(() => {
      execSync(`npx tsx "${realScriptPath}" --check`, { cwd: webDir, stdio: "pipe" });
    }).toThrow();
  });

  it("passes when generated schemas match existing files", () => {
    const realScriptPath = path.resolve(__dirname, "../scripts/generate-schemas.ts");
    const webDir = path.resolve(__dirname, "..");

    // Generate schemas first to ensure they're up to date
    execSync(`npx tsx "${realScriptPath}"`, { cwd: webDir });

    // Run check mode - should pass without error
    execSync(`npx tsx "${realScriptPath}" --check`, { cwd: webDir });
  });

  it("fails when a schema file is missing", () => {
    const realScriptPath = path.resolve(__dirname, "../scripts/generate-schemas.ts");
    const webDir = path.resolve(__dirname, "..");

    // Generate schemas first to ensure they're up to date
    execSync(`npx tsx "${realScriptPath}"`, { cwd: webDir });

    // Delete a schema file
    rmSync(schemaPath);

    // Run check mode - should fail
    expect(() => {
      execSync(`npx tsx "${realScriptPath}" --check`, { cwd: webDir, stdio: "pipe" });
    }).toThrow();

    // Restore the file by regenerating
    execSync(`npx tsx "${realScriptPath}"`, { cwd: webDir });
  });
});
