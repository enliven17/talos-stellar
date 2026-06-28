const isProd = process.env.NODE_ENV === "production";
const isClient = typeof window !== "undefined";
const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";

const network =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK ??
  process.env.STELLAR_NETWORK ??
  "testnet";

export const OPERATOR_PUBLIC_KEY = isClient
  ? (process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY || "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL")
  : (process.env.STELLAR_OPERATOR_PUBLIC_KEY ||
     process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY ||
     "GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL");

export const USDC_ISSUER =
  process.env.NEXT_PUBLIC_STELLAR_USDC_ISSUER ??
  process.env.STELLAR_USDC_ISSUER ??
  (network === "mainnet"
    ? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    : "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

// Throw at module load if a required env var is missing in production
if (isProd && !isNextBuild) {
  if (isClient) {
    if (!process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY) {
      throw new Error("Missing NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY in production client environment");
    }
  } else {
    if (!process.env.STELLAR_OPERATOR_PUBLIC_KEY && !process.env.NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY) {
      throw new Error("Missing STELLAR_OPERATOR_PUBLIC_KEY or NEXT_PUBLIC_STELLAR_OPERATOR_PUBLIC_KEY in production server environment");
    }
  }
}
