/**
 * Soroban contract interaction — replaces contracts.ts (Hedera/ethers).
 *
 * Handles TalosRegistry and TalosNameService on Stellar Soroban.
 * Read-only calls use Soroban RPC directly.
 * Write calls (create TALOS, register name) go through the user's wallet via WalletKit.
 */

// NEXT_PUBLIC_ prefix required — soroban.ts is imported by client components (launch/page.tsx)
const STELLAR_NETWORK =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? process.env.STELLAR_NETWORK ?? "testnet";
const STELLAR_SOROBAN_RPC =
  process.env.NEXT_PUBLIC_STELLAR_RPC_URL ??
  process.env.STELLAR_RPC_URL ??
  "https://soroban-testnet.stellar.org";

export const TALOS_REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT ?? "";



// Dummy keypair used as source account for read-only Soroban simulations.
// Keypair.random() guarantees a valid Ed25519 public key that always satisfies
// the SDK's key-format checks, unlike any hardcoded string which would be
// rejected by stricter validation. No signing key is required for read-only calls.
let DUMMY_ACCOUNT_PUBLIC: string | null = null;

async function getDummyAccountPublicKey(): Promise<string> {
  if (!DUMMY_ACCOUNT_PUBLIC) {
    const { Keypair } = await import("@stellar/stellar-sdk");
    DUMMY_ACCOUNT_PUBLIC = Keypair.random().publicKey();
  }
  return DUMMY_ACCOUNT_PUBLIC;
}
export const TALOS_NAME_SERVICE_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT ?? "";

export const TALOS_DIVIDENDS_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_DIVIDENDS_CONTRACT ?? "";

export const STELLAR_TESTNET = {
  networkPassphrase: "Test SDF Network ; September 2015",
  sorobanRpc: "https://soroban-testnet.stellar.org",
  horizonUrl: "https://horizon-testnet.stellar.org",
};

export const STELLAR_MAINNET = {
  networkPassphrase: "Public Global Stellar Network ; September 2015",
  sorobanRpc: "https://soroban-rpc.stellar.org",
  horizonUrl: "https://horizon.stellar.org",
};

export function getNetwork() {
  return STELLAR_NETWORK === "mainnet" ? STELLAR_MAINNET : STELLAR_TESTNET;
}

/**
 * Get a Soroban RPC client for read-only queries.
 */
export async function getSorobanClient() {
  const { rpc } = await import("@stellar/stellar-sdk");
  return new rpc.Server(STELLAR_SOROBAN_RPC);
}

export interface DividendEpoch {
  epochId: bigint;
  talosId: number;
  totalAmount: bigint;
  claimedAmount: bigint;
  createdAt: bigint;
  expirySecs: bigint;
}

export interface TalosPatronDetails {
  creatorAddress: string;
  investorAddress: string;
  treasuryAddress: string;
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
}

function requireDividendsContractId(): string {
  if (!TALOS_DIVIDENDS_CONTRACT_ID) {
    throw new Error("Dividend claims are not configured for this network.");
  }
  return TALOS_DIVIDENDS_CONTRACT_ID;
}

function requireRegistryContractId(): string {
  if (!TALOS_REGISTRY_CONTRACT_ID) {
    throw new Error("The Talos registry contract is not configured for this network.");
  }
  return TALOS_REGISTRY_CONTRACT_ID;
}

function toBigInt(value: unknown, field: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`Invalid ${field} returned by the dividends contract.`);
}

function readEpochField(record: unknown, field: string): unknown {
  if (record instanceof Map) return record.get(field);
  if (typeof record === "object" && record !== null) {
    return (record as Record<string, unknown>)[field];
  }
  throw new Error("Invalid contract record data.");
}

async function readContract(
  contractId: string,
  method: string,
  args: import("@stellar/stellar-sdk").xdr.ScVal[],
): Promise<unknown> {
  const { Contract, scValToNative } = await import("@stellar/stellar-sdk");
  const server = await getSorobanClient();
  const contract = new Contract(contractId);
  const result = await server.simulateTransaction(
    await buildReadOnlyTx(contract.call(method, ...args)),
  );

  if ("error" in result) {
    throw new Error(`Dividends contract read failed: ${result.error}`);
  }
  return scValToNative(
    (result as { result: { retval: import("@stellar/stellar-sdk").xdr.ScVal } })
      .result.retval,
  );
}

async function readDividendsContract(
  method: string,
  args: import("@stellar/stellar-sdk").xdr.ScVal[],
): Promise<unknown> {
  return readContract(requireDividendsContractId(), method, args);
}

/** Read the canonical role addresses and share percentages from TalosRegistry. */
export async function getTalosPatron(
  talosId: number,
): Promise<TalosPatronDetails | null> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const talos = await readContract(requireRegistryContractId(), "get_talos", [
    nativeToScVal(talosId, { type: "u32" }),
  ]);
  if (talos === null || talos === undefined) return null;

  const patron = readEpochField(talos, "patron");
  const readAddress = (field: string): string => {
    const value = readEpochField(patron, field);
    if (typeof value !== "string") {
      throw new Error(`Invalid ${field} returned by the Talos registry.`);
    }
    return value;
  };
  const readShare = (field: string): number => {
    const value = toBigInt(readEpochField(patron, field), field);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Invalid ${field} returned by the Talos registry.`);
    }
    return Number(value);
  };

  return {
    creatorAddress: readAddress("creator_addr"),
    investorAddress: readAddress("investor_addr"),
    treasuryAddress: readAddress("treasury_addr"),
    creatorShare: readShare("creator_share"),
    investorShare: readShare("investor_share"),
    treasuryShare: readShare("treasury_share"),
  };
}

/** Read one committed dividend epoch from the TalosDividends contract. */
export async function getEpoch(
  talosId: number,
  epochId: bigint | number,
): Promise<DividendEpoch | null> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const value = await readDividendsContract("get_epoch", [
    nativeToScVal(talosId, { type: "u32" }),
    nativeToScVal(BigInt(epochId), { type: "u64" }),
  ]);
  if (value === null || value === undefined) return null;

  return {
    epochId: toBigInt(readEpochField(value, "epoch_id"), "epoch ID"),
    talosId: Number(toBigInt(readEpochField(value, "talos_id"), "Talos ID")),
    totalAmount: toBigInt(readEpochField(value, "total_amount"), "total amount"),
    claimedAmount: toBigInt(readEpochField(value, "claimed_amount"), "claimed amount"),
    createdAt: toBigInt(readEpochField(value, "created_at"), "creation time"),
    expirySecs: toBigInt(readEpochField(value, "expiry_secs"), "expiry"),
  };
}

/** Read the next sequential epoch ID that would be assigned to a Talos. */
export async function getNextEpochId(talosId: number): Promise<bigint> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const value = await readDividendsContract("next_epoch_id", [
    nativeToScVal(talosId, { type: "u32" }),
  ]);
  return toBigInt(value, "next epoch ID");
}

/** Check whether a wallet has claimed one specific dividend epoch. */
export async function hasClaimed(
  epochId: bigint | number,
  claimant: string,
): Promise<boolean> {
  const { nativeToScVal } = await import("@stellar/stellar-sdk");
  const value = await readDividendsContract("has_claimed", [
    nativeToScVal(BigInt(epochId), { type: "u64" }),
    nativeToScVal(claimant, { type: "address" }),
  ]);
  if (typeof value !== "boolean") {
    throw new Error("Invalid claim status returned by the dividends contract.");
  }
  return value;
}

export interface DividendClaimParams {
  claimant: string;
  talosId: number;
  epochId: bigint;
  patronCreator: string;
  patronInvestor: string;
  patronTreasury: string;
  creatorShare: number;
  investorShare: number;
  treasuryShare: number;
}

export function getDividendClaimErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const codeMatch = message.match(/Error\(Contract,\s*#(\d+)\)/i);
  const code = codeMatch?.[1];
  if (/AlreadyClaimed/i.test(message) || code === "5") {
    return "You have already claimed this dividend epoch.";
  }
  if (/EpochExpired/i.test(message) || code === "6") {
    return "This dividend epoch has expired and can no longer be claimed.";
  }
  if (/NotAPatron/i.test(message) || code === "10") {
    return "Your connected wallet is not registered as a patron for this TALOS.";
  }
  return message || "The dividend claim could not be completed.";
}

/**
 * Simulate, wallet-sign, and submit a dividend claim. No signing keys leave the wallet.
 */
export async function submitDividendClaim(
  params: DividendClaimParams,
  signTransaction: (xdr: string) => Promise<string>,
): Promise<string> {
  const { Account, BASE_FEE, Contract, TransactionBuilder, nativeToScVal } =
    await import("@stellar/stellar-sdk");
  const network = getNetwork();
  const server = await getSorobanClient();
  const accountResponse = await server.getAccount(params.claimant);
  const contract = new Contract(requireDividendsContractId());
  const tx = new TransactionBuilder(
    new Account(accountResponse.accountId(), accountResponse.sequenceNumber()),
    { fee: BASE_FEE, networkPassphrase: network.networkPassphrase },
  )
    .addOperation(
      contract.call(
        "claim_dividend",
        nativeToScVal(params.claimant, { type: "address" }),
        nativeToScVal(params.talosId, { type: "u32" }),
        nativeToScVal(params.epochId, { type: "u64" }),
        nativeToScVal(params.patronCreator, { type: "address" }),
        nativeToScVal(params.patronInvestor, { type: "address" }),
        nativeToScVal(params.patronTreasury, { type: "address" }),
        nativeToScVal(params.creatorShare, { type: "u32" }),
        nativeToScVal(params.investorShare, { type: "u32" }),
        nativeToScVal(params.treasuryShare, { type: "u32" }),
      ),
    )
    .setTimeout(60)
    .build();

  const preparedTx = await server.prepareTransaction(tx);
  const signedXdr = await signTransaction(preparedTx.toXDR());
  const submitted = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, network.networkPassphrase),
  );
  if (submitted.status === "ERROR") {
    throw new Error(getDividendClaimErrorMessage(submitted.errorResult ?? "Transaction rejected."));
  }

  let result = await server.getTransaction(submitted.hash);
  for (let attempt = 0; attempt < 10 && result.status === "NOT_FOUND"; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    result = await server.getTransaction(submitted.hash);
  }
  if (result.status === "SUCCESS") return submitted.hash;
  if (result.status === "FAILED") {
    throw new Error(getDividendClaimErrorMessage(JSON.stringify(result)));
  }
  throw new Error(`Claim submitted but confirmation is pending. Transaction: ${submitted.hash}`);
}

/**
 * Check if a name is available on-chain via the TalosNameService contract.
 * Read-only — no wallet needed.
 */
export async function isNameAvailableOnChain(name: string): Promise<boolean> {
  if (!TALOS_NAME_SERVICE_CONTRACT_ID) return true; // Fallback: format validation only

  try {
    const { Contract, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
    const server = await getSorobanClient();

    const contract = new Contract(TALOS_NAME_SERVICE_CONTRACT_ID);
    const result = await server.simulateTransaction(
      await buildReadOnlyTx(
        contract.call("is_name_available", nativeToScVal(name, { type: "string" })),
      ),
    );

    if ("error" in result) return true;
    return scValToNative((result as { result: { retval: import("@stellar/stellar-sdk").xdr.ScVal } }).result.retval) as boolean;
  } catch {
    // Contract not deployed yet — fall back to regex validation
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) && !/--/.test(name);
  }
}

/**
 * Resolve a .talos name to its on-chain TALOS ID.
 * Returns null if name is not registered.
 */
export async function resolveNameOnChain(name: string): Promise<number | null> {
  if (!TALOS_NAME_SERVICE_CONTRACT_ID) return null;

  try {
    const { Contract, nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
    const server = await getSorobanClient();

    const contract = new Contract(TALOS_NAME_SERVICE_CONTRACT_ID);
    const result = await server.simulateTransaction(
      await buildReadOnlyTx(
        contract.call("resolve_name", nativeToScVal(name, { type: "string" })),
      ),
    );

    if ("error" in result) return null;
    const id = scValToNative((result as { result: { retval: import("@stellar/stellar-sdk").xdr.ScVal } }).result.retval) as number;
    return id > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Build a minimal read-only Soroban transaction for simulation.
 * Uses a dummy source account — no signing required for reads.
 */
async function buildReadOnlyTx(operation: unknown) {
  const { TransactionBuilder, BASE_FEE, Account } = await import("@stellar/stellar-sdk");
  const network = getNetwork();

  // Dummy account for read-only simulation
  const dummyAccount = new Account(
    await getDummyAccountPublicKey(),
    "0",
  );

  return new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(operation as Parameters<typeof TransactionBuilder.prototype.addOperation>[0])
    .setTimeout(30)
    .build();
}

/**
 * Validate that a Stellar public key is properly formatted (G... prefix, 56 chars).
 */
export function isValidStellarPublicKey(key: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(key);
}

/**
 * Validate Stellar network for the connected wallet.
 * Throws a user-friendly error if on the wrong network.
 */
export async function ensureStellarNetwork(
  walletPublicKey: string,
): Promise<void> {
  if (!isValidStellarPublicKey(walletPublicKey)) {
    throw new Error(
      "Invalid Stellar public key. Please connect a Stellar wallet (Freighter, Albedo, etc.).",
    );
  }

  const { Horizon } = await import("@stellar/stellar-sdk");
  const network = getNetwork();
  const server = new Horizon.Server(network.horizonUrl);

  try {
    await server.loadAccount(walletPublicKey);
  } catch {
    if (STELLAR_NETWORK === "testnet") {
      throw new Error(
        `Account not found on Stellar Testnet. Fund your account at https://friendbot.stellar.org?addr=${walletPublicKey}`,
      );
    }
    throw new Error("Account not found on Stellar. Please fund your account first.");
  }
}
