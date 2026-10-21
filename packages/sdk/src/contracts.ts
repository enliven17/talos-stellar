/**
 * Typed read clients for Talos Soroban contracts.
 *
 * Provides {@link RegistryReader} and {@link NameServiceReader} for calling
 * read-only contract methods via Soroban RPC `simulateTransaction` without
 * requiring a wallet or signing key.
 *
 * Default contract IDs and RPC URL are the Stellar **testnet** deployments.
 * Pass explicit `contractId` and/or `rpcUrl` options to target a different
 * network or contract instance.
 *
 * ## Quick start
 *
 * ```ts
 * import { RegistryReader, NameServiceReader } from "@talos-protocol/sdk";
 *
 * const registry = new RegistryReader();
 * const talos = await registry.getTalos(1);
 *
 * const ns = new NameServiceReader();
 * const id = await ns.resolveName("vega");
 * ```
 *
 * @module contracts
 */

import {
  rpc,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
  TransactionBuilder,
  Account,
  BASE_FEE,
  Keypair,
} from "@stellar/stellar-sdk";
import {
  TalosContractError,
  TalosContractNotFoundError,
  TalosContractSimulateError,
} from "./errors.js";

// ── Network constants ──────────────────────────────────────────────────────

/** Testnet RPC endpoint (default). */
export const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";

/** Testnet `TalosRegistry` contract ID. */
export const TESTNET_REGISTRY_CONTRACT_ID =
  "CAMLL62EVCRV5CEHBO34MHUAHI5FJE5XFVAU57VZEAVY2EE5Q36FVHUX";

/** Testnet `TalosNameService` contract ID. */
export const TESTNET_NAME_SERVICE_CONTRACT_ID =
  "CAP32WBDUMF4UOXLSCHQDM3MDKS4WNQUQAB4WMAGUXTXJNQ4OWD3CQXF";

/** Stellar testnet network passphrase. */
export const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// ── Domain types ───────────────────────────────────────────────────────────

/** On-chain Patron share and address configuration. */
export interface ContractPatron {
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
  creatorAddr: string;
  investorAddr: string;
  treasuryAddr: string;
}

/** On-chain Kernel configuration for a Talos. */
export interface ContractKernel {
  approvalThreshold: bigint;
  gtmBudget: bigint;
  minPatronPulse: bigint;
}

/** On-chain Pulse (token) metadata for a Talos. */
export interface ContractPulse {
  totalSupply: bigint;
  priceUsdCents: bigint;
  tokenSymbol: string;
}

/**
 * Decoded on-chain Talos record as returned by the Registry contract's
 * `get_talos` entry-point.
 */
export interface OnChainTalos {
  id: number;
  name: string;
  category: string;
  description: string;
  creator: string;
  patron: ContractPatron;
  kernel: ContractKernel;
  pulse: ContractPulse;
  createdAt: bigint;
  active: boolean;
}

/** SemVer triple returned by the `version()` entry-point. */
export interface ContractVersion {
  major: number;
  minor: number;
  patch: number;
}

// ── Options ────────────────────────────────────────────────────────────────

/** Shared options accepted by both contract readers. */
export interface ContractReaderOptions {
  /**
   * Soroban RPC endpoint URL.
   * Defaults to {@link TESTNET_RPC_URL}.
   */
  rpcUrl?: string;
  /**
   * Stellar network passphrase.
   * Defaults to {@link TESTNET_NETWORK_PASSPHRASE}.
   */
  networkPassphrase?: string;
}

/** Options for {@link RegistryReader}. */
export interface RegistryReaderOptions extends ContractReaderOptions {
  /**
   * `TalosRegistry` contract ID.
   * Defaults to {@link TESTNET_REGISTRY_CONTRACT_ID}.
   */
  contractId?: string;
}

/** Options for {@link NameServiceReader}. */
export interface NameServiceReaderOptions extends ContractReaderOptions {
  /**
   * `TalosNameService` contract ID.
   * Defaults to {@link TESTNET_NAME_SERVICE_CONTRACT_ID}.
   */
  contractId?: string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

/** Lazily-created dummy public key for simulation source accounts. */
let _dummyPublicKey: string | null = null;

function _getDummyPublicKey(): string {
  if (!_dummyPublicKey) {
    _dummyPublicKey = Keypair.random().publicKey();
  }
  return _dummyPublicKey;
}

/**
 * Build a minimal unsigned transaction wrapping a single Soroban `operation`
 * suitable for `simulateTransaction` (no signing key required).
 */
function _buildSimTx(
  operation: xdr.Operation,
  networkPassphrase: string,
): ReturnType<TransactionBuilder["build"]> {
  const source = new Account(_getDummyPublicKey(), "0");
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();
}

/**
 * Run `simulateTransaction` and extract the decoded native return value.
 *
 * @throws {TalosContractSimulateError} if the simulation returns an RPC-level
 *   or contract-level error.
 */
async function _simulate(
  server: rpc.Server,
  tx: ReturnType<typeof _buildSimTx>,
  label: string,
): Promise<unknown> {
  const result = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(result)) {
    throw new TalosContractSimulateError(
      `simulateTransaction failed for ${label}: ${result.error}`,
      { cause: result },
    );
  }

  // A successful simulation always has a `result` with `retval`.
  const simSuccess = result as rpc.Api.SimulateTransactionSuccessResponse;
  if (!simSuccess.result) {
    throw new TalosContractSimulateError(
      `simulateTransaction returned no result for ${label}`,
      { cause: result },
    );
  }

  return scValToNative(simSuccess.result.retval);
}

// ── ScVal decoding helpers ─────────────────────────────────────────────────

/** Decode a Soroban `Option<T>` (a `Vec` with 0 or 1 element, or void/null). */
function _decodeOption<T>(
  raw: unknown,
  decoder: (v: unknown) => T,
): T | null {
  // scValToNative maps Option::None → undefined/null and Option::Some(x) → x
  if (raw === null || raw === undefined) return null;
  return decoder(raw);
}

/**
 * Decode a raw `scValToNative` result for a `Talos` struct into
 * {@link OnChainTalos}.
 */
function _decodeTalos(raw: unknown): OnChainTalos {
  // scValToNative converts Soroban maps to plain JS objects with camelCase keys
  const r = raw as Record<string, unknown>;

  const patron = r["patron"] as Record<string, unknown>;
  const kernel = r["kernel"] as Record<string, unknown>;
  const pulse = r["pulse"] as Record<string, unknown>;

  return {
    id: Number(r["id"]),
    name: String(r["name"]),
    category: String(r["category"]),
    description: String(r["description"]),
    creator: String(r["creator"]),
    patron: {
      creatorShare: Number(patron["creator_share"] ?? patron["creatorShare"]),
      investorShare: Number(patron["investor_share"] ?? patron["investorShare"]),
      treasuryShare: Number(patron["treasury_share"] ?? patron["treasuryShare"]),
      creatorAddr: String(patron["creator_addr"] ?? patron["creatorAddr"]),
      investorAddr: String(patron["investor_addr"] ?? patron["investorAddr"]),
      treasuryAddr: String(patron["treasury_addr"] ?? patron["treasuryAddr"]),
    },
    kernel: {
      approvalThreshold: BigInt(
        (kernel["approval_threshold"] ?? kernel["approvalThreshold"]) as bigint,
      ),
      gtmBudget: BigInt(
        (kernel["gtm_budget"] ?? kernel["gtmBudget"]) as bigint,
      ),
      minPatronPulse: BigInt(
        (kernel["min_patron_pulse"] ?? kernel["minPatronPulse"]) as bigint,
      ),
    },
    pulse: {
      totalSupply: BigInt(
        (pulse["total_supply"] ?? pulse["totalSupply"]) as bigint,
      ),
      priceUsdCents: BigInt(
        (pulse["price_usd_cents"] ?? pulse["priceUsdCents"]) as bigint,
      ),
      tokenSymbol: String(pulse["token_symbol"] ?? pulse["tokenSymbol"]),
    },
    createdAt: BigInt((r["created_at"] ?? r["createdAt"]) as bigint),
    active: Boolean(r["active"]),
  };
}

/**
 * Decode a `version()` tuple `(u32, u32, u32)` into {@link ContractVersion}.
 * scValToNative maps a Soroban tuple to a JS array.
 */
function _decodeVersion(raw: unknown): ContractVersion {
  const arr = raw as [number, number, number];
  return { major: Number(arr[0]), minor: Number(arr[1]), patch: Number(arr[2]) };
}

// ── RegistryReader ─────────────────────────────────────────────────────────

/**
 * Read-only client for the `TalosRegistry` Soroban contract.
 *
 * All methods use `simulateTransaction` — no wallet or signing key is needed.
 * Contract errors (e.g. Talos not found) are surfaced as typed SDK errors.
 *
 * @example
 * ```ts
 * const registry = new RegistryReader();
 * const talos = await registry.getTalos(1);
 * if (talos) console.log(talos.name);
 * ```
 */
export class RegistryReader {
  private readonly _server: rpc.Server;
  private readonly _contract: Contract;
  private readonly _networkPassphrase: string;

  constructor(options: RegistryReaderOptions = {}) {
    const rpcUrl = options.rpcUrl ?? TESTNET_RPC_URL;
    const contractId = options.contractId ?? TESTNET_REGISTRY_CONTRACT_ID;
    this._networkPassphrase =
      options.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;

    this._server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this._contract = new Contract(contractId);
  }

  /**
   * Retrieve the full on-chain record for a Talos by its numeric ID.
   *
   * @returns The decoded {@link OnChainTalos} or `null` if not found.
   */
  async getTalos(talosId: number): Promise<OnChainTalos | null> {
    const op = this._contract.call(
      "get_talos",
      nativeToScVal(talosId, { type: "u32" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `get_talos(${talosId})`);
    return _decodeOption(raw, _decodeTalos);
  }

  /**
   * Retrieve the creator `Address` (G… public key) of a Talos.
   *
   * @returns The Stellar public key string or `null` if the Talos does not exist.
   */
  async creatorOf(talosId: number): Promise<string | null> {
    const op = this._contract.call(
      "creator_of",
      nativeToScVal(talosId, { type: "u32" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `creator_of(${talosId})`);
    return _decodeOption(raw, (v) => String(v));
  }

  /**
   * Check whether a Talos is currently active on-chain.
   *
   * @returns `true` if active, `false` if inactive or not found.
   */
  async isActive(talosId: number): Promise<boolean> {
    const op = this._contract.call(
      "is_active",
      nativeToScVal(talosId, { type: "u32" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `is_active(${talosId})`);
    return Boolean(raw);
  }

  /**
   * Query the deployed WASM version of the Registry contract.
   *
   * @returns A {@link ContractVersion} with `major`, `minor`, and `patch`.
   */
  async version(): Promise<ContractVersion> {
    const op = this._contract.call("version");
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, "version()");
    return _decodeVersion(raw);
  }

  /**
   * Get the next Talos ID that will be assigned on the next `create_talos` call.
   * Useful for estimating how many Talos instances exist.
   *
   * @returns The next available Talos ID (1-based counter).
   */
  async nextTalosId(): Promise<number> {
    const op = this._contract.call("next_talos_id");
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, "next_talos_id()");
    return Number(raw);
  }
}

// ── NameServiceReader ──────────────────────────────────────────────────────

/**
 * Read-only client for the `TalosNameService` Soroban contract.
 *
 * All methods use `simulateTransaction` — no wallet or signing key is needed.
 *
 * @example
 * ```ts
 * const ns = new NameServiceReader();
 * const talosId = await ns.resolveName("vega");
 * if (talosId) console.log("Talos ID:", talosId);
 * ```
 */
export class NameServiceReader {
  private readonly _server: rpc.Server;
  private readonly _contract: Contract;
  private readonly _networkPassphrase: string;

  constructor(options: NameServiceReaderOptions = {}) {
    const rpcUrl = options.rpcUrl ?? TESTNET_RPC_URL;
    const contractId = options.contractId ?? TESTNET_NAME_SERVICE_CONTRACT_ID;
    this._networkPassphrase =
      options.networkPassphrase ?? TESTNET_NETWORK_PASSPHRASE;

    this._server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    this._contract = new Contract(contractId);
  }

  /**
   * Resolve a human-readable name to its on-chain Talos ID.
   *
   * @param name - The registered name (e.g. `"vega"`, `"marketbot"`).
   * @returns The numeric Talos ID or `null` if the name is not registered.
   */
  async resolveName(name: string): Promise<number | null> {
    const op = this._contract.call(
      "resolve_name",
      nativeToScVal(name, { type: "string" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `resolve_name(${name})`);
    return _decodeOption(raw, (v) => Number(v));
  }

  /**
   * Look up the registered name for a given Talos ID.
   *
   * @param talosId - The numeric on-chain Talos ID.
   * @returns The registered name string or `null` if the Talos has no name.
   */
  async nameOf(talosId: number): Promise<string | null> {
    const op = this._contract.call(
      "name_of",
      nativeToScVal(talosId, { type: "u32" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `name_of(${talosId})`);
    return _decodeOption(raw, (v) => String(v));
  }

  /**
   * Check whether a name is available for registration.
   *
   * Returns `false` for names that are already taken **or** that fail the
   * contract's validation rules (3–32 chars, lowercase alphanumeric + hyphens,
   * no consecutive hyphens).
   *
   * @param name - The name to check.
   * @returns `true` if the name can be registered.
   */
  async isNameAvailable(name: string): Promise<boolean> {
    const op = this._contract.call(
      "is_name_available",
      nativeToScVal(name, { type: "string" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `is_name_available(${name})`);
    return Boolean(raw);
  }

  /**
   * Check whether a Talos ID has a registered name.
   *
   * @param talosId - The numeric on-chain Talos ID.
   * @returns `true` if a name is registered for this Talos.
   */
  async hasName(talosId: number): Promise<boolean> {
    const op = this._contract.call(
      "has_name",
      nativeToScVal(talosId, { type: "u32" }),
    );
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, `has_name(${talosId})`);
    return Boolean(raw);
  }

  /**
   * Query the deployed WASM version of the NameService contract.
   *
   * @returns A {@link ContractVersion} with `major`, `minor`, and `patch`.
   */
  async version(): Promise<ContractVersion> {
    const op = this._contract.call("version");
    const tx = _buildSimTx(op, this._networkPassphrase);
    const raw = await _simulate(this._server, tx, "version()");
    return _decodeVersion(raw);
  }
}
