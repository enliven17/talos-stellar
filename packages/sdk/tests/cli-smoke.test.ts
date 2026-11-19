import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, "..", "bin", "talos.js");

describe("Talos CLI - Smoke Test Spawning Built Binary", () => {
  it("spawns 'talos --help' successfully", () => {
    const result = spawnSync(process.execPath, [BIN_PATH, "--help"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: talos");
    expect(result.stdout).toContain("talos get <id>");
    expect(result.stdout).toContain("services list");
    expect(result.stdout).toContain("jobs get <id>");
    expect(result.stdout).toContain("webhooks verify");
  });

  it("spawns 'talos --version' successfully", () => {
    const result = spawnSync(process.execPath, [BIN_PATH, "--version"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("talos v0.1.0");
  });

  it("spawns 'talos get' without id and exits with non-zero code", () => {
    const result = spawnSync(process.execPath, [BIN_PATH, "get"], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing required argument: <id>");
  });

  it("spawns 'talos get --json' without id and outputs JSON error with non-zero code", () => {
    const result = spawnSync(process.execPath, [BIN_PATH, "get", "--json"], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.error).toContain("Missing required argument: <id>");
  });

  it("spawns 'talos webhooks verify' end-to-end with temp file and env var", () => {
    const secret = "smoke_secret_abc123xyz";
    const now = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ type: "activity.created", id: "act_123" });
    const hmac = createHmac("sha256", secret).update(`${now}.${payload}`).digest("hex");
    const sigHeader = `t=${now},v1=${hmac}`;

    const tempFilePath = resolve(__dirname, "temp-webhook-smoke.json");
    writeFileSync(
      tempFilePath,
      JSON.stringify({
        signatureHeader: sigHeader,
        payload: { type: "activity.created", id: "act_123" },
      }),
      "utf8",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          BIN_PATH,
          "webhooks",
          "verify",
          "--secret-env",
          "SMOKE_WEBHOOK_SECRET",
          "--file",
          tempFilePath,
          "--json",
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SMOKE_WEBHOOK_SECRET: secret,
          },
        },
      );

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.valid).toBe(true);
      expect(output.timestamp).toBe(now);
    } finally {
      try {
        unlinkSync(tempFilePath);
      } catch {}
    }
  });

  it("rejects --api-key flag with non-zero exit code to enforce env-var only credentials", () => {
    const result = spawnSync(
      process.execPath,
      [BIN_PATH, "get", "tls_1", "--api-key", "secret123"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("API keys must not be passed via CLI arguments");
    expect(result.stderr).not.toContain("secret123");
  });
});
