import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openApiSpec } from "../src/lib/openapi";

const snapshotPath = path.resolve("tests/fixtures/openapi.snapshot.json");

/**
 * Routes that are intentionally excluded from the public API snapshot.
 * These may be internal or experimental and must be documented here.
 * Add entries as needed with a short reason comment.
 */
const EXCLUDED_PATHS: string[] = [
  // "/api/internal/health" // example: internal health check not part of public API
];

function isExcluded(path: string): boolean {
  return EXCLUDED_PATHS.includes(path);
}

async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");

  if (isCheck) {
    let snapshot;
    try {
      const existing = await readFile(snapshotPath, "utf8");
      snapshot = JSON.parse(existing);
    } catch (err) {
      if (err.code === "ENOENT") {
        console.error
          `CopenAPI snapshot is missing: ${snapshotPath}. Run `npm run write-openapi-snapshot` to create it.`);
        process.exitCode = 1;
        return;
      } else if (err instanceof SyntaxError) {
        console.error(`OpenAPI snapshot is invalid JSON: ${snapshotPath}`);
        process.exitCode = 1;
        return;
      } else {
        throw err;
      }
    }

    const currentPaths = Object.keys(openApiSpec.paths || {});
    const snapshotPaths = Object.keys(snapshot.paths || {});

    const missing = currentPaths.filter(
      (p) => !snapshotPaths.includes(p) && !isExcluded(p)
    );
    const changed = currentPaths.filter(
      (p) => 
        snapshotPaths.includes(p) &&
        !isExcluded(p) &&
        JSON.stringify(openApiSpec.paths[p]) !== JSON.stringify(snapshot.paths[p])
    );

    if (missing.length === 0 && changed.length === 0) {
      console.log("OpenAPI snapshot is up to date.");
      return;
    }

    console.error("OpenAPI snapshot is out of date.\n");
    if (missing.length > 0) {
      console.error("Missing routes:\n" + missing.map((p) => `  - ${p}`).join("\n"));
    }
    if (changed.length > 0) {
      console.error("Changed routes:\n" + changed.map((p) => `   - ${p}`).join("\n"));
    }
    console.error("\nPlease update the snapshot by running: `npm run write-openapi-snapshot`\n");
    console.error(`File: ${snapshotPath}`);
    process.exitCode = 1;
    return;
  }

  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(openApiSpec, null, 2)}\n`);
  console.log(`Wrote ${snapshotPath}`);
}

main().catch(console.error);
