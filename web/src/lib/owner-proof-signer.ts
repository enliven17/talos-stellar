import { createOwnerProofMessage } from "@/lib/api-key-owner-message";

export async function signOwnerProof(
  talosId: string,
  resource: string,
  method: string,
  timestamp = Date.now(),
): Promise<{ message: string; signature: string }> {
  const message = createOwnerProofMessage(talosId, resource, method, timestamp);
  const { StellarWalletsKit } = await import("@creit.tech/stellar-wallets-kit");
  const { signedMessage } = await StellarWalletsKit.signMessage(message);

  if (typeof signedMessage === "string") return { message, signature: signedMessage };

  const bytes = signedMessage as unknown as Uint8Array;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { message, signature: btoa(binary) };
}
