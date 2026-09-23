/**
 * x402 payments on Stellar — sign, verify, and settle via Soroban auth entries.
 * Replaces circle.ts x402 signing (EIP-3009 on Arc).
 *
 * Uses x402-stellar npm package + OpenZeppelin facilitator.
 * Facilitator endpoints:
 *   Testnet: https://channels.openzeppelin.com/x402/testnet
 *   Mainnet: https://channels.openzeppelin.com/x402
 */

import { USDC_ISSUER } from "./stellar-config";

const X402_FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ??
  "https://channels.openzeppelin.com/x402/testnet";

const X402_API_KEY = process.env.X402_API_KEY ?? "";

export interface X402PaymentPayload {
  /** Stellar public key of the payer (agent's wallet) */
  from: string;
  /** Stellar public key of the payee (service provider) */
  to: string;
  /** Amount in USDC (human-readable, e.g. "1.00") */
  amount: string;
  /** Asset code — always "USDC" */
  assetCode?: string;
}

/**
 * Sign an x402 payment on Stellar using the agent's secret key.
 * Creates a Soroban auth entry that the facilitator can verify and settle.
 * Replaces: Circle MPC signPayment() + EIP-3009 TransferWithAuthorization.
 */
export async function signX402Payment(
  agentSecretKey: string,
  payload: X402PaymentPayload,
): Promise<{ paymentToken: string }> {
  // Helper: redact any Stellar secret-like patterns from messages
  const sanitize = (input: unknown) => {
    const s = typeof input === "string" ? input : String(input);
    // Stellar secret seeds begin with 'S' and are 56 chars total (1 + 55)
    return s.replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
  };

  try {
    // x402-stellar: sign Soroban auth entry for USDC transfer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const x402 = await import("x402-stellar").catch(() => null) as any;

    if (x402?.signPayment) {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const keypair = Keypair.fromSecret(agentSecretKey);
      const networkPassphrase =
        process.env.STELLAR_NETWORK === "mainnet"
          ? "Public Global Stellar Network ; September 2015"
          : "Test SDF Network ; September 2015";

      const token = await x402.signPayment({
        secretKey: agentSecretKey,
        publicKey: keypair.publicKey(),
        from: payload.from,
        to: payload.to,
        amount: payload.amount,
        assetCode: payload.assetCode ?? "USDC",
        networkPassphrase,
        facilitatorUrl: X402_FACILITATOR_URL,
      });
      return { paymentToken: token };
    }

    // Fallback: manual Stellar transaction as payment proof
    // Build + sign a Stellar tx and return the XDR as the payment token
    console.warn("[stellar-x402] x402-stellar package not available, using manual tx fallback");
    const {
      Keypair,
      Asset,
      TransactionBuilder,
      Operation,
      BASE_FEE,
    } = await import("@stellar/stellar-sdk");
    const { Horizon } = await import("@stellar/stellar-sdk");

    const horizonUrl =
      process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
    const keypair = Keypair.fromSecret(agentSecretKey);
    const server = new Horizon.Server(horizonUrl);
    const account = await server.loadAccount(keypair.publicKey());

    const networkPassphrase =
      process.env.STELLAR_NETWORK === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015";

    const usdc = new Asset(
      payload.assetCode ?? "USDC",
      USDC_ISSUER,
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: payload.to,
          asset: usdc,
          amount: payload.amount,
        }),
      )
      .setTimeout(60)
      .build();

    tx.sign(keypair);
    return { paymentToken: tx.toXDR() };
  } catch (err) {
    const msg = sanitize(err instanceof Error ? err.message : err);
    console.error("[stellar-x402] signX402Payment failed:", msg);
    throw new Error(msg);
  }
}

export type VerifyX402Result = {
  valid: boolean;
  errorCategory?: string;
  errorMessage?: string;
};

/**
 * Perform strict offline verification of the XDR payment token.
 * Validates the transaction structure, network, missing operations, asset issuer, recipient, and amount.
 */
export function verifyX402PaymentOffline(
  paymentToken: string,
  expectedAmount: string,
  expectedTo: string,
): VerifyX402Result {
  let tx;
  const networkPassphrase =
    process.env.STELLAR_NETWORK === "mainnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015";

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TransactionBuilder, Operation } = require("@stellar/stellar-sdk");

  try {
    tx = TransactionBuilder.fromXDR(paymentToken, networkPassphrase);
  } catch (err: unknown) {
    return { valid: false, errorCategory: "malformed-xdr", errorMessage: `Failed to parse XDR: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Verify transaction signature against the configured network
  const { Keypair } = require("@stellar/stellar-sdk");
  const hash = tx.hash();
  const hasValidSignature = tx.signatures.some((sig: any) => {
    try {
      return Keypair.fromPublicKey(tx.source).verify(hash, sig.signature());
    } catch {
      return false;
    }
  });

  if (!hasValidSignature) {
    return { valid: false, errorCategory: "network", errorMessage: "Transaction signature is invalid or network passphrase mismatch" };
  }

  // Check missing operations
  if (tx.operations.length !== 1) {
    return { valid: false, errorCategory: "missing-operation", errorMessage: `Transaction must contain exactly one operation, found ${tx.operations.length}` };
  }

  const op = tx.operations[0];
  if (op.type !== "payment") {
    return { valid: false, errorCategory: "missing-operation", errorMessage: `Operation must be a payment, found ${op.type}` };
  }

  // Check asset and issuer
  if (op.asset.isNative()) {
    return { valid: false, errorCategory: "issuer/asset", errorMessage: "Asset cannot be native XLM, must be USDC" };
  }
  
  if (op.asset.code !== "USDC") {
    return { valid: false, errorCategory: "issuer/asset", errorMessage: `Asset code must be USDC, found ${op.asset.code}` };
  }

  if (op.asset.issuer !== USDC_ISSUER) {
    return { valid: false, errorCategory: "issuer/asset", errorMessage: `Asset issuer must be ${USDC_ISSUER}, found ${op.asset.issuer}` };
  }

  // Check recipient
  if (op.destination !== expectedTo) {
    return { valid: false, errorCategory: "recipient", errorMessage: `Payment destination ${op.destination} does not match expected ${expectedTo}` };
  }

  // Check amount
  if (Number(op.amount) < Number(expectedAmount)) {
    return { valid: false, errorCategory: "amount", errorMessage: `Payment amount ${op.amount} is less than expected ${expectedAmount}` };
  }

  return { valid: true };
}

/**
 * Verify an x402 payment token.
 * First strictly validates the XDR offline.
 * Replaces: ethers.verifyTypedData() for EIP-712 signature verification.
 */
export async function verifyX402Payment(
  paymentToken: string,
  expectedAmount: string,
  expectedTo: string,
): Promise<VerifyX402Result> {
  // 1. Strict Offline Validation
  const offlineResult = verifyX402PaymentOffline(paymentToken, expectedAmount, expectedTo);
  if (!offlineResult.valid) {
    return offlineResult;
  }

  try {
    // 2. Try x402-stellar verify
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const x402 = await import("x402-stellar").catch(() => null) as any;
    if (x402?.verifyPayment) {
      const valid = await x402.verifyPayment({
        paymentToken,
        expectedAmount,
        expectedTo,
        facilitatorUrl: X402_FACILITATOR_URL,
        apiKey: X402_API_KEY,
      });
      return { valid };
    }

    // 3. Fallback: call facilitator /verify directly
    const res = await fetch(`${X402_FACILITATOR_URL}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(X402_API_KEY ? { Authorization: `Bearer ${X402_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        paymentToken,
        expectedAmount,
        expectedTo,
      }),
    });

    if (!res.ok) {
      return { valid: false, errorCategory: "facilitator-error", errorMessage: `Facilitator returned ${res.status}` };
    }
    const data = await res.json();
    return { valid: data.valid === true, errorCategory: data.valid ? undefined : "facilitator-rejected" };
  } catch (err) {
    const msg = String(err).replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
    console.error("[stellar-x402] verifyX402Payment failed:", msg);
    return { valid: false, errorCategory: "facilitator-error", errorMessage: msg };
  }
}

/**
 * Settle an x402 payment via the facilitator's /settle endpoint.
 * Submits the signed Soroban transaction on-chain.
 * Replaces: broadcastTransferWithAuthorization() on Arc.
 */
export async function settleX402Payment(
  paymentToken: string,
): Promise<{ txHash: string }> {
  // Try x402-stellar settle
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x402 = await import("x402-stellar").catch(() => null) as any;
  if (x402?.settlePayment) {
    const result = await x402.settlePayment({
      paymentToken,
      facilitatorUrl: X402_FACILITATOR_URL,
      apiKey: X402_API_KEY,
    });
    return { txHash: result.txHash };
  }

  // Fallback: submit XDR tx directly to Horizon (manual fallback path)
  const { Horizon } = await import("@stellar/stellar-sdk");
  const horizonUrl =
    process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org";
  const server = new Horizon.Server(horizonUrl);

  try {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const tx = TransactionBuilder.fromXDR(
      paymentToken,
      process.env.STELLAR_NETWORK === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015",
    );
    const result = await server.submitTransaction(tx);
    return { txHash: result.hash };
  } catch (err) {
    // Also try facilitator /settle directly
    const sanitize = (input: unknown) => String(input).replace(/S[A-Z2-7]{55}/g, "[REDACTED]");
    const res = await fetch(`${X402_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(X402_API_KEY ? { Authorization: `Bearer ${X402_API_KEY}` } : {}),
      },
      body: JSON.stringify({ paymentToken }),
    });

    if (!res.ok) {
      const body = await res.text();
      const msg = sanitize(`x402 settle failed: ${res.status} ${body}`);
      throw new Error(msg);
    }
    const data = await res.json();
    return { txHash: data.txHash };
  }
}

/**
 * Build the X-Payment header value for an x402 request.
 */
export function buildX402Header(paymentToken: string): string {
  return `x402 ${paymentToken}`;
}
