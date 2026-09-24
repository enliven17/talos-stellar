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
