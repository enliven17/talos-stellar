import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const tsDir = path.dirname(require.resolve("typescript/package.json"));
const enumsDir = path.join(tsDir, "dist", "enums");
if (fs.existsSync(enumsDir)) {
  for (const file of fs.readdirSync(enumsDir)) {
    if (file.endsWith(".enum.js")) {
      try {
        const mod = require(path.join(enumsDir, file));
        for (const [key, val] of Object.entries(mod)) {
          if (!ts[key]) {
            ts[key] = val;
          }
        }
      } catch {
        // ignore
      }
    }
  }
}

if (!ts.Extension) {
  ts.Extension = {
    Ts: ".ts",
    Tsx: ".tsx",
    Dts: ".d.ts",
    Js: ".js",
    Jsx: ".jsx",
    Json: ".json",
    TsBuildInfo: ".tsbuildinfo",
    Mjs: ".mjs",
    Mts: ".mts",
    Dmts: ".d.mts",
    Cjs: ".cjs",
    Cts: ".cts",
    Dcts: ".d.cts",
  };
}

export default ts;
