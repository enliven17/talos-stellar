import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collisionKey,
  findCaseCollisions,
  formatReport,
  readTrackedPaths,
} from "./check-tracked-path-collisions.mjs";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "check-tracked-path-collisions.mjs");

function runCli(...args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

/** Build a throwaway git checkout with the given tracked files. */
function makeRepo(t, files) {
  const root = mkdtempSync(join(tmpdir(), "talos-path-collisions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  for (const file of files) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "tracked\n");
  }

  const add = spawnSync("git", ["-C", root, "add", "--all"], { encoding: "utf8" });
  assert.equal(add.status, 0, add.stderr);
  return root;
}

test("folds separators and case into a stable comparison key", () => {
  assert.equal(collisionKey("docs\\README.md"), "docs/readme.md");
  assert.equal(collisionKey("./docs/README.md"), "docs/readme.md");
});

test("reports every path in a case collision, deterministically sorted", () => {
  const collisions = findCaseCollisions([
    "docs/readme.md",
    "src/App.ts",
    "docs/README.md",
    "SRC/app.ts",
  ]);

  assert.deepEqual(collisions, [
    { key: "docs/readme.md", paths: ["docs/README.md", "docs/readme.md"] },
    { key: "src/app.ts", paths: ["SRC/app.ts", "src/App.ts"] },
  ]);

  const reversed = findCaseCollisions([
    "SRC/app.ts",
    "docs/README.md",
    "src/App.ts",
    "docs/readme.md",
  ]);
  assert.deepEqual(reversed, collisions);
});

test("ignores case differences that are not on the same file path", () => {
  assert.deepEqual(findCaseCollisions(["Docs/a.md", "docs/b.md"]), []);
});

test("reports a file that collides with a case-folded directory", () => {
  assert.deepEqual(
    findCaseCollisions(["docs/Replay.md", "docs/replay.md/notes.md", "docs/other.md"]),
    [
      {
        key: "docs/replay.md",
        paths: ["docs/Replay.md", "docs/replay.md/notes.md"],
      },
    ],
  );
});

test("ignores repeated identical paths", () => {
  assert.deepEqual(findCaseCollisions(["docs/readme.md", "docs/readme.md"]), []);
});

test("formats a clean report", () => {
  assert.equal(
    formatReport({ checked: 1, collisions: [] }),
    "✓ No case collisions across 1 tracked path.",
  );
});

test("CLI passes a checkout with no case collisions", (t) => {
  const root = makeRepo(t, ["docs/README.md", "docs/guide.md", "package.json"]);

  const { status, stdout } = runCli("--root", root, "--json");
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), { checked: 3, collisions: [] });
});

test("CLI fails a checkout with case collisions and lists both paths", (t) => {
  const root = makeRepo(t, ["docs/README.md", "docs/readme.md", "docs/guide.md"]);
  if (readdirSync(join(root, "docs")).length < 3) {
    t.skip("filesystem is case-insensitive; cannot create a case-only collision fixture");
    return;
  }

  const first = runCli("--root", root);
  assert.equal(first.status, 1);
  assert.match(first.stdout, /1 case collision across 2 tracked paths/);
  assert.match(first.stdout, /docs\/README\.md/);
  assert.match(first.stdout, /docs\/readme\.md/);

  const second = runCli("--root", root);
  assert.equal(second.stdout, first.stdout);

  const json = runCli("--root", root, "--json");
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout), {
    checked: 3,
    collisions: [{ key: "docs/readme.md", paths: ["docs/README.md", "docs/readme.md"] }],
  });
});

test("CLI rejects unknown arguments", () => {
  const { status, stderr } = runCli("--nope");
  assert.equal(status, 2);
  assert.match(stderr, /unknown argument: --nope/);
});

test("CLI exits 2 when the tracked paths cannot be read", (t) => {
  const root = mkdtempSync(join(tmpdir(), "talos-path-collisions-not-git-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const { status, stderr } = runCli("--root", root);
  assert.equal(status, 2);
  assert.match(stderr, /could not list tracked paths/);
});

test("readTrackedPaths returns the checkout's tracked paths", (t) => {
  const root = makeRepo(t, ["a.txt", "nested/b.txt"]);

  const tracked = readTrackedPaths(root);
  assert.equal(tracked.ok, true);
  assert.deepEqual(tracked.paths.sort(), ["a.txt", "nested/b.txt"]);
});
