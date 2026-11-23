import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSP_NONCE_HEADER,
  CSP_REPORT_ENDPOINT,
  buildContentSecurityPolicy,
  createCspNonce,
  cspHeaderName,
  getCspHeader,
  getReportingEndpointsHeader,
  getSecurityHeaders,
  resolveCspEnvironment,
  resolveCspMode,
} from "../src/lib/security-headers.mjs";

const requiredHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=()",
};

const matrix: Array<{
  name: string;
  environment: "production" | "preview" | "development";
  hasHsts: boolean;
}> = [
  { name: "production", environment: "production", hasHsts: true },
  { name: "preview", environment: "preview", hasHsts: false },
  { name: "local development", environment: "development", hasHsts: false },
];

describe("security-header regression matrix", () => {
  it.each(matrix)("keeps the baseline policy for $name", ({ environment, hasHsts }) => {
    const headers = getSecurityHeaders(environment);
    const values = new Map(headers.map(({ key, value }) => [key, value]));

    expect(Object.fromEntries(values)).toMatchObject(requiredHeaders);
    expect(values.get("Strict-Transport-Security")).toBe(
      hasHsts ? "max-age=31536000; includeSubDomains" : undefined,
    );
    expect(values.size).toBe(headers.length);
  });

  it.each(["production-with-typo", undefined])(
    "fails closed for an ambiguous environment (%s)",
    (environment) => {
      expect(() => getSecurityHeaders(environment)).toThrow(
        "Unsupported security-header environment",
      );
    },
  );

  it("keeps the production boundary explicit", () => {
    const headers = getSecurityHeaders("production");

    expect(headers.at(-1)).toEqual({
      key: "Strict-Transport-Security",
      value: "max-age=31536000; includeSubDomains",
    });
  });

  it("returns a fresh policy so one request cannot mutate another", () => {
    const first = getSecurityHeaders("production");
    first.pop();

    expect(getSecurityHeaders("production")).toHaveLength(5);
  });

  it("never emits a static CSP — a nonce-less policy would be enforced alongside the per-request one", () => {
    for (const { environment } of matrix) {
      for (const { key } of getSecurityHeaders(environment)) {
        expect(key.toLowerCase()).not.toContain("content-security-policy");
      }
    }
  });
});

// ─── Content-Security-Policy ─────────────────────────────────────────────

const VALID_NONCE = "bm9uY2UtZXhhbXBsZQ==";

/** Escape hatch for deliberately invalid inputs (fail-closed assertions). */
function unsafeOptions(overrides: Record<string, unknown>): never {
  return overrides as never;
}

/** Extract one directive from a serialized policy. */
function directive(policy: string, name: string): string {
  return (
    policy
      .split("; ")
      .find((entry) => entry === name || entry.startsWith(`${name} `)) ?? ""
  );
}

/** Blank out env vars that would otherwise vary between machines. */
function stubNeutralEnv() {
  vi.stubEnv("CSP_ENFORCE", "");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CSP_EXTRA_CONNECT_SRC", "");
  vi.stubEnv("CSP_EXTRA_IMG_SRC", "");
  vi.stubEnv("CSP_EXTRA_FRAME_SRC", "");
  vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "");
  vi.stubEnv("NEXT_PUBLIC_API_URL", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Content-Security-Policy — mode selection", () => {
  it("ships the report-only header by default in every environment", () => {
    stubNeutralEnv();

    for (const { environment } of matrix) {
      expect(resolveCspMode()).toBe("report-only");
      const header = getCspHeader({ nonce: VALID_NONCE, environment });
      expect(header.key).toBe("Content-Security-Policy-Report-Only");
    }
  });

  it.each(["1", "true", "TRUE", "yes", "on"])(
    "switches to the enforcing header for CSP_ENFORCE=%s",
    (value) => {
      stubNeutralEnv();
      vi.stubEnv("CSP_ENFORCE", value);

      expect(resolveCspMode()).toBe("enforce");
      expect(cspHeaderName(resolveCspMode())).toBe("Content-Security-Policy");
      const header = getCspHeader({
        nonce: VALID_NONCE,
        environment: "production",
      });
      expect(header.key).toBe("Content-Security-Policy");
    },
  );

  it.each(["", "false", "0", "no", "off", "truely", "banana"])(
    "stays report-only for CSP_ENFORCE=%s (enforcement must be explicit)",
    (value) => {
      stubNeutralEnv();
      vi.stubEnv("CSP_ENFORCE", value);

      expect(resolveCspMode()).toBe("report-only");
      expect(
        getCspHeader({ nonce: VALID_NONCE, environment: "production" }).key,
      ).toBe("Content-Security-Policy-Report-Only");
    },
  );

  it("fails closed on an unknown mode or environment", () => {
    expect(() =>
      buildContentSecurityPolicy(
        unsafeOptions({
          nonce: VALID_NONCE,
          environment: "production",
          mode: "enforce-ish",
        }),
      ),
    ).toThrow("Unsupported CSP mode");

    expect(() =>
      buildContentSecurityPolicy(
        unsafeOptions({ nonce: VALID_NONCE, environment: "prod" }),
      ),
    ).toThrow("Unsupported security-header environment");

    expect(() =>
      buildContentSecurityPolicy(
        unsafeOptions({ nonce: VALID_NONCE, environment: undefined }),
      ),
    ).toThrow("Unsupported security-header environment");
  });

  it("resolves the deployment environment like the static header matrix", () => {
    stubNeutralEnv();

    expect(
      resolveCspEnvironment({ vercelEnv: "preview", nodeEnv: "production" }),
    ).toBe("preview");
    expect(
      resolveCspEnvironment({ vercelEnv: "unknown", nodeEnv: "production" }),
    ).toBe("production");
    expect(resolveCspEnvironment({ nodeEnv: "development" })).toBe(
      "development",
    );
    expect(resolveCspEnvironment({ vercelEnv: "", nodeEnv: "" })).toBe(
      "development",
    );
  });
});

describe("Content-Security-Policy — policy content", () => {
  const base = { nonce: VALID_NONCE, environment: "production" as const };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("carries the per-request nonce in script-src", () => {
    stubNeutralEnv();

    const policy = buildContentSecurityPolicy(base);
    expect(directive(policy, "script-src")).toContain(`'nonce-${VALID_NONCE}'`);
    expect(policy).toContain(`report-uri ${CSP_REPORT_ENDPOINT}`);
    expect(policy).toContain("report-to csp-endpoint");
  });

  it("keeps style-src nonced-free so inline style attributes keep working", () => {
    stubNeutralEnv();

    const styleSrc = directive(buildContentSecurityPolicy(base), "style-src");
    expect(styleSrc).toContain("'self'");
    expect(styleSrc).toContain("'unsafe-inline'");
    expect(styleSrc).not.toContain("nonce-");
  });

  it.each(matrix)(
    "locks down the baseline directives for $name",
    ({ environment }) => {
      stubNeutralEnv();

      const policy = buildContentSecurityPolicy({ nonce: VALID_NONCE, environment });
      expect(directive(policy, "default-src")).toBe("default-src 'self'");
      expect(directive(policy, "object-src")).toBe("object-src 'none'");
      expect(directive(policy, "base-uri")).toBe("base-uri 'self'");
      expect(directive(policy, "form-action")).toBe("form-action 'self'");
      expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
      expect(directive(policy, "worker-src")).toBe("worker-src 'self' blob:");
      expect(policy).toContain(`report-uri ${CSP_REPORT_ENDPOINT}`);
    },
  );

  it("allowlists the browser-side endpoints the app depends on", () => {
    stubNeutralEnv();

    const policy = buildContentSecurityPolicy(base);
    const connect = directive(policy, "connect-src");

    for (const source of [
      "'self'",
      "https://horizon.stellar.org",
      "https://horizon-testnet.stellar.org",
      "https://soroban-testnet.stellar.org",
      "https://soroban-rpc.stellar.org",
      "https://friendbot.stellar.org",
      "https://*.ingest.sentry.io",
      "https://*.sentry.io",
    ]) {
      expect(connect).toContain(source);
    }

    const img = directive(policy, "img-src");
    expect(img).toContain("'self'");
    expect(img).toContain("data:");
    expect(img).toContain("blob:");

    expect(directive(policy, "frame-src")).toContain("'self'");
    expect(directive(policy, "font-src")).toContain("https://fonts.gstatic.com");
  });

  it("adds the configured public endpoints to connect-src", () => {
    stubNeutralEnv();
    vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "https://rpc.custom.example/v1");
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.custom.example");

    const connect = directive(buildContentSecurityPolicy(base), "connect-src");
    expect(connect).toContain("https://rpc.custom.example");
    expect(connect).toContain("https://api.custom.example");
    // Query strings must never leak into the header.
    expect(connect).not.toContain("/v1?");
  });

  it("appends operator-provided extras from the env allow-lists", () => {
    stubNeutralEnv();
    vi.stubEnv(
      "CSP_EXTRA_CONNECT_SRC",
      "https://rpc.extra.example, wss://streams.extra.example",
    );
    vi.stubEnv("CSP_EXTRA_IMG_SRC", "https://cdn.extra.example");
    vi.stubEnv("CSP_EXTRA_FRAME_SRC", "https://wallet.extra.example");

    const policy = buildContentSecurityPolicy(base);
    expect(directive(policy, "connect-src")).toContain(
      "https://rpc.extra.example",
    );
    expect(directive(policy, "connect-src")).toContain(
      "wss://streams.extra.example",
    );
    expect(directive(policy, "img-src")).toContain("https://cdn.extra.example");
    expect(directive(policy, "frame-src")).toContain(
      "https://wallet.extra.example",
    );
  });

  it("drops malformed extra tokens instead of interpolating them into a header", () => {
    stubNeutralEnv();
    vi.stubEnv(
      "CSP_EXTRA_CONNECT_SRC",
      "https://good.extra.example not-a-source x-injected:\n<script>",
    );

    const connect = directive(buildContentSecurityPolicy(base), "connect-src");
    expect(connect).toContain("https://good.extra.example");
    expect(connect).not.toContain("not-a-source");
    expect(connect).not.toContain("x-injected");
    expect(connect).not.toContain("<script>");
  });

  it("only hardens the request scheme outside development", () => {
    stubNeutralEnv();

    expect(buildContentSecurityPolicy(base)).toContain(
      "upgrade-insecure-requests",
    );
    expect(
      buildContentSecurityPolicy({ nonce: VALID_NONCE, environment: "preview" }),
    ).toContain("upgrade-insecure-requests");
    expect(
      buildContentSecurityPolicy({
        nonce: VALID_NONCE,
        environment: "development",
      }),
    ).not.toContain("upgrade-insecure-requests");
  });

  it("grants development-only eval and localhost/HMR endpoints", () => {
    stubNeutralEnv();

    const development = buildContentSecurityPolicy({
      nonce: VALID_NONCE,
      environment: "development",
    });
    expect(directive(development, "script-src")).toContain("'unsafe-eval'");
    expect(directive(development, "connect-src")).toContain(
      "ws://localhost:*",
    );
    expect(directive(development, "connect-src")).toContain(
      "http://127.0.0.1:*",
    );

    const production = buildContentSecurityPolicy(base);
    expect(directive(production, "script-src")).not.toContain("'unsafe-eval'");
    expect(directive(production, "connect-src")).not.toContain("localhost");
  });

  it("rejects a missing or malformed nonce (header-injection guard)", () => {
    stubNeutralEnv();

    expect(() =>
      buildContentSecurityPolicy(unsafeOptions({ environment: "production" })),
    ).toThrow("valid per-request nonce");

    expect(() =>
      buildContentSecurityPolicy(
        unsafeOptions({
          nonce: "abc'; script-src *",
          environment: "production",
        }),
      ),
    ).toThrow("valid per-request nonce");
  });

  it("produces a single-line header value", () => {
    stubNeutralEnv();

    const policy = buildContentSecurityPolicy(base);
    expect(policy).not.toMatch(/[\r\n]/);
    expect(policy.endsWith("; report-to csp-endpoint")).toBe(true);
  });
});

describe("Content-Security-Policy — per-request plumbing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("generates a fresh, unpredictable nonce per call", () => {
    const nonces = Array.from({ length: 64 }, () => createCspNonce());

    expect(new Set(nonces).size).toBe(nonces.length);
    for (const nonce of nonces) {
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
      expect(nonce.length).toBeGreaterThanOrEqual(16);
    }
  });

  it("mints a nonce when the caller does not supply one", () => {
    stubNeutralEnv();

    const header = getCspHeader({ environment: "production" });
    expect(header.value).toMatch(
      new RegExp(`'nonce-[A-Za-z0-9+/=]{8,64}'`),
    );
  });

  it("publishes the report endpoint through both reporting mechanisms", () => {
    expect(getReportingEndpointsHeader()).toEqual({
      key: "Reporting-Endpoints",
      value: `csp-endpoint="${CSP_REPORT_ENDPOINT}"`,
    });
    expect(CSP_NONCE_HEADER).toBe("x-nonce");
  });
});
