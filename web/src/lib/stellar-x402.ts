/**
 * x402 payments on Stellar — sign, verify, and settle via Soroban auth entries.
 * Replaces circle.ts x402 signing (EIP-3009 on Arc).
 *
 * Uses x402-stellar npm package + OpenZeppelin facilitator.
 * Facilitator endpoints:
 *   Testnet: https://channels.openzeppelin.com/x402/testnet
 *   Mainnet: https://channels.openzeppelin.com/x402
 */

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
    process.env.STELLAR_NETWORK === "mainnet"
      ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
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
}

/**
 * Verify an x402 payment token via the facilitator's /verify endpoint.
 * Replaces: ethers.verifyTypedData() for EIP-712 signature verification.
 */
export async function verifyX402Payment(
  paymentToken: string,
  expectedAmount: string,
  expectedTo: string,
): Promise<boolean> {
  try {
    // Try x402-stellar verify
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const x402 = await import("x402-stellar").catch(() => null) as any;
    if (x402?.verifyPayment) {
      return await x402.verifyPayment({
        paymentToken,
        expectedAmount,
        expectedTo,
        facilitatorUrl: X402_FACILITATOR_URL,
        apiKey: X402_API_KEY,
      });
    }

    // Fallback: call facilitator /verify directly
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

    if (!res.ok) return false;
    const data = await res.json();
    return data.valid === true;
  } catch (err) {
    console.error("[stellar-x402] verifyX402Payment failed:", err);
    return false;
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
    const res = await fetch(`${X402_FACILITATOR_URL}/settle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(X402_API_KEY ? { Authorization: `Bearer ${X402_API_KEY}` } : {}),
      },
      body: JSON.stringify({ paymentToken }),
    });

    if (!res.ok) {
      throw new Error(`x402 settle failed: ${res.status} ${await res.text()}`);
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
