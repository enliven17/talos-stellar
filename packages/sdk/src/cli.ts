import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual } from "node:crypto";
import { TalosClient } from "./client.js";

export interface CliContext {
  client?: TalosClient;
  env?: Record<string, string | undefined>;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  readFile?: (path: string) => string;
}

export interface ParsedArgs {
  command: string[];
  options: {
    json?: boolean;
    baseUrl?: string;
    secretEnv?: string;
    file?: string;
    signature?: string;
    category?: string;
    limit?: number;
    cursor?: string;
    help?: boolean;
    version?: boolean;
    [key: string]: unknown;
  };
}

const KNOWN_SECRET_PATTERNS = [
  /Bearer\s+([A-Za-z0-9_\-\.~+/]+=*)/gi,
  /\bS[A-Z2-7]{55}\b/g,
  /"(?:api[_-]?key|secret|token|password|authorization|private[_-]?key)":\s*"[^"]+"/gi,
  /(?<=[?&](?:apiKey|api_key|token|secret|key)=)[^&\s]+/gi,
];

/**
 * Redact sensitive data from string output.
 */
export function redactOutput(output: string, customSecrets: string[] = []): string {
  let redacted = output;

  // Redact any explicitly supplied secret values
  for (const secret of customSecrets) {
    if (secret && secret.length >= 3) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }

  // Redact Bearer tokens
  redacted = redacted.replace(/Bearer\s+[A-Za-z0-9_\-\.~+/]+=*/gi, "Bearer [REDACTED]");

  // Redact Stellar secret seeds (starts with S, 56 chars)
  redacted = redacted.replace(/\bS[A-Z0-9]{55}\b/g, "[REDACTED_STELLAR_SEED]");

  // Redact sensitive JSON keys in JSON-like output
  redacted = redacted.replace(
    /"(api[_-]?key|secret|token|password|authorization|private[_-]?key)":\s*"[^"]*"/gi,
    '"$1": "[REDACTED]"',
  );

  return redacted;
}

/**
 * Deeply redact secrets from an object before JSON formatting.
 */
export function redactObject<T>(obj: T, customSecrets: string[] = []): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return redactOutput(obj, customSecrets) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, customSecrets)) as unknown as T;
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (/^(apiKey|api_key|secret|token|password|authorization|privateKey|private_key)$/i.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = redactObject(val, customSecrets);
      }
    }
    return result as T;
  }
  return obj;
}

/**
 * Lightweight argument parser.
 */
export function parseArgs(rawArgs: string[]): ParsedArgs {
  const command: string[] = [];
  const options: ParsedArgs["options"] = {};

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];

    if (arg === "--json") {
      options.json = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "--base-url" || arg === "-u") {
      options.baseUrl = rawArgs[++i];
    } else if (arg.startsWith("--base-url=")) {
      options.baseUrl = arg.slice("--base-url=".length);
    } else if (arg === "--secret-env") {
      options.secretEnv = rawArgs[++i];
    } else if (arg.startsWith("--secret-env=")) {
      options.secretEnv = arg.slice("--secret-env=".length);
    } else if (arg === "--file" || arg === "-f") {
      options.file = rawArgs[++i];
    } else if (arg.startsWith("--file=")) {
      options.file = arg.slice("--file=".length);
    } else if (arg === "--signature" || arg === "--signature-header" || arg === "-s") {
      options.signature = rawArgs[++i];
    } else if (arg.startsWith("--signature=")) {
      options.signature = arg.slice("--signature=".length);
    } else if (arg === "--category") {
      options.category = rawArgs[++i];
    } else if (arg.startsWith("--category=")) {
      options.category = arg.slice("--category=".length);
    } else if (arg === "--limit") {
      const val = parseInt(rawArgs[++i], 10);
      options.limit = Number.isFinite(val) ? val : undefined;
    } else if (arg.startsWith("--limit=")) {
      const val = parseInt(arg.slice("--limit=".length), 10);
      options.limit = Number.isFinite(val) ? val : undefined;
    } else if (arg === "--cursor") {
      options.cursor = rawArgs[++i];
    } else if (arg.startsWith("--cursor=")) {
      options.cursor = arg.slice("--cursor=".length);
    } else if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      throw new Error("API keys must not be passed via CLI arguments; set TALOS_API_KEY environment variable instead.");
    } else if (arg.startsWith("-")) {
      // Unknown option flag
      const optName = arg.replace(/^-+/, "");
      options[optName] = true;
    } else {
      command.push(arg);
    }
  }

  return { command, options };
}

export const CLI_VERSION = "0.1.0";

export const HELP_TEXT = `Usage: talos <command> [subcommand] [arguments] [options]

Commands:
  talos get <id>                                  Inspect a Talos by ID (or 'me')
  talos check-name <name>                         Check agent name availability
  services list                                   List available commerce services
  jobs get <id>                                   Get job result and status
  webhooks verify --secret-env VAR --file <file>  Verify a webhook payload and signature

Global Options:
  --json               Format output as raw JSON
  --base-url <url>     Talos API base URL (defaults to TALOS_API_URL or http://localhost:3000)
  -h, --help           Show help
  -v, --version        Show version
`;

/**
 * Verify webhook payload and signature using HMAC-SHA256.
 */
export function verifyWebhookSignature(
  payloadStr: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
): { valid: boolean; timestamp: number } {
  const parts = signatureHeader.split(",");
  let timestamp = -1;
  const signatures: string[] = [];

  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) timestamp = parsed;
    } else if (/^v\d+$/.test(key)) {
      signatures.push(value);
    }
  }

  if (timestamp === -1) {
    throw new Error("Missing or invalid timestamp in signature header");
  }
  if (signatures.length === 0) {
    throw new Error("No signatures found in signature header");
  }

  if (toleranceSeconds > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (now - timestamp > toleranceSeconds) {
      throw new Error(`Timestamp outside tolerance zone (too old: ${now - timestamp}s > ${toleranceSeconds}s)`);
    }
    if (timestamp - now > toleranceSeconds) {
      throw new Error(`Timestamp outside tolerance zone (too far in future: ${timestamp - now}s > ${toleranceSeconds}s)`);
    }
  }

  const candidates = [
    `${timestamp}.${payloadStr}`,
    `1.${timestamp}.${payloadStr}`,
  ];

  let matched = false;
  for (const candidate of candidates) {
    const hmac = createHmac("sha256", secret).update(candidate, "utf8").digest();
    for (const sigHex of signatures) {
      if (!/^[0-9a-fA-F]+$/.test(sigHex) || sigHex.length % 2 !== 0) continue;
      const sigBuf = Buffer.from(sigHex, "hex");
      if (sigBuf.length === hmac.length && timingSafeEqual(sigBuf, hmac)) {
        matched = true;
        break;
      }
    }
    if (matched) break;
  }

  if (!matched) {
    throw new Error("Signature mismatch");
  }

  return { valid: true, timestamp };
}

/**
 * Main CLI execution entry point.
 * Returns 0 on success, non-zero (1) on failure.
 */
export async function runCli(
  rawArgs: string[],
  context: CliContext = {},
): Promise<number> {
  const env = context.env ?? process.env;
  const stdout = context.stdout ?? ((msg: string) => process.stdout.write(msg + "\n"));
  const stderr = context.stderr ?? ((msg: string) => process.stderr.write(msg + "\n"));
  const readFile = context.readFile ?? ((path: string) => readFileSync(path, "utf8"));

  const apiKey = env.TALOS_API_KEY || env.TALOS_KEY || "";
  const knownSecrets = [apiKey].filter(Boolean);

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(rawArgs);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr(redactOutput(msg, knownSecrets));
    return 1;
  }

  const { command, options } = parsed;
  const isJson = Boolean(options.json);

  const printSuccess = (data: unknown, fallbackText?: string) => {
    if (isJson) {
      const redacted = redactObject(data, knownSecrets);
      stdout(JSON.stringify(redacted, null, 2));
    } else {
      const text = fallbackText ?? JSON.stringify(redactObject(data, knownSecrets), null, 2);
      stdout(redactOutput(text, knownSecrets));
    }
  };

  const printError = (message: string, code = 1): number => {
    if (isJson) {
      stdout(JSON.stringify({ error: redactOutput(message, knownSecrets) }, null, 2));
    } else {
      stderr(redactOutput(`Error: ${message}`, knownSecrets));
    }
    return code;
  };

  if (options.help || (command.length === 0 && !options.version)) {
    stdout(HELP_TEXT);
    return 0;
  }

  if (options.version) {
    stdout(`talos v${CLI_VERSION}`);
    return 0;
  }

  // Normalise command tokens: strip leading "talos" if passed, e.g. "talos get ..." -> ["get", ...]
  const tokens = [...command];
  if (tokens[0] === "talos") {
    tokens.shift();
  }

  const primary = tokens[0]?.toLowerCase();
  const secondary = tokens[1]?.toLowerCase();
  const targetId = tokens[2] ?? tokens[1];

  // Helper to get or build TalosClient
  const getClient = (): TalosClient => {
    if (context.client) return context.client;
    const baseUrl =
      options.baseUrl ||
      env.TALOS_API_URL ||
      env.TALOS_BASE_URL ||
      "http://localhost:3000";

    return new TalosClient({
      baseUrl,
      apiKey: apiKey || undefined,
    });
  };

  try {
    // 1. talos get <id> / get <id>
    if (primary === "get" || (primary === "talos" && secondary === "get") || primary === "inspect") {
      const id = primary === "get" ? tokens[1] : targetId;
      if (!id) {
        return printError("Missing required argument: <id>");
      }

      const client = getClient();
      const talos = id === "me" ? await client.getTalosMe() : await client.getTalos(id);

      const summaryText = [
        `Talos ID:    ${talos.id}`,
        `Name:        ${talos.agentName || talos.name || "N/A"}`,
        `Category:    ${talos.category || "N/A"}`,
        `Description: ${talos.description || "N/A"}`,
        `Wallet:      ${talos.walletPublicKey || "N/A"}`,
      ].join("\n");

      printSuccess(talos, summaryText);
      return 0;
    }

    // 2. talos check-name <name> / names check <name>
    if (
      (primary === "check-name" && tokens[1]) ||
      (primary === "names" && secondary === "check") ||
      (primary === "name" && secondary === "check")
    ) {
      const name = primary === "check-name" ? tokens[1] : tokens[2];
      if (!name) {
        return printError("Missing required argument: <name>");
      }

      const client = getClient();
      const result = await client.checkNameAvailability(name);

      const summaryText = result.available
        ? `Name "${name}" is available.`
        : `Name "${name}" is not available${result.reason ? `: ${result.reason}` : "."}`;

      printSuccess(result, summaryText);
      return 0;
    }

    // 3. services list
    if (
      (primary === "services" && (secondary === "list" || secondary === "ls" || !secondary)) ||
      (primary === "service" && (secondary === "list" || secondary === "ls"))
    ) {
      const client = getClient();
      const result = await client.discoverServices({
        category: options.category,
        limit: options.limit,
        cursor: options.cursor,
      });

      let summaryText = "";
      const items = result.data || [];
      if (items.length === 0) {
        summaryText = "No services found.";
      } else {
        summaryText = items
          .map((s, idx) => `${idx + 1}. ${s.serviceName} (${s.category || "Uncategorized"}) - ${s.price} USDC [Talos: ${s.talosId || "N/A"}]`)
          .join("\n");
      }

      printSuccess(result, summaryText);
      return 0;
    }

    // 4. jobs get <id>
    if (
      (primary === "jobs" && (secondary === "get" || secondary === "inspect")) ||
      (primary === "job" && (secondary === "get" || secondary === "inspect"))
    ) {
      const id = tokens[2];
      if (!id) {
        return printError("Missing required argument: <id>");
      }

      const client = getClient();
      const job = await client.getJobResult(id);

      const summaryText = [
        `Job ID:     ${job.id}`,
        `Talos ID:   ${job.talosId}`,
        `Status:     ${job.status || "N/A"}`,
        `Result:     ${typeof job.result === "object" ? JSON.stringify(job.result) : (job.result ?? "N/A")}`,
      ].join("\n");

      printSuccess(job, summaryText);
      return 0;
    }

    // 5. webhooks verify --secret-env VAR --file payload.json
    if (
      (primary === "webhooks" && secondary === "verify") ||
      (primary === "webhook" && secondary === "verify")
    ) {
      const secretEnvVar = options.secretEnv;
      if (!secretEnvVar) {
        return printError("Missing required option: --secret-env <VAR>");
      }

      const webhookSecret = env[secretEnvVar];
      if (!webhookSecret) {
        return printError(`Environment variable "${secretEnvVar}" is not set or empty`);
      }
      knownSecrets.push(webhookSecret);

      const filePath = options.file;
      if (!filePath) {
        return printError("Missing required option: --file <path>");
      }

      let fileContent: string;
      try {
        fileContent = readFile(filePath);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return printError(`Failed to read file "${filePath}": ${msg}`);
      }

      let payloadStr = fileContent;
      let signatureHeader = options.signature;

      // If signature is not explicitly provided, check if the file is a JSON envelope
      if (!signatureHeader) {
        try {
          const parsedJson = JSON.parse(fileContent);
          if (parsedJson && typeof parsedJson === "object") {
            if (typeof parsedJson.signatureHeader === "string") {
              signatureHeader = parsedJson.signatureHeader;
            } else if (typeof parsedJson.signature === "string") {
              signatureHeader = parsedJson.signature;
            } else if (parsedJson.headers && typeof parsedJson.headers === "object") {
              signatureHeader =
                parsedJson.headers["talos-signature"] ||
                parsedJson.headers["Talos-Signature"] ||
                parsedJson.headers["x-talos-signature"];
            }

            // If the envelope separates payload / body from headers
            if (signatureHeader && parsedJson.payload !== undefined) {
              payloadStr = typeof parsedJson.payload === "string" ? parsedJson.payload : JSON.stringify(parsedJson.payload);
            } else if (signatureHeader && parsedJson.body !== undefined) {
              payloadStr = typeof parsedJson.body === "string" ? parsedJson.body : JSON.stringify(parsedJson.body);
            }
          }
        } catch {
          // File is raw payload string; signature must be in --signature
        }
      }

      if (!signatureHeader) {
        return printError("Webhook signature header not found (specify with --signature or provide in envelope file)");
      }

      try {
        const res = verifyWebhookSignature(payloadStr, signatureHeader, webhookSecret);
        printSuccess(res, `Webhook signature verified successfully (timestamp: ${res.timestamp}).`);
        return 0;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return printError(`Webhook verification failed: ${msg}`);
      }
    }

    return printError(`Unknown command: "${command.join(" ")}". Run "talos --help" for available commands.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return printError(msg);
  }
}
