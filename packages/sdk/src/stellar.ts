import { Keypair, StrKey, Networks } from "@stellar/stellar-sdk";

/**
 * Generates a new random Stellar keypair.
 */
export function generateKeypair() {
  const kp = Keypair.random();
  return {
    publicKey: kp.publicKey(),
    secret: kp.secret(),
  };
}

/**
 * Validates if a string is a valid Stellar public key (G...).
 */
export function isValidPublicKey(publicKey: string): boolean {
  return StrKey.isValidEd25519PublicKey(publicKey);
}

/**
 * Validates if a string is a valid Stellar secret key (S...).
 */
export function isValidSecretKey(secret: string): boolean {
  return StrKey.isValidEd25519SecretSeed(secret);
}

// ── Network / passphrase validation ───────────────────────────────────

/**
 * Canonical Stellar network ids understood by the Talos SDK client.
 * `mainnet` / `pubnet` / `stellar:<id>` aliases normalize to these values.
 */
export type TalosNetworkId = "public" | "testnet" | "futurenet" | "standalone";

/** Well-known Stellar network passphrases keyed by {@link TalosNetworkId}. */
export const NETWORK_PASSPHRASES: Readonly<Record<TalosNetworkId, string>> =
  Object.freeze({
    public: Networks.PUBLIC,
    testnet: Networks.TESTNET,
    futurenet: Networks.FUTURENET,
    standalone: Networks.STANDALONE,
  });

/** Frozen snapshot of a validated client network configuration. */
export type ResolvedNetworkConfig = Readonly<{
  network: TalosNetworkId;
  networkPassphrase: string;
}>;

const NETWORK_ALIASES: Readonly<Record<string, TalosNetworkId>> = Object.freeze({
  public: "public",
  pubnet: "public",
  mainnet: "public",
  testnet: "testnet",
  futurenet: "futurenet",
  standalone: "standalone",
});

const PASSPHRASE_TO_NETWORK: ReadonlyMap<string, TalosNetworkId> = new Map(
  (Object.entries(NETWORK_PASSPHRASES) as [TalosNetworkId, string][]).map(
    ([id, passphrase]) => [passphrase, id],
  ),
);

/**
 * Normalize a network id or x402-style `stellar:<id>` label to a canonical
 * {@link TalosNetworkId}. Rejects empty / unknown values with privacy-safe
 * errors (the raw input is never echoed).
 */
export function normalizeNetworkId(raw: string): TalosNetworkId {
  if (typeof raw !== "string") {
    throw new TypeError("network must be a string");
  }
  let cleaned = raw.trim().toLowerCase();
  if (cleaned === "") {
    throw new RangeError("network must be a non-empty string");
  }
  if (cleaned.startsWith("stellar:")) {
    cleaned = cleaned.slice("stellar:".length).trim();
  }
  const id = NETWORK_ALIASES[cleaned];
  if (!id) {
    throw new RangeError(
      "network must be one of: public, testnet, futurenet, standalone",
    );
  }
  return id;
}

/**
 * Resolve a network id from a known Stellar passphrase, or `undefined` when
 * the passphrase is not one of the well-known constants.
 */
export function networkIdFromPassphrase(
  passphrase: string,
): TalosNetworkId | undefined {
  if (typeof passphrase !== "string") return undefined;
  return PASSPHRASE_TO_NETWORK.get(passphrase);
}

/** True when `passphrase` exactly matches a well-known Stellar network. */
export function isKnownNetworkPassphrase(passphrase: string): boolean {
  return networkIdFromPassphrase(passphrase) !== undefined;
}

/**
 * Validate and normalize optional `network` / `networkPassphrase` client
 * options.
 *
 * - Both omitted → `undefined` (backward compatible; no network binding).
 * - Only `network` → fills passphrase from {@link NETWORK_PASSPHRASES}.
 * - Only `networkPassphrase` → resolves network from well-known constants.
 * - Both provided → must agree; mismatch fails fast.
 *
 * Malformed / unknown / mismatched inputs throw `TypeError` or `RangeError`
 * with privacy-safe messages (no secrets, seeds, or raw payloads).
 */
export function resolveNetworkConfig(
  options:
    | { network?: string; networkPassphrase?: string }
    | null
    | undefined = undefined,
): ResolvedNetworkConfig | undefined {
  if (options === undefined || options === null) {
    return undefined;
  }
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("network config must be an object when provided");
  }

  const hasNetwork = options.network !== undefined;
  const hasPassphrase = options.networkPassphrase !== undefined;
  if (!hasNetwork && !hasPassphrase) {
    return undefined;
  }

  let network: TalosNetworkId | undefined;

  if (hasNetwork) {
    if (typeof options.network !== "string") {
      throw new TypeError("network must be a string");
    }
    network = normalizeNetworkId(options.network);
  }

  if (hasPassphrase) {
    if (typeof options.networkPassphrase !== "string") {
      throw new TypeError("networkPassphrase must be a string");
    }
    if (options.networkPassphrase.trim() === "") {
      throw new RangeError("networkPassphrase must be a non-empty string");
    }
    const provided = options.networkPassphrase;
    const fromPassphrase = networkIdFromPassphrase(provided);
    if (network !== undefined) {
      if (provided !== NETWORK_PASSPHRASES[network]) {
        throw new RangeError("networkPassphrase does not match network");
      }
    } else {
      if (!fromPassphrase) {
        throw new RangeError(
          "networkPassphrase is not a recognized Stellar network passphrase",
        );
      }
      network = fromPassphrase;
    }
  }

  // `network` is always set when we reach here (one of the branches above).
  const resolved = network!;
  return Object.freeze({
    network: resolved,
    networkPassphrase: NETWORK_PASSPHRASES[resolved],
  });
}
