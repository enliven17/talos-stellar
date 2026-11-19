#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distCli = resolve(__dirname, "..", "dist", "esm", "cli.js");

let runCli;
if (existsSync(distCli)) {
  const mod = await import(pathToFileURL(distCli).href);
  runCli = mod.runCli;
} else {
  try {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [resolve(__dirname, "..", "src", "cli.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
      external: ["@stellar/stellar-sdk", "node:*"],
    });
    const code = result.outputFiles[0].text;
    const dataUri = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
    const mod = await import(dataUri);
    runCli = mod.runCli;
  } catch (err) {
    console.error(
      "Failed to load CLI. Run `pnpm run build` or install devDependencies: " +
        (err?.message ?? err),
    );
    process.exit(1);
  }
}

runCli(process.argv.slice(2)).then(
  (exitCode) => {
    process.exit(typeof exitCode === "number" ? exitCode : 0);
  },
  (err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  },
);
