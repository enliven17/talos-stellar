import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  checkCompatibility,
  formatReport,
} from "./check-compatibility-manifest.mjs";

const BASE_MANIFEST = {
  manifestVersion: 1,
  toolchains: {
    node: { minimum: "20.0.0", contributorMinimum: "20.0.0" },
    pnpm: { minimum: "9.0.0" },
    python: { minimum: "3.10.0", contributorMinimum: "3.11.0" },
    rust: {
      channel: "stable",
      edition: "2021",
      wasmTarget: "wasm32-unknown-unknown",
    },
  },
  schemas: {
    events: { version: "1" },
    logs: { version: 1 },
    databaseMigrations: { version: "0001_init" },
  },
};

const BASE_FILES = {
  "compatibility.json": JSON.stringify(BASE_MANIFEST, null, 2),
  "package.json": JSON.stringify({ engines: { node: ">=20" } }),
  "packages/prime-agent/pyproject.toml":
    '[project]\nname = "talos-agent"\nrequires-python = ">=3.10"\n',
  "scripts/doctor.mjs":
    "const MINIMUMS = {\n  node: [20, 0, 0],\n  pnpm: [9, 0, 0],\n  python: [3, 11, 0],\n};\n",
  "contracts/alpha/Cargo.toml":
    '[package]\nname = "alpha"\nedition = "2021"\n',
  ".github/workflows/contracts-ci.yml":
    "uses: dtolnay/rust-toolchain@stable\nrustup target add wasm32-unknown-unknown\n",
  ".devcontainer/Dockerfile":
    "--default-toolchain stable\nrustup target add wasm32-unknown-unknown\n",
  "packages/sdk/src/events.ts":
    'export const TALOS_EVENT_SCHEMA_VERSION = "1" as const;\n',
  "web/src/lib/log-schema.ts": "export const LOG_SCHEMA_VERSION = 1;\n",
  "web/drizzle/meta/_journal.json": JSON.stringify({
    entries: [{ tag: "0001_init" }],
  }),
};

const tempDirs = [];

async function makeRepo(overrides = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "talos-compat-"));
  tempDirs.push(root);
  const files = { ...BASE_FILES, ...overrides };
  for (const [relativePath, contents] of Object.entries(files)) {
    if (contents === null) continue;
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("checkCompatibility", () => {
  it("passes when every recorded expectation matches the repository", async () => {
    const rootDir = await makeRepo();
    const result = await checkCompatibility({ rootDir });

    assert.equal(result.ok, true);
    assert.equal(result.checks.length, 11);
    assert.match(formatReport(result), /OK: compatibility manifest matches/);
  });

  it("fails when package.json requires a newer Node.js than the manifest records", async () => {
    const rootDir = await makeRepo({
      "package.json": JSON.stringify({ engines: { node: ">=22" } }),
    });
    const result = await checkCompatibility({ rootDir });

    assert.equal(result.ok, false);
    const check = result.checks.find((entry) => entry.id === "node.minimum");
    assert.equal(check.ok, false);
    assert.equal(check.expected, "20.0.0");
    assert.equal(check.actual, "22.0.0");
  });

  it("fails when the contributor Python minimum drifts from doctor.mjs", async () => {
    const rootDir = await makeRepo({
      "scripts/doctor.mjs":
        "const MINIMUMS = {\n  node: [20, 0, 0],\n  pnpm: [9, 0, 0],\n  python: [3, 10, 0],\n};\n",
    });
    const result = await checkCompatibility({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((entry) => entry.id === "python.contributorMinimum").ok,
      false,
    );
  });

  it("fails when a Rust crate uses a different edition", async () => {
    const rootDir = await makeRepo({
      "contracts/beta/Cargo.toml": '[package]\nname = "beta"\nedition = "2018"\n',
    });
    const result = await checkCompatibility({ rootDir });

    assert.equal(result.ok, false);
    const check = result.checks.find((entry) => entry.id === "rust.edition");
    assert.equal(check.ok, false);
    assert.match(check.actual, /beta=2018/);
  });

  it("fails when the event schema version changes without updating the manifest", async () => {
    const rootDir = await makeRepo({
      "packages/sdk/src/events.ts":
        'export const TALOS_EVENT_SCHEMA_VERSION = "2" as const;\n',
    });
    const result = await checkCompatibility({ rootDir });

    assert.equal(result.ok, false);
    assert.equal(
      result.checks.find((entry) => entry.id === "schemas.events.version").ok,
      false,
    );
  });

  it("fails closed when a version source is missing", async () => {
    const rootDir = await makeRepo({
      "packages/prime-agent/pyproject.toml": null,
    });

    await assert.rejects(
      () => checkCompatibility({ rootDir }),
      /cannot read packages\/prime-agent\/pyproject.toml/,
    );
  });

  it("rejects a manifest with a missing required section", async () => {
    const manifest = structuredClone(BASE_MANIFEST);
    delete manifest.schemas.logs;
    const rootDir = await makeRepo({
      "compatibility.json": JSON.stringify(manifest, null, 2),
    });

    await assert.rejects(
      () => checkCompatibility({ rootDir }),
      /schemas\.logs\.version is missing/,
    );
  });

  it("rejects a malformed manifest", async () => {
    const rootDir = await makeRepo({
      "compatibility.json": "{ not json",
    });

    await assert.rejects(
      () => checkCompatibility({ rootDir }),
      /compatibility\.json is not valid JSON/,
    );
  });
});
