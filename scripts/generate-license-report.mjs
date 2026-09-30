import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const UNKNOWN_LICENSES = new Set(["", "UNKNOWN", "NOASSERTION", "UNLICENSED"]);

export function normalizeLicenseReport(raw, { failOnUnknown = true } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pnpm returned an invalid license report");
  }

  const records = [];
  for (const [license, packages] of Object.entries(raw)) {
    const normalizedLicense = String(license).trim();
    if (failOnUnknown && UNKNOWN_LICENSES.has(normalizedLicense.toUpperCase())) {
      throw new Error("dependency license metadata is missing or ambiguous");
    }
    if (!Array.isArray(packages)) {
      throw new Error("pnpm returned an invalid license group");
    }

    for (const item of packages) {
      if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) {
        throw new Error("pnpm returned an invalid dependency record");
      }
      const versions = Array.isArray(item.versions)
        ? item.versions.filter((version) => typeof version === "string" && version.trim())
        : [];
      if (versions.length === 0) {
        throw new Error(`dependency ${item.name} has no version`);
      }

      records.push({
        name: item.name,
        versions: [...new Set(versions)].sort(),
        license: normalizedLicense || "UNKNOWN",
        homepage: typeof item.homepage === "string" ? item.homepage : undefined,
      });
    }
  }

  return records.sort((left, right) => left.name.localeCompare(right.name) || left.license.localeCompare(right.license));
}

export function runPnpm(cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const command = process.platform === "win32" ? process.env.ComSpec : "pnpm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd licenses list --json --long"]
      : ["licenses", "list", "--json", "--long"];
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => rejectRun(new Error("pnpm is not installed or could not be started")));
    child.on("close", (code) => {
      if (code !== 0) {
        rejectRun(new Error("pnpm could not generate the dependency license report"));
        return;
      }
      try {
        resolveRun(JSON.parse(stdout));
      } catch {
        rejectRun(new Error("pnpm returned malformed license-report JSON"));
      }
    });
  });
}

function markdown(records) {
  const lines = [
    "# Dependency License Report",
    "",
    "Generated from the installed pnpm workspace dependency graph. This file is an artifact; rerun `pnpm licenses:report` after dependency changes.",
    "",
    "| Dependency | Version(s) | License | Homepage |",
    "| --- | --- | --- | --- |",
  ];
  for (const record of records) {
    const homepage = record.homepage ? `[link](${record.homepage})` : "";
    lines.push(`| ${record.name} | ${record.versions.join(", ")} | ${record.license} | ${homepage} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function generateLicenseReport({ cwd = process.cwd(), outputDir = "dist/licenses", runLicenseCommand = runPnpm, maxAttempts = 2 } = {}) {
  let raw;
  let lastError;
  const attempts = Math.max(1, Math.min(2, Number.isInteger(maxAttempts) ? maxAttempts : 2));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      raw = await runLicenseCommand(cwd);
      break;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw lastError;
    }
  }

  const records = normalizeLicenseReport(raw, { failOnUnknown: false });
  const destination = resolve(cwd, outputDir);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "dependency-licenses.json"), `${JSON.stringify({ generatedBy: "pnpm licenses", dependencies: records }, null, 2)}\n`);
  await writeFile(join(destination, "dependency-licenses.md"), markdown(records));
  if (records.some(({ license }) => UNKNOWN_LICENSES.has(license.toUpperCase()))) {
    throw new Error("dependency license metadata is missing or ambiguous");
  }
  return { count: records.length, destination };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  generateLicenseReport()
    .then(({ count, destination }) => console.log(`License report generated: ${count} dependencies in ${destination}`))
    .catch((error) => {
      console.error(`License report failed: ${error.message}`);
      process.exitCode = 1;
    });
}