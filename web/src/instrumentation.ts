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

  // Start the Stellar transaction finality reconciler background loop.
  // The loop is a no-op when RECONCILER_ENABLED !== "true", so it is safe to
  // unconditionally import and start it here.  The globalThis singleton
  // pattern in scheduler.ts ensures only one loop runs even when Next.js
  // re-executes this module during hot-reload.
  const { startReconciler } = await import("./lib/reconciler");
  startReconciler();
}
