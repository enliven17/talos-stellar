import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import {
  checkDocumentedScripts,
  extractCodeSegments,
  parseInvocationLine,
} from "./check-documented-scripts.mjs";

const BASE_PACKAGES = {
  "package.json": {
    name: "talos-protocol",
    scripts: { doctor: "x", build: "x", lint: "x", "stack:up": "x" },
  },
  "web/package.json": {
    name: "web",
    scripts: { lint: "x", test: "x", "test:unit": "x" },
  },
  "packages/sdk/package.json": {
    name: "@talos-protocol/sdk",
    scripts: { build: "x", test: "x" },
  },
  "contracts/package.json": {
    name: "@talos/contracts",
    scripts: { test: "x" },
  },
};

const BASE_README = `# Test repo

Run \`pnpm run doctor\` and \`pnpm build\`.

\`\`\`bash
pnpm --dir web run lint
pnpm --dir web test
pnpm --filter @talos-protocol/sdk run build
cd contracts && npm test
pnpm install --frozen-lockfile
pnpm run <script>
pnpm 9
pnpm exec tsc --noEmit
\`\`\`
`;

const BASE_GUIDE = `# Guide

Run \`pnpm test:unit\` for the web unit suite.
The SDK instructions live in \`packages/sdk\`; run \`npm test\` there.
`;

const tempDirs = [];

async function makeRepo({ files = {}, packages = BASE_PACKAGES } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "talos-doc-scripts-"));
  tempDirs.push(root);

  const allFiles = {
    "README.md": BASE_README,
    "docs/guide.md": BASE_GUIDE,
    ...Object.fromEntries(
      Object.entries(packages).map(([relativePath, contents]) => [
        relativePath,
        JSON.stringify(contents, null, 2),
      ]),
    ),
    ...files,
  };

  for (const [relativePath, contents] of Object.entries(allFiles)) {
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

describe("checkDocumentedScripts", () => {
  it("accepts documented scripts that exist in their package.json", async () => {
    const rootDir = await makeRepo();
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 0, JSON.stringify(result.missing, null, 2));
    assert.equal(result.checked, 8);
    assert.ok(result.entries.every((entry) => entry.ok));
  });

  it("resolves a bare script when exactly one workspace provides it", async () => {
    const rootDir = await makeRepo();
    const result = await checkDocumentedScripts({ rootDir });
    const entry = result.entries.find((item) => item.script === "test:unit");

    assert.ok(entry);
    assert.equal(entry.ok, true);
    assert.equal(entry.workspace, "web/package.json");
    assert.equal(entry.note, "unique workspace match");
  });

  it("uses surrounding text to resolve a workspace for inline commands", async () => {
    const rootDir = await makeRepo();
    const result = await checkDocumentedScripts({ rootDir });
    const entry = result.entries.find(
      (item) => item.command === "npm test" && item.file === "docs/guide.md",
    );

    assert.ok(entry);
    assert.equal(entry.ok, true);
    assert.equal(entry.workspace, "packages/sdk/package.json");
    assert.equal(entry.note, "workspace inferred from surrounding text");
  });

  it("reports a missing root script with file and line", async () => {
    const rootDir = await makeRepo({
      files: { "README.md": "# Repo\n\nRun `pnpm run nope`.\n" },
      packages: { ...BASE_PACKAGES },
    });
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].file, "README.md");
    assert.equal(result.missing[0].line, 3);
    assert.equal(result.missing[0].script, "nope");
    assert.equal(result.missing[0].workspace, "package.json");
  });

  it("reports a missing script in an explicit workspace", async () => {
    const rootDir = await makeRepo({
      files: {
        "README.md": "# Repo\n\n```bash\npnpm --dir web run nope\n```\n",
      },
    });
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].workspace, "web/package.json");
    assert.match(result.missing[0].reason, /no "nope" script/);
  });

  it("tracks cd inside a fenced block", async () => {
    const rootDir = await makeRepo({
      files: {
        "README.md": "# Repo\n\n```bash\ncd web\npnpm nope\n```\n",
      },
    });
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].workspace, "web/package.json");
  });

  it("reports an unknown --filter workspace", async () => {
    const rootDir = await makeRepo({
      files: {
        "README.md": "# Repo\n\nRun `pnpm --filter unknown run build`.\n",
      },
    });
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 1);
    assert.match(result.missing[0].reason, /no workspace package named "unknown"/);
  });

  it("does not guess when a bare script exists in several workspaces", async () => {
    const rootDir = await makeRepo({
      files: { "README.md": "# Repo\n\nRun `pnpm test`.\n" },
    });
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 1);
    assert.equal(result.missing[0].script, "test");
    assert.equal(result.missing[0].workspace, "package.json");
  });

  it("ignores prose, placeholders, package-manager builtins, and versions", async () => {
    const rootDir = await makeRepo({
      files: {
        "README.md": [
          "# Repo",
          "",
          "pnpm nope outside code is prose.",
          "",
          "Run `pnpm run <script>`, `pnpm --dir <package> exec tsc`, `pnpm install`,",
          "`pnpm exec tsc --noEmit`, and `pnpm 9`.",
          "",
          "Use `pnpm run doctor`.",
          "",
        ].join("\n"),
        "docs/guide.md": null,
      },
    });
    const result = await checkDocumentedScripts({ rootDir });

    assert.equal(result.missing.length, 0);
    assert.equal(result.checked, 1);
  });

  it("fails closed when no documentation files exist", async () => {
    const rootDir = await makeRepo({
      files: { "README.md": null, "docs/guide.md": null },
    });

    await assert.rejects(
      () => checkDocumentedScripts({ rootDir }),
      /no Markdown documentation files found/,
    );
  });

  it("fails closed when a package.json is malformed", async () => {
    const rootDir = await makeRepo({
      files: { "package.json": "{ not json" },
    });

    await assert.rejects(
      () => checkDocumentedScripts({ rootDir }),
      /package\.json is not valid JSON/,
    );
  });

  it("produces stable, sorted results", async () => {
    const rootDir = await makeRepo({
      files: {
        "README.md": "# Repo\n\nRun `pnpm run zeta` and `pnpm run alpha`.\n",
      },
    });

    const first = await checkDocumentedScripts({ rootDir });
    const second = await checkDocumentedScripts({ rootDir });

    assert.deepEqual(first, second);
    assert.deepEqual(
      first.missing.map((entry) => entry.script),
      ["alpha", "zeta"],
    );
  });
});

describe("parseInvocationLine", () => {
  it("parses global flags, run, and script arguments", () => {
    const { invocations } = parseInvocationLine(
      "pnpm --dir web run lint --fix",
      { cwd: "/repo", rootDir: "/repo" },
    );

    assert.equal(invocations.length, 1);
    assert.equal(invocations[0].script, "lint");
    assert.equal(invocations[0].dir, "/repo/web");
    assert.equal(invocations[0].explicitDir, true);
  });

  it("parses npm test and npm run", () => {
    const { invocations } = parseInvocationLine(
      "npm test && npm run build",
      { cwd: "/repo", rootDir: "/repo" },
    );

    assert.deepEqual(
      invocations.map((invocation) => invocation.script),
      ["test", "build"],
    );
  });

  it("ignores non-npm and non-pnpm commands", () => {
    const { invocations } = parseInvocationLine(
      "cargo test && uv run pytest",
      { cwd: "/repo", rootDir: "/repo" },
    );

    assert.deepEqual(invocations, []);
  });
});

describe("extractCodeSegments", () => {
  it("extracts fenced lines and inline spans but not prose", () => {
    const segments = extractCodeSegments(
      ["Run `pnpm doctor`.", "```bash", "pnpm test", "```", "pnpm prose"].join("\n"),
    );

    assert.deepEqual(
      segments.map((segment) => segment.text),
      ["pnpm doctor", "pnpm test"],
    );
  });
});
