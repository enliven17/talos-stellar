import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { openApiSpec } from "../src/lib/openapi";

const snapshotPath = path.resolve("tests/fixtures/openapi.snapshot.json");

async function main() {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(openApiSpec, null, 2)}\n`);
  console.log(`Wrote ${snapshotPath}`);
}

main().catch(console.error);