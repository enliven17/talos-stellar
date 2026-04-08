/**
 * Stellar operations — core account management, USDC payments, trustlines.
 * Replaces legacy hedera.ts + Circle wallet creation from circle.ts.
 *
 * Agent secret keys are NEVER stored in the database.
 * They are held server-side in environment variables or a secret manager.
 */

const STELLAR_NETWORK = process.env.STELLAR_NETWORK ?? "testnet";
const STELLAR_HORIZON_URL =
  process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";

// Circle-issued USDC on Stellar
const USDC_ISSUER_TESTNET = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ISSUER_MAINNET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

export function getUSDCIssuer(): string {
  return STELLAR_NETWORK === "mainnet" ? USDC_ISSUER_MAINNET : USDC_ISSUER_TESTNET;
}

export function getNetworkPassphrase(): string {
  const { Networks } = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");
  return STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/**
 * Create a new Stellar keypair for an agent wallet (called during TALOS Genesis).
 * Returns { publicKey, secretKey }.
 * Store publicKey in DB as agentWalletId + agentWalletAddress.
 * Store secretKey server-side ONLY (env var or secret manager).
 */
export async function createAgentKeypair(): Promise<{
  publicKey: string;
  secretKey: string;
}> {
  const { Keypair } = await import("@stellar/stellar-sdk");
  const keypair = Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
}

/**
 * Fund a new Stellar testnet account via Friendbot.
 * Best-effort — failure doesn't block agent wallet creation.
 */
export async function fundTestnetAccount(publicKey: string): Promise<void> {
  if (STELLAR_NETWORK !== "testnet") return;
  try {
    const res = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
    );
    if (res.ok) {
      console.log(`[stellar] Friendbot funded ${publicKey}`);
    } else {
      console.warn(`[stellar] Friendbot returned ${res.status} for ${publicKey}`);
    }
  } catch (err) {
    console.warn("[stellar] Friendbot request failed:", err);
  }
}

/**
 * Establish a USDC trustline for an agent account.
 * Must be called before the account can receive USDC.
 */
export async function establishUSDCTrustline(
  secretKey: string,
): Promise<{ txHash: string }> {
  const {
    Keypair,
    Asset,
    TransactionBuilder,
    Operation,
    BASE_FEE,
  } = await import("@stellar/stellar-sdk");
  const { Horizon } = await import("@stellar/stellar-sdk");

  const keypair = Keypair.fromSecret(secretKey);
  const server = new Horizon.Server(STELLAR_HORIZON_URL);
  const account = await server.loadAccount(keypair.publicKey());

  const usdc = new Asset("USDC", getUSDCIssuer());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return { txHash: result.hash };
}

/**
 * Send USDC from one Stellar account to another.
 * Amount is in human-readable USDC units (e.g. "5.00" = 5 USDC).
 */
export async function sendUSDC(
  fromSecretKey: string,
  toPublicKey: string,
  amount: string,
): Promise<{ txHash: string }> {
  const {
    Keypair,
    Asset,
    TransactionBuilder,
    Operation,
    BASE_FEE,
  } = await import("@stellar/stellar-sdk");
  const { Horizon } = await import("@stellar/stellar-sdk");

  const keypair = Keypair.fromSecret(fromSecretKey);
  const server = new Horizon.Server(STELLAR_HORIZON_URL);
  const account = await server.loadAccount(keypair.publicKey());

  const usdc = new Asset("USDC", getUSDCIssuer());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      Operation.payment({
        destination: toPublicKey,
        asset: usdc,
        amount,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await server.submitTransaction(tx);
  return { txHash: result.hash };
}

/**
 * Get USDC balance for a Stellar account.
 * Returns human-readable balance string (e.g. "10.0000000") or "0" if no trustline.
 */
export async function getUSDCBalance(publicKey: string): Promise<string> {
  const { Horizon, Asset } = await import("@stellar/stellar-sdk");
  const server = new Horizon.Server(STELLAR_HORIZON_URL);

  try {
    const account = await server.loadAccount(publicKey);
    const usdc = new Asset("USDC", getUSDCIssuer());
    const balance = account.balances.find(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === usdc.getCode() &&
        b.asset_issuer === usdc.getIssuer(),
    );
    return balance ? balance.balance : "0";
  } catch {
    return "0";
  }
}

/**
 * Get XLM (native) balance for a Stellar account.
 */
export async function getXLMBalance(publicKey: string): Promise<string> {
  const { Horizon } = await import("@stellar/stellar-sdk");
  const server = new Horizon.Server(STELLAR_HORIZON_URL);

  try {
    const account = await server.loadAccount(publicKey);
    const native = account.balances.find((b) => b.asset_type === "native");
    return native ? native.balance : "0";
  } catch {
    return "0";
  }
}

/**
 * Record an approval decision on Stellar as a transaction with a text memo.
 * Sends a minimal XLM payment (to self) with JSON memo.
 * Returns null if operator key is not configured.
 */
export async function recordApprovalOnChain(
  approvalId: string,
  talosId: string,
  status: "approved" | "rejected",
  decidedBy: string,
): Promise<{ txHash: string } | null> {
  const operatorSecret = process.env.STELLAR_OPERATOR_SECRET_KEY;
  if (!operatorSecret) {
    console.warn("[stellar] STELLAR_OPERATOR_SECRET_KEY not set, skipping on-chain record");
    return null;
  }

  try {
    const {
      Keypair,
      Asset,
      TransactionBuilder,
      Operation,
      Memo,
      BASE_FEE,
    } = await import("@stellar/stellar-sdk");
    const { Horizon } = await import("@stellar/stellar-sdk");

    const keypair = Keypair.fromSecret(operatorSecret);
    const server = new Horizon.Server(STELLAR_HORIZON_URL);
    const account = await server.loadAccount(keypair.publicKey());

    // Stellar memo max 28 bytes — use a short hash reference
    const memoText = `${talosId.slice(0, 8)}:${approvalId.slice(0, 8)}:${status.slice(0, 1)}`;

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
      memo: Memo.text(memoText),
    })
      .addOperation(
        Operation.payment({
          destination: keypair.publicKey(), // self-payment
          asset: Asset.native(),
          amount: "0.0000001",
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    const result = await server.submitTransaction(tx);
    return { txHash: result.hash };
  } catch (err) {
    console.error("[stellar] Failed to record approval on-chain:", err);
    return null;
  }
}

/**
 * Check if a Stellar account exists on the network.
 */
export async function getAccountInfo(
  publicKey: string,
): Promise<{ exists: boolean; xlmBalance: string; usdcBalance: string }> {
  try {
    const xlm = await getXLMBalance(publicKey);
    const usdc = await getUSDCBalance(publicKey);
    return { exists: true, xlmBalance: xlm, usdcBalance: usdc };
  } catch {
    return { exists: false, xlmBalance: "0", usdcBalance: "0" };
  }
}
