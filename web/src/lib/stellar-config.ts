import { Networks, StrKey } from "@stellar/stellar-sdk";

const isProd = process.env.NODE_ENV === "production";
const isClient = typeof window !== "undefined";
const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";

// ── Asset issuer / network validation ────────────────────────────────────────

export type StellarNetworkName = "testnet" | "mainnet";

export const STELLAR_NETWORKS: readonly StellarNetworkName[] = ["testnet", "mainnet"];

/** Circle-issued USDC on each Stellar network. */
export const CANONICAL_USDC_ISSUERS: Readonly<Record<StellarNetworkName, string>> = {
  testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

const NETWORK_PASSPHRASES: Readonly<Record<StellarNetworkName, string>> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

/**
 * The subset of environment variables that decide which network and USDC
 * issuer the app talks to. Kept as an explicit shape (rather than reading
 * `process.env` dynamically) so Next.js can inline the `NEXT_PUBLIC_*` values
 * into the client bundle.
 */
export type StellarAssetEnv = {
  NEXT_PUBLIC_STELLAR_NETWORK?: string;
  STELLAR_NETWORK?: string;
  NEXT_PUBLIC_STELLAR_USDC_ISSUER?: string;
  STELLAR_USDC_ISSUER?: string;
  NEXT_PUBLIC_STELLAR_ALLOW_CUSTOM_USDC_ISSUER?: string;
  STELLAR_ALLOW_CUSTOM_USDC_ISSUER?: string;
};

export type StellarAssetConfigIssueCode =
  | "invalid_network"
  | "network_conflict"
  | "invalid_issuer"
  | "issuer_conflict"
  | "issuer_network_mismatch"
  | "unrecognized_mainnet_issuer";

export type StellarAssetConfigIssue = {
  code: StellarAssetConfigIssueCode;
  /** Env var names involved. Values are never echoed back verbatim. */
  variables: string[];
  message: string;
};

export type StellarAssetConfig = {
  network: StellarNetworkName;
  networkPassphrase: string;
  usdcIssuer: string;
  /** True when the issuer is not the canonical Circle issuer for the network. */
  customIssuer: boolean;
};

export type StellarAssetConfigResult =
  | { ok: true; config: StellarAssetConfig }
  | { ok: false; issues: StellarAssetConfigIssue[] };

/** Treat unset, empty and whitespace-only values the same way. */
function readVar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Short, non-reversible preview of a value for error messages. */
function preview(value: string): string {
  if (value.length <= 8) return `<${value.length} chars>`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function isNetworkName(value: string): value is StellarNetworkName {
  return (STELLAR_NETWORKS as readonly string[]).includes(value);
}

/**
 * Validate the configured Stellar network and USDC issuer as a pair.
 *
 * Rules:
 * - Network values must be exactly `testnet` or `mainnet`. Other modules
 *   compare the raw string, so a near-miss like `Mainnet` or `public` would
 *   silently fall back to testnet elsewhere.
 * - `NEXT_PUBLIC_STELLAR_NETWORK` and `STELLAR_NETWORK` must agree when both
 *   are set; server and browser would otherwise sign for different networks.
 * - The issuer must be a valid Stellar account ID (G…), and the public and
 *   server issuer variables must agree when both are set.
 * - The issuer must not be the canonical USDC issuer of the *other* network.
 * - On mainnet, a non-Circle issuer requires an explicit opt-in via
 *   `STELLAR_ALLOW_CUSTOM_USDC_ISSUER=true` (or the `NEXT_PUBLIC_` variant).
 *
 * Unset values keep their historical defaults: `testnet` and the canonical
 * issuer for the resolved network.
 */
export function validateStellarAssetConfig(env: StellarAssetEnv): StellarAssetConfigResult {
  const issues: StellarAssetConfigIssue[] = [];

  const publicNetwork = readVar(env.NEXT_PUBLIC_STELLAR_NETWORK);
  const serverNetwork = readVar(env.STELLAR_NETWORK);

  for (const [name, value] of [
    ["NEXT_PUBLIC_STELLAR_NETWORK", publicNetwork],
    ["STELLAR_NETWORK", serverNetwork],
  ] as const) {
    if (value !== undefined && !isNetworkName(value)) {
      issues.push({
        code: "invalid_network",
        variables: [name],
        message: `${name} must be one of: ${STELLAR_NETWORKS.join(", ")}.`,
      });
    }
  }

  if (
    publicNetwork !== undefined &&
    serverNetwork !== undefined &&
    isNetworkName(publicNetwork) &&
    isNetworkName(serverNetwork) &&
    publicNetwork !== serverNetwork
  ) {
    issues.push({
      code: "network_conflict",
      variables: ["NEXT_PUBLIC_STELLAR_NETWORK", "STELLAR_NETWORK"],
      message: `NEXT_PUBLIC_STELLAR_NETWORK (${publicNetwork}) and STELLAR_NETWORK (${serverNetwork}) must match.`,
    });
  }

  const rawNetwork = publicNetwork ?? serverNetwork ?? "testnet";
  // Without a valid network the issuer pairing cannot be checked meaningfully.
  if (!isNetworkName(rawNetwork)) return { ok: false, issues };
  const network: StellarNetworkName = rawNetwork;
  const otherNetwork: StellarNetworkName = network === "mainnet" ? "testnet" : "mainnet";

  const publicIssuer = readVar(env.NEXT_PUBLIC_STELLAR_USDC_ISSUER);
  const serverIssuer = readVar(env.STELLAR_USDC_ISSUER);
  const issuerVar =
    publicIssuer !== undefined ? "NEXT_PUBLIC_STELLAR_USDC_ISSUER" : "STELLAR_USDC_ISSUER";

  for (const [name, value] of [
    ["NEXT_PUBLIC_STELLAR_USDC_ISSUER", publicIssuer],
    ["STELLAR_USDC_ISSUER", serverIssuer],
  ] as const) {
    if (value !== undefined && !StrKey.isValidEd25519PublicKey(value)) {
      issues.push({
        code: "invalid_issuer",
        variables: [name],
        message: `${name} must be a valid Stellar account ID (G…, 56 chars); got ${preview(value)}.`,
      });
    }
  }

  if (publicIssuer !== undefined && serverIssuer !== undefined && publicIssuer !== serverIssuer) {
    issues.push({
      code: "issuer_conflict",
      variables: ["NEXT_PUBLIC_STELLAR_USDC_ISSUER", "STELLAR_USDC_ISSUER"],
      message:
        "NEXT_PUBLIC_STELLAR_USDC_ISSUER and STELLAR_USDC_ISSUER must match when both are set.",
    });
  }

  const usdcIssuer = publicIssuer ?? serverIssuer ?? CANONICAL_USDC_ISSUERS[network];
  const customIssuer = usdcIssuer !== CANONICAL_USDC_ISSUERS[network];

  if (usdcIssuer === CANONICAL_USDC_ISSUERS[otherNetwork]) {
    issues.push({
      code: "issuer_network_mismatch",
      variables: [issuerVar, publicNetwork !== undefined ? "NEXT_PUBLIC_STELLAR_NETWORK" : "STELLAR_NETWORK"],
      message: `${issuerVar} is the ${otherNetwork} USDC issuer but the configured network is ${network}.`,
    });
  } else if (
    network === "mainnet" &&
    customIssuer &&
    StrKey.isValidEd25519PublicKey(usdcIssuer) &&
    readVar(env.STELLAR_ALLOW_CUSTOM_USDC_ISSUER) !== "true" &&
    readVar(env.NEXT_PUBLIC_STELLAR_ALLOW_CUSTOM_USDC_ISSUER) !== "true"
  ) {
    issues.push({
      code: "unrecognized_mainnet_issuer",
      variables: [issuerVar],
      message:
        `${issuerVar} (${preview(usdcIssuer)}) is not the Circle USDC issuer for mainnet. ` +
        "Set STELLAR_ALLOW_CUSTOM_USDC_ISSUER=true to opt in to a custom issuer.",
    });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    config: {
      network,
      networkPassphrase: NETWORK_PASSPHRASES[network],
      usdcIssuer,
      customIssuer,
    },
  };
}

export class StellarConfigError extends Error {
  readonly issues: StellarAssetConfigIssue[];

  constructor(issues: StellarAssetConfigIssue[]) {
    super(
      "Invalid Stellar asset configuration:\n" +
        issues.map((issue) => `  - [${issue.code}] ${issue.message}`).join("\n"),
    );
    this.name = "StellarConfigError";
    this.issues = issues;
  }
}

/** Validate and return the config, throwing a StellarConfigError on failure. */
export function resolveStellarAssetConfig(env: StellarAssetEnv): StellarAssetConfig {
  const result = validateStellarAssetConfig(env);
  if (!result.ok) throw new StellarConfigError(result.issues);
  return result.config;
}

// Literal `process.env.X` reads so Next.js inlines NEXT_PUBLIC_* on the client.
const stellarAssetConfig = resolveStellarAssetConfig({
  NEXT_PUBLIC_STELLAR_NETWORK: process.env.NEXT_PUBLIC_STELLAR_NETWORK,
  STELLAR_NETWORK: process.env.STELLAR_NETWORK,
  NEXT_PUBLIC_STELLAR_USDC_ISSUER: process.env.NEXT_PUBLIC_STELLAR_USDC_ISSUER,
  STELLAR_USDC_ISSUER: process.env.STELLAR_USDC_ISSUER,
  NEXT_PUBLIC_STELLAR_ALLOW_CUSTOM_USDC_ISSUER:
    process.env.NEXT_PUBLIC_STELLAR_ALLOW_CUSTOM_USDC_ISSUER,
  STELLAR_ALLOW_CUSTOM_USDC_ISSUER: process.env.STELLAR_ALLOW_CUSTOM_USDC_ISSUER,
});

export const STELLAR_NETWORK: StellarNetworkName = stellarAssetConfig.network;
export const STELLAR_NETWORK_PASSPHRASE: string = stellarAssetConfig.networkPassphrase;
export const USDC_ISSUER: string = stellarAssetConfig.usdcIssuer;

// ── Operator key ─────────────────────────────────────────────────────────────

export const OPERATOR_PUBLIC_KEY = isClient
  ? (process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY || "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL")
  : (process.env.STELLAR_OPERATOR_PUBLIC_KEY ||
     process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY ||
     "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL");

// Throw at module load if a required env var is missing in production
if (isProd && !isNextBuild) {
  if (isClient) {
    if (!process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY) {
      throw new Error("Missing NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY in production client environment");
    }
  } else {
    if (!process.env.STELLAR_OPERATOR_PUBLIC_KEY && !process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY) {
      throw new Error("Missing STELLAR_OPERATOR_PUBLIC_KEY or NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY in production server environment");
    }
  }
}
