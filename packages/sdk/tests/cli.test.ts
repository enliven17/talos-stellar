import { describe, it, expect, vi } from "vitest";
import { runCli, parseArgs, redactOutput, redactObject, verifyWebhookSignature, HELP_TEXT } from "../src/cli.js";
import { createHmac } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("Talos CLI - Argument Parser", () => {
  it("parses subcommands and flags correctly", () => {
    const parsed = parseArgs(["get", "tls_123", "--json", "--base-url", "http://localhost:3000"]);
    expect(parsed.command).toEqual(["get", "tls_123"]);
    expect(parsed.options.json).toBe(true);
    expect(parsed.options.baseUrl).toBe("http://localhost:3000");
  });

  it("parses inline options (--base-url=...)", () => {
    const parsed = parseArgs(["services", "list", "--category=Marketing", "--limit=10"]);
    expect(parsed.command).toEqual(["services", "list"]);
    expect(parsed.options.category).toBe("Marketing");
    expect(parsed.options.limit).toBe(10);
  });

  it("rejects --api-key passed via CLI argument to protect shell history", () => {
    expect(() => parseArgs(["get", "tls_1", "--api-key", "secret123"])).toThrow(
      /API keys must not be passed via CLI arguments/,
    );
  });

  it("handles --help and --version", () => {
    const helpParsed = parseArgs(["-h"]);
    expect(helpParsed.options.help).toBe(true);

    const versionParsed = parseArgs(["--version"]);
    expect(versionParsed.options.version).toBe(true);
  });
});

describe("Talos CLI - Secret Redaction", () => {
  it("redacts explicit custom secrets", () => {
    const raw = "Connecting with key super_secret_key_12345 to API";
    const redacted = redactOutput(raw, ["super_secret_key_12345"]);
    expect(redacted).not.toContain("super_secret_key_12345");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const raw = "Authorization: Bearer my-secret-jwt-token-xyz123";
    const redacted = redactOutput(raw);
    expect(redacted).not.toContain("my-secret-jwt-token-xyz123");
    expect(redacted).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts Stellar secret seeds", () => {
    const seed = "SB3K723F5F4V4M6VVRFX2F4E2G6K3H4M5N6P7Q8R9S0T1U2V3W4X5Y6Z";
    const raw = `Using signing key: ${seed}`;
    const redacted = redactOutput(raw);
    expect(redacted).not.toContain(seed);
    expect(redacted).toContain("[REDACTED_STELLAR_SEED]");
  });

  it("redacts secret fields in objects", () => {
    const obj = {
      id: "tls_123",
      apiKey: "secret-token-xyz",
      nested: {
        authorization: "Bearer 12345",
        publicName: "Agent Smith",
      },
    };
    const redacted = redactObject(obj, ["secret-token-xyz"]);
    expect(redacted.apiKey).toBe("[REDACTED]");
    expect((redacted.nested as any).authorization).toBe("[REDACTED]");
    expect((redacted.nested as any).publicName).toBe("Agent Smith");
  });
});

describe("Talos CLI - Command Handlers with Mocked Client", () => {
  const createMockClient = () => ({
    getTalos: vi.fn(),
    getTalosMe: vi.fn(),
    discoverServices: vi.fn(),
    getJobResult: vi.fn(),
    checkNameAvailability: vi.fn(),
  });

  it("shows help when no args or --help is passed", async () => {
    let stdoutOutput = "";
    const exitCode = await runCli(["--help"], {
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });
    expect(exitCode).toBe(0);
    expect(stdoutOutput).toContain("Usage: talos");
    expect(stdoutOutput).toContain("talos get <id>");
  });

  it("executes 'talos get <id>' successfully", async () => {
    const mockClient = createMockClient();
    mockClient.getTalos.mockResolvedValueOnce({
      id: "tls_001",
      agentName: "AlphaBot",
      category: "Finance",
      description: "Autonomous finance agent",
      walletPublicKey: "GA123...",
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["get", "tls_001"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    expect(mockClient.getTalos).toHaveBeenCalledWith("tls_001");
    expect(stdoutOutput).toContain("Talos ID:    tls_001");
    expect(stdoutOutput).toContain("AlphaBot");
  });

  it("executes 'talos get <id> --json' successfully", async () => {
    const mockClient = createMockClient();
    mockClient.getTalos.mockResolvedValueOnce({
      id: "tls_001",
      agentName: "AlphaBot",
      apiKey: "sensitive-token-abc",
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["get", "tls_001", "--json"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.id).toBe("tls_001");
    expect(parsed.apiKey).toBe("[REDACTED]"); // Guarantee: secrets never appear in output
  });

  it("executes 'talos get me' calling getTalosMe()", async () => {
    const mockClient = createMockClient();
    mockClient.getTalosMe.mockResolvedValueOnce({
      id: "tls_me",
      agentName: "SelfBot",
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["get", "me"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    expect(mockClient.getTalosMe).toHaveBeenCalled();
    expect(stdoutOutput).toContain("SelfBot");
  });

  it("returns non-zero exit code when 'get' is missing <id>", async () => {
    let stderrOutput = "";
    const exitCode = await runCli(["get"], {
      stderr: (msg) => { stderrOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("Missing required argument: <id>");
  });

  it("executes 'services list' with filters", async () => {
    const mockClient = createMockClient();
    mockClient.discoverServices.mockResolvedValueOnce({
      items: [
        { id: "svc_1", serviceName: "Market Maker", category: "DeFi", price: 5, talosId: "tls_1" },
        { id: "svc_2", serviceName: "Newsfeed", category: "Media", price: 1, talosId: "tls_2" },
      ],
      nextCursor: null,
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["services", "list", "--category", "DeFi", "--limit", "5"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    expect(mockClient.discoverServices).toHaveBeenCalledWith({
      category: "DeFi",
      limit: 5,
      cursor: undefined,
    });
    expect(stdoutOutput).toContain("1. Market Maker");
    expect(stdoutOutput).toContain("5 USDC");
  });

  it("executes 'jobs get <id>'", async () => {
    const mockClient = createMockClient();
    mockClient.getJobResult.mockResolvedValueOnce({
      id: "job_999",
      talosId: "tls_provider",
      status: "completed",
      result: { answer: "success" },
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["jobs", "get", "job_999"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    expect(mockClient.getJobResult).toHaveBeenCalledWith("job_999");
    expect(stdoutOutput).toContain("Job ID:     job_999");
    expect(stdoutOutput).toContain("completed");
  });

  it("executes 'talos check-name <name>'", async () => {
    const mockClient = createMockClient();
    mockClient.checkNameAvailability.mockResolvedValueOnce({
      available: true,
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["check-name", "nexus-bot"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    expect(mockClient.checkNameAvailability).toHaveBeenCalledWith("nexus-bot");
    expect(stdoutOutput).toContain('Name "nexus-bot" is available.');
  });

  it("executes 'names check <name>' when unavailable", async () => {
    const mockClient = createMockClient();
    mockClient.checkNameAvailability.mockResolvedValueOnce({
      available: false,
      reason: "Name already taken",
    });

    let stdoutOutput = "";
    const exitCode = await runCli(["names", "check", "taken-name"], {
      client: mockClient as any,
      stdout: (msg) => { stdoutOutput += msg + "\n"; },
    });

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toContain('Name "taken-name" is not available: Name already taken');
  });
});

describe("Talos CLI - Webhook Verification", () => {
  const secret = "whsec_test_secret_key_123456789";
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ event: "revenue.recorded", amount: 100 });
  const hmac = createHmac("sha256", secret).update(`${now}.${payload}`).digest("hex");
  const signatureHeader = `t=${now},v1=${hmac}`;

  it("verifies webhook with --secret-env and --file", async () => {
    let stdoutOutput = "";
    const exitCode = await runCli(
      [
        "webhooks", "verify",
        "--secret-env", "TEST_WEBHOOK_SECRET",
        "--file", "dummy-payload.json",
        "--signature", signatureHeader,
      ],
      {
        env: { TEST_WEBHOOK_SECRET: secret },
        readFile: () => payload,
        stdout: (msg) => { stdoutOutput += msg + "\n"; },
      },
    );

    expect(exitCode).toBe(0);
    expect(stdoutOutput).toContain("Webhook signature verified successfully");
  });

  it("verifies webhook with envelope JSON file containing signatureHeader", async () => {
    const envelope = JSON.stringify({
      signatureHeader,
      payload: { event: "revenue.recorded", amount: 100 },
    });

    let stdoutOutput = "";
    const exitCode = await runCli(
      [
        "webhooks", "verify",
        "--secret-env", "TEST_WEBHOOK_SECRET",
        "--file", "envelope.json",
        "--json",
      ],
      {
        env: { TEST_WEBHOOK_SECRET: secret },
        readFile: () => envelope,
        stdout: (msg) => { stdoutOutput += msg + "\n"; },
      },
    );

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.valid).toBe(true);
    expect(parsed.timestamp).toBe(now);
  });

  it("fails when secret env var is not set", async () => {
    let stderrOutput = "";
    const exitCode = await runCli(
      ["webhooks", "verify", "--secret-env", "MISSING_VAR", "--file", "payload.json"],
      {
        env: {},
        stderr: (msg) => { stderrOutput += msg + "\n"; },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain('Environment variable "MISSING_VAR" is not set');
  });

  it("fails and exits non-zero on signature mismatch", async () => {
    let stderrOutput = "";
    const exitCode = await runCli(
      [
        "webhooks", "verify",
        "--secret-env", "TEST_WEBHOOK_SECRET",
        "--file", "payload.json",
        "--signature", `t=${now},v1=deadbeef12345678`,
      ],
      {
        env: { TEST_WEBHOOK_SECRET: secret },
        readFile: () => payload,
        stderr: (msg) => { stderrOutput += msg + "\n"; },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderrOutput).toContain("Webhook verification failed: Signature mismatch");
  });
});

describe("Talos CLI - Browser Bundle Exclusion Acceptance Criterion", () => {
  it("CLI symbols and subcommands are NOT present in the browser bundle", () => {
    const browserBundlePath = resolve(__dirname, "..", "dist", "browser", "sdk.bundle.js");
    if (!existsSync(browserBundlePath)) {
      // If not yet built, verify index.ts does not export CLI
      const indexSrc = readFileSync(resolve(__dirname, "..", "src", "index.ts"), "utf8");
      expect(indexSrc).not.toContain("./cli.js");
      expect(indexSrc).not.toContain("runCli");
      return;
    }

    const bundleContent = readFileSync(browserBundlePath, "utf8");
    // Assert CLI commands and functions are excluded from browser bundle
    expect(bundleContent).not.toContain("webhooks verify");
    expect(bundleContent).not.toContain("secret-env");
    expect(bundleContent).not.toContain("parseArgs");
  });
});
