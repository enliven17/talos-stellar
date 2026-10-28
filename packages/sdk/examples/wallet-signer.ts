import {
  SigningController,
  WalletMessageSigner,
  signRequestWithWallet,
  type WalletSignMessageFn,
} from "../src";

/**
 * Example: sign Talos requests with a Freighter-compatible browser wallet.
 *
 * `signMessage` is supplied by the host app (for example the web app's
 * `useStellarWallet().signMessage`). The SDK never imports a wallet package.
 */
export function createBrowserWalletSigner(
  publicKey: string,
  signMessage: WalletSignMessageFn,
): SigningController {
  const signer = new WalletMessageSigner({ keyId: publicKey, signMessage });
  return new SigningController(signer, {
    timeoutMs: 60_000,
    maxConcurrent: 1,
    onEvent: (event) => {
      // Privacy-safe: no URLs, bodies, or signatures are included here.
      console.debug("[talos-signing]", event.name, event.errorCode ?? "");
    },
  });
}

export async function signExampleRequest(
  controller: SigningController,
  signer: WalletMessageSigner,
): Promise<void> {
  const result = await signRequestWithWallet(signer, {
    method: "POST",
    url: "https://api.example.test/v1/payments",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ amount: "1.00" }),
    timestamp: new Date().toISOString(),
    nonce: crypto.randomUUID(),
  });
  console.info("signed by", result.keyId);
  void controller;
}
