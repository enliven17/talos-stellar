const BASE_SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const HSTS_HEADER = {
  key: "Strict-Transport-Security",
  value: "max-age=31536000; includeSubDomains",
};

export function getSecurityHeaders(environment) {
  if (environment === "production") {
    return [...BASE_SECURITY_HEADERS, HSTS_HEADER];
  }

  if (environment === "preview" || environment === "development") {
    return [...BASE_SECURITY_HEADERS];
  }

  // Keep an invalid deployment selector from silently weakening the policy.
  throw new Error("Unsupported security-header environment");
}

// ─── Content-Security-Policy ─────────────────────────────────────────────
//
// The policy is attached per request by the proxy (src/proxy.ts) so that
// every document gets a fresh script nonce; `next.config.mjs` keeps serving
// only the static baseline headers above, because a build-time CSP cannot
// carry a nonce and would be enforced *alongside* the per-request one.

/** Request header Next.js reads to stamp nonces onto rendered scripts. */
export const CSP_NONCE_HEADER = "x-nonce";

/** Where browsers POST violation reports. */
export const CSP_REPORT_ENDPOINT = "/api/csp-report";

/** Report-To group name referenced by the `report-to` directive. */
export const CSP_REPORT_TO_GROUP = "csp-endpoint";

export const CSP_MODES = Object.freeze({
  REPORT_ONLY: "report-only",
  ENFORCE: "enforce",
});

const CSP_ENVIRONMENTS = Object.freeze(["production", "preview", "development"]);

/**
 * Explicit opt-in values for enforcement. Anything else — including
 * unset, empty or misspelled values — keeps the header in report-only
 * mode so a typo can never break the site.
 */
const ENFORCE_VALUES = new Set(["1", "true", "yes", "on"]);

/** Nonces are base64 and generated internally; reject anything else. */
const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{8,64}$/;

/**
 * Extra allow-listed sources come from env vars, so they are validated as
 * either an absolute URL (`https://host`, `ws://host:*`) or a CSP keyword
 * (`'self'`).  Anything else is dropped rather than interpolated into a
 * response header.
 */
const ABSOLUTE_SOURCE_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9*./:_-]+$/i;
const KEYWORD_SOURCE_PATTERN = /^'[a-z-]+'$/i;

/**
 * Resolve the active CSP mode from an explicit value or CSP_ENFORCE.
 *
 * @param {string} [raw]
 * @returns {"report-only" | "enforce"}
 */
export function resolveCspMode(raw = process.env.CSP_ENFORCE) {
  const value = String(raw ?? "").trim().toLowerCase();
  return ENFORCE_VALUES.has(value) ? CSP_MODES.ENFORCE : CSP_MODES.REPORT_ONLY;
}

/**
 * Map the deployment target onto the same environment vocabulary used by
 * `getSecurityHeaders` (production | preview | development).
 *
 * @param {{ vercelEnv?: string, nodeEnv?: string }} [overrides]
 * @returns {"production" | "preview" | "development"}
 */
export function resolveCspEnvironment({ vercelEnv, nodeEnv } = {}) {
  const vercel = vercelEnv !== undefined ? vercelEnv : process.env.VERCEL_ENV;
  if (vercel && CSP_ENVIRONMENTS.includes(vercel)) return vercel;

  const node = nodeEnv !== undefined ? nodeEnv : process.env.NODE_ENV;
  return node === "production" ? "production" : "development";
}

/**
 * 16 random bytes, base64-encoded. Uses Web Crypto + btoa so it works on
 * both the Node.js and Edge proxy runtimes.
 *
 * @returns {string}
 */
export function createCspNonce() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

/**
 * @param {"report-only" | "enforce"} mode
 * @returns {string}
 */
export function cspHeaderName(mode) {
  return mode === CSP_MODES.ENFORCE
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}

/** Split a comma/whitespace separated env var into validated source tokens. */
function extraSources(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[\s,]+/)
    .filter(
      (token) =>
        token === "*" ||
        KEYWORD_SOURCE_PATTERN.test(token) ||
        ABSOLUTE_SOURCE_PATTERN.test(token),
    );
}

/** Origin of an env-provided URL, or null when unset/invalid. */
function originOf(value) {
  if (!value) return null;
  try {
    const origin = new globalThis.URL(value).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Endpoints the browser itself talks to (custom RPC/API/app URLs), derived
 * from the same public env vars the client bundle is built with.
 *
 * @returns {string[]}
 */
function runtimeOrigins() {
  const origins = [];
  for (const value of [
    process.env.NEXT_PUBLIC_STELLAR_RPC_URL,
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_APP_URL,
  ]) {
    const origin = originOf(value);
    if (origin && !origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/** Horizon / Soroban RPC / Sentry ingestion (error reporting + performance). */
const BASE_CONNECT_SOURCES = [
  "'self'",
  "https://horizon.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://soroban-testnet.stellar.org",
  "https://soroban-rpc.stellar.org",
  "https://friendbot.stellar.org",
  "https://*.ingest.sentry.io",
  "https://*.sentry.io",
];

/** Local dev server + webpack HMR socket (development only). */
const DEVELOPMENT_CONNECT_SOURCES = [
  "http://localhost:*",
  "ws://localhost:*",
  "http://127.0.0.1:*",
  "ws://127.0.0.1:*",
];

const BASE_IMG_SOURCES = ["'self'", "data:", "blob:", "https://*.sentry.io"];
const BASE_FONT_SOURCES = ["'self'", "data:", "https://fonts.gstatic.com"];
const BASE_FRAME_SOURCES = ["'self'"];

/**
 * Build the Content-Security-Policy value for one request.
 *
 * Notes on the trade-offs:
 * - `style-src` keeps `'unsafe-inline'` and is deliberately NOT nonced:
 *   React inline `style` attributes (out of scope to remove) are blocked
 *   as soon as a nonce appears in the style source list.
 * - `script-src` is nonce-based with `'strict-dynamic'`-free host fallbacks
 *   so externally bundled chunks keep working on cached documents while
 *   inline scripts must carry the per-request nonce.
 * - Development adds `'unsafe-eval'` (React devtool stack traces) and the
 *   localhost/HMR endpoints; production/preview add `upgrade-insecure-requests`.
 *
 * @param {{
 *   nonce: string,
 *   mode?: "report-only" | "enforce",
 *   environment?: "production" | "preview" | "development",
 *   extraConnectSrc?: string,
 *   extraImgSrc?: string,
 *   extraFrameSrc?: string,
 * }} options
 * @returns {string}
 */
export function buildContentSecurityPolicy(options) {
  const { nonce } = options ?? {};
  const mode = options.mode ?? CSP_MODES.REPORT_ONLY;
  const environment = options.environment;

  if (!CSP_ENVIRONMENTS.includes(environment)) {
    throw new Error("Unsupported security-header environment");
  }
  if (mode !== CSP_MODES.REPORT_ONLY && mode !== CSP_MODES.ENFORCE) {
    throw new Error("Unsupported CSP mode");
  }
  if (typeof nonce !== "string" || !NONCE_PATTERN.test(nonce)) {
    throw new Error("CSP requires a valid per-request nonce");
  }

  const isDevelopment = environment === "development";

  const connectSources = [
    ...BASE_CONNECT_SOURCES,
    ...runtimeOrigins(),
    ...(isDevelopment ? DEVELOPMENT_CONNECT_SOURCES : []),
    ...extraSources(options.extraConnectSrc ?? process.env.CSP_EXTRA_CONNECT_SRC),
  ];

  const imgSources = [
    ...BASE_IMG_SOURCES,
    ...extraSources(options.extraImgSrc ?? process.env.CSP_EXTRA_IMG_SRC),
  ];

  const frameSources = [
    ...BASE_FRAME_SOURCES,
    ...extraSources(options.extraFrameSrc ?? process.env.CSP_EXTRA_FRAME_SRC),
  ];

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${
      isDevelopment ? " 'unsafe-eval'" : ""
    }`,
    // See note above: inline style attributes must keep working.
    "style-src 'self' 'unsafe-inline'",
    `img-src ${imgSources.join(" ")}`,
    `font-src ${BASE_FONT_SOURCES.join(" ")}`,
    `connect-src ${connectSources.join(" ")}`,
    `frame-src ${frameSources.join(" ")}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(environment === "development" ? [] : ["upgrade-insecure-requests"]),
    `report-uri ${CSP_REPORT_ENDPOINT}`,
    `report-to ${CSP_REPORT_TO_GROUP}`,
  ];

  return directives.join("; ");
}

/**
 * Resolve mode + environment (unless given explicitly), generate a fresh
 * nonce when none is supplied, and return the header to set on the response.
 *
 * @param {{
 *   nonce?: string,
 *   mode?: "report-only" | "enforce",
 *   environment?: "production" | "preview" | "development",
 *   extraConnectSrc?: string,
 *   extraImgSrc?: string,
 *   extraFrameSrc?: string,
 * }} [options]
 * @returns {{ key: string, value: string }}
 */
export function getCspHeader(options = {}) {
  const mode = options.mode ?? resolveCspMode();
  const environment = options.environment ?? resolveCspEnvironment();
  const nonce = options.nonce ?? createCspNonce();
  const value = buildContentSecurityPolicy({ ...options, nonce, mode, environment });
  return { key: cspHeaderName(mode), value };
}

/**
 * Companion `Reporting-Endpoints` header for the `report-to` directive.
 *
 * @returns {{ key: string, value: string }}
 */
export function getReportingEndpointsHeader() {
  return {
    key: "Reporting-Endpoints",
    value: `${CSP_REPORT_TO_GROUP}="${CSP_REPORT_ENDPOINT}"`,
  };
}
