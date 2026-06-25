import { Keypair, StrKey } from "@stellar/stellar-sdk";

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
