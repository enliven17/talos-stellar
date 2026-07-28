/**
 * Next.js Edge Middleware entrypoint.
 *
 * Delegates to proxy.ts which handles:
 *   - Distributed rate limiting (shared Redis counters, in-memory fallback)
 *   - Trusted-proxy IP extraction
 *   - API versioning and path rewriting
 *   - Standard rate-limit response headers
 *
 * To change rate-limit quotas without a code deploy, update the env vars
 * documented in RATE_LIMITING.md and redeploy.
 */

export { proxy as middleware, config } from "@/proxy";
