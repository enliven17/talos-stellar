import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openApiSpec } from "../src/lib/openapi";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, "..");
const snapshotPath = path.join(webRoot, "tests/fixtures/openapi.snapshot.json");
const exclusionsPath = path.join(webRoot, "openapi-route-exclusions.json");

type Exclusions = Record<string, string>;

async function loadExclusions(): Promise<Exclusions> {
  try {
    const raw = await readFile(exclusionsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Exclusions file must be an object of path-to-reason: ${exclusionsPath}`);
    }
    return parsed as Exclusions;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

function isExcluded(path: string, exclusions: Exclusions): boolean {
  return Object.prototype.hasOwnProperty.call(exclusions, path);
}

function filterPaths(spec: typeof openApiSpec, exclusions: Exclusions) {
  const paths = Object.fromEntries(
    Object.entries(spec.paths || {}).filter(([path]) => !isExcluded(path, exclusions))
  );
  return { ...spec, paths };
}

export async function runCheck(): Promise<void> {
  let snapshot;
  try {
    const existing = await readFile(snapshotPath, "utf8");
    snapshot = JSON.parse(existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`OpenAPI snapshot is missing: ${snapshotPath}. Run `\openapi:snapshot` to create it.`);
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

  const exclusions = await loadExclusions();
  const currentPaths = Object.keys(openApiSpec.paths || {});
  const snapshotPaths = Object.keys(snapshot.paths || {});
  const publicPaths = currentPaths.filter((p) => !isExcluded(p, exclusions));

  const missing = publicPaths.filter((p) => !snapshotPaths.includes(p));
  const changed = publicPaths.filter(
    (p) => snapshotPaths.includes(p) && JSON.stringify(openApiSpec.paths[p]) !== JSON.stringify(snapshot.paths[p])
  );
  const extra = snapshotPaths.filter((p) => !publicPaths.includes(p));

  if (missing.length === 0 && changed.length === 0 && extra.length === 0) {
    console.log("OpenAPI snapshot is up to date.");
    return;
  }

  console.error("OpenAPI snapshot is out of date.\n");
  if (missing.length > 0) {
    console.error("Missing routes:");
    for (const p of missing) console.error(`  - ${p}`);
  }
  if (changed.length > 0) {
    console.error("Changed routes:");
    for (const p of changed) console.error(`  - ${p}`);
  }
  if (extra.length > 0) {
    console.error("Stale routes in snapshot (no longer public or excluded):");
    for (const p of extra) console.error(c  - ${p}`);
  }
  console.error(`\nPlease update the snapshot by running: \`npm run openapi:snapshot\`);
  console.error(`Snapshot file: ${snapshotPath}`);
  if (Object.keys(exclusions).length > 0) {
    console.error(`Exclusions file: ${exclusionsPath}`);
  }
  process.exitCode = 1;
}

export async function runWrite(): Promise<void> {
  const exclusions = await loadExclusions();
  const filteredSpec = filterPaths(openApiSpec, exclusions);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, `${JSON.stringify(filteredSpec, null, 2)}\n`);
  console.log(`Wrote ${snapshotPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  if (isCheck) {
    await runCheck();
  } else {
    await runWrite();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
