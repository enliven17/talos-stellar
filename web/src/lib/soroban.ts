/**
 * Soroban contract interaction — replaces contracts.ts (Hedera/ethers).
 *
 * Handles TalosRegistry and TalosNameService on Stellar Soroban.
 * Read-only calls use Soroban RPC directly.
 * Write calls (create TALOS, register name) go through the user's wallet via WalletKit.
 */

const STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const STELLAR_SOROBAN_RPC =
  process.env.STELLAR_SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";

export const TALOS_REGISTRY_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT ?? "";

export const TALOS_NAME_SERVICE_CONTRACT_ID =
  process.env.NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT ?? "";

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
    return scValToNative((result as { result: { retval: unknown } }).result.retval) as boolean;
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
    const id = scValToNative((result as { result: { retval: unknown } }).result.retval) as number;
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
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
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
