import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WORKSPACES,
  classifyPath,
  formatPlan,
  parseArgs,
  planLocalSmoke,
} from "./local-smoke-plan.mjs";

const commandsFor = (plan, workspace) =>
  plan.commands.filter((entry) => entry.workspace === workspace).map((entry) => entry.command);

describe("planLocalSmoke", () => {
  it("prints nothing to run when there are no changed files", () => {
    const plan = planLocalSmoke({ changedFiles: [] });

    assert.equal(plan.status, "no-changes");
    assert.deepEqual(plan.workspaces, []);
    assert.deepEqual(plan.commands, []);
    assert.match(formatPlan(plan), /Nothing to run/);
  });

  it("selects only the web workspace for web changes", () => {
    const plan = planLocalSmoke({ changedFiles: ["web/src/app/page.tsx"] });

    assert.equal(plan.status, "ok");
    assert.deepEqual(plan.workspaces, ["web"]);
    assert.deepEqual(commandsFor(plan, "web"), [
      "pnpm --dir web exec tsc --noEmit",
      "pnpm --dir web run lint",
      "pnpm --dir web run test:unit",
      "pnpm --dir web run test:payment-coverage",
      "pnpm --dir web run test:a11y",
    ]);
    assert.deepEqual(commandsFor(plan, "contracts"), []);
  });

  it("selects SDK and contracts together without unrelated workspaces", () => {
    const plan = planLocalSmoke({
      changedFiles: ["packages/sdk/src/client.ts", "contracts/talos_registry/src/lib.rs"],
    });

    assert.deepEqual(plan.workspaces, ["sdk", "contracts"]);
    assert.deepEqual(commandsFor(plan, "sdk"), [
      "pnpm --dir packages/sdk run build",
      "pnpm --dir packages/sdk run test",
    ]);
    assert.deepEqual(commandsFor(plan, "contracts"), [
      "cd contracts && cargo test",
      "cd contracts && cargo build --target wasm32-unknown-unknown --release",
    ]);
    assert.deepEqual(commandsFor(plan, "web"), []);
  });

  it("fails closed to every workspace for unclassified paths", () => {
    const plan = planLocalSmoke({ changedFiles: ["foo/bar.txt"] });

    assert.equal(plan.status, "unknown-paths");
    assert.deepEqual(plan.workspaces, WORKSPACES);
    assert.deepEqual(plan.unknownFiles, ["foo/bar.txt"]);
    assert.ok(commandsFor(plan, "root").length > 0);
    assert.ok(formatPlan(plan).includes("Unclassified paths (1)"));
  });

  it("runs every workspace when a shared root file changes", () => {
    for (const file of ["package.json", "pnpm-lock.yaml", "scripts/doctor.mjs", ".github/workflows/ci.yml"]) {
      const plan = planLocalSmoke({ changedFiles: [file] });
      assert.deepEqual(plan.workspaces, WORKSPACES, file);
      assert.ok(commandsFor(plan, "root").length > 0, file);
    }
  });

  it("treats contracts/package.json as shared toolchain input", () => {
    const plan = planLocalSmoke({ changedFiles: ["contracts/package.json"] });

    assert.deepEqual(plan.workspaces, WORKSPACES);
    assert.ok(commandsFor(plan, "root").length > 0);
  });

  it("skips workspace checks for documentation-only changes", () => {
    const plan = planLocalSmoke({
      changedFiles: ["docs/compatibility.md", "README.md", "CONTRIBUTING.md"],
    });

    assert.equal(plan.status, "docs-only");
    assert.deepEqual(plan.commands, []);
    assert.match(formatPlan(plan), /Documentation-only/);
  });

  it("never reads environment files and only reports their paths", () => {
    const plan = planLocalSmoke({ changedFiles: [".env.local"] });
    const output = formatPlan(plan);

    assert.equal(plan.status, "environment-only");
    assert.deepEqual(plan.commands, []);
    assert.ok(output.includes(".env.local"));
    assert.ok(!output.includes("SUPER_SECRET"));
  });

  it("produces identical output regardless of input order", () => {
    const forward = planLocalSmoke({
      changedFiles: ["web/src/a.ts", "contracts/a/src/lib.rs", "docs/x.md"],
    });
    const reverse = planLocalSmoke({
      changedFiles: ["docs/x.md", "contracts/a/src/lib.rs", "web/src/a.ts"],
    });

    assert.deepEqual(forward, reverse);
    assert.equal(formatPlan(forward), formatPlan(reverse));
  });

  it("plans every workspace for --all even with no changed files", () => {
    const plan = planLocalSmoke({ changedFiles: [], all: true });

    assert.equal(plan.status, "all");
    assert.deepEqual(plan.workspaces, WORKSPACES);
    assert.ok(commandsFor(plan, "root").length > 0);
    assert.match(formatPlan(plan), /Planning all workspaces/);
  });
});

describe("classifyPath", () => {
  it("normalizes Windows separators and leading ./", () => {
    assert.equal(classifyPath(".\\web\\src\\a.ts"), "web");
    assert.equal(classifyPath("./packages/sdk/src/a.ts"), "sdk");
  });

  it("recognizes environment files at any depth", () => {
    assert.equal(classifyPath(".env"), "environment");
    assert.equal(classifyPath("web/.env.production"), "environment");
  });

  it("marks everything else as unknown", () => {
    assert.equal(classifyPath("random/file.bin"), "unknown");
  });
});

describe("parseArgs", () => {
  it("parses repeated and comma-separated file flags", () => {
    const options = parseArgs([
      "--file",
      "web/a.ts,contracts/b.rs",
      "--file=docs/c.md",
      "--base",
      "origin/main",
      "--head=HEAD",
      "--json",
    ]);

    assert.deepEqual(options.files, ["web/a.ts", "contracts/b.rs", "docs/c.md"]);
    assert.equal(options.base, "origin/main");
    assert.equal(options.head, "HEAD");
    assert.equal(options.json, true);
  });

  it("ignores a bare -- separator passed by package managers", () => {
    const options = parseArgs(["--", "--file", "web/a.ts"]);

    assert.deepEqual(options.files, ["web/a.ts"]);
  });

  it("rejects a flag without a value", () => {
    assert.throws(() => parseArgs(["--file"]), /--file requires a value/);
    assert.throws(() => parseArgs(["--file", "--json"]), /--file requires a value/);
  });

  it("rejects unknown arguments", () => {
    assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  });
});
