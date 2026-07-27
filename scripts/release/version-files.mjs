import { readFileSync, writeFileSync, existsSync } from "node:fs";

const VERSION_LINE_RE = /^(\s*version\s*=\s*")([^"]+)(")/m;

/**
 * @param {string} file
 * @param {'json'|'toml'} kind
 * @returns {string}
 */
export function readVersion(file, kind) {
  if (!existsSync(file)) {
    throw new Error(`manifest not found: ${file}`);
  }
  const text = readFileSync(file, "utf8");

  if (kind === "json") {
    const parsed = JSON.parse(text);
    if (typeof parsed.version !== "string") {
      throw new Error(`${file} has no "version" string field`);
    }
    return parsed.version;
  }

  if (kind === "toml") {
    const match = VERSION_LINE_RE.exec(text);
    if (!match) {
      throw new Error(`${file} has no version = "..." line`);
    }
    return match[2];
  }

  throw new Error(`unknown manifest kind: ${kind}`);
}

/**
 * @param {string} file
 * @param {'json'|'toml'} kind
 * @param {string} version
 */
export function writeVersion(file, kind, version) {
  const text = readFileSync(file, "utf8");

  if (kind === "json") {
    const parsed = JSON.parse(text);
    parsed.version = version;
    writeFileSync(file, JSON.stringify(parsed, null, 2) + "\n");
    return;
  }

  if (kind === "toml") {
    if (!VERSION_LINE_RE.test(text)) {
      throw new Error(`${file} has no version = "..." line`);
    }
    const updated = text.replace(VERSION_LINE_RE, `$1${version}$3`);
    writeFileSync(file, updated);
    return;
  }

  throw new Error(`unknown manifest kind: ${kind}`);
}
