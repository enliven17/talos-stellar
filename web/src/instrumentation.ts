/**
 * Next.js startup hook. Runs once per server instance before any request is
 * handled, so misconfigured Stellar asset/network pairs fail the boot instead
 * of surfacing mid-payment.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Importing the module runs resolveStellarAssetConfig() and throws a
  // StellarConfigError (variable names only, no secrets) on invalid config.
  await import("./lib/stellar-config");
}
