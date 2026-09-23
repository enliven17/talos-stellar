import { NextRequest } from "next/server";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".local");
}

/**
 * Parses a raw Host / X-Forwarded-Host value into a URL, rejecting anything
 * that isn't a bare `host[:port]` authority component.
 */
function parseHostHeader(value: string, headerName: string): URL {
  // A comma means the header was folded from multiple hops — we can't tell
  // which hop's value to trust, so treat it as ambiguous.
  if (value.includes(",")) {
    throw new Error(`Ambiguous ${headerName}`);
  }

  // Whitespace, userinfo, and path characters have no place in a host header.
  // Parsing them would let "evil.com@trusted.com" masquerade as trusted.com.
  if (/[\s@/\\?#]/.test(value)) {
    throw new Error("Malformed host header");
  }

  try {
    return new URL(`http://${value}`);
  } catch {
    throw new Error("Malformed host header");
  }
}

function trustedHostnames(configuredUrl: string | undefined): string[] {
  const hosts = (process.env.TRUSTED_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);

  if (configuredUrl) {
    try {
      hosts.push(new URL(configuredUrl).hostname.toLowerCase());
    } catch {
      // A misconfigured APP_URL shouldn't take down URL building.
    }
  }

  return hosts;
}

/**
 * Resolves the externally visible base URL for a request.
 *
 * Only hosts listed in TRUSTED_HOSTS (or derived from APP_URL) are honoured,
 * plus localhost names outside production. Untrusted or ambiguous headers never
 * influence the result: we either fall back to the configured APP_URL or throw.
 * Error messages stay generic so the trusted-host configuration is never
 * disclosed to a client probing with forged headers.
 */
export function getPublicBaseUrl(reqOrHeaders: Request | NextRequest | Headers): string {
  const headers = reqOrHeaders instanceof Headers
    ? reqOrHeaders
    : ('headers' in reqOrHeaders ? reqOrHeaders.headers : new Headers());

  const configuredUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL)?.replace(/\/$/, "");
  const isLocal = process.env.NODE_ENV !== "production";
  const trusted = trustedHostnames(configuredUrl);

  const rawForwardedHost = headers.get("x-forwarded-host");
  const rawHost = headers.get("host");
  const forwardedProto = headers.get("x-forwarded-proto");

  if (forwardedProto) {
    if (forwardedProto.includes(",")) {
      throw new Error("Ambiguous X-Forwarded-Proto");
    }
    if (forwardedProto !== "http" && forwardedProto !== "https") {
      throw new Error("Invalid X-Forwarded-Proto");
    }
  }

  const forwardedHost = rawForwardedHost ? parseHostHeader(rawForwardedHost, "X-Forwarded-Host") : null;
  const directHost = rawHost ? parseHostHeader(rawHost, "Host") : null;

  const isTrusted = (hostname: string) =>
    trusted.includes(hostname.toLowerCase()) || (isLocal && isLocalHostname(hostname.toLowerCase()));

  // When both headers are present they usually agree (proxies mirror the
  // original Host). If they disagree and Host itself names a trusted host,
  // the request is ambiguous — picking either could select a value the
  // client forged, so refuse. A differing untrusted Host is just an internal
  // hop name and the forwarded value wins.
  if (forwardedHost && directHost) {
    const sameAuthority = forwardedHost.host === directHost.host;
    if (!sameAuthority && isTrusted(directHost.hostname)) {
      throw new Error("Conflicting host headers");
    }
  }

  const candidate = forwardedHost ?? directHost;

  if (!candidate) {
    if (configuredUrl) return configuredUrl;
    return "http://localhost:3000";
  }

  if (!isTrusted(candidate.hostname)) {
    if (configuredUrl) return configuredUrl;
    throw new Error("Untrusted host header");
  }

  // Local development has no TLS terminator, so default to http there; in
  // production default to https unless the proxy explicitly forwarded http.
  const protocol = forwardedProto ?? (isLocal && isLocalHostname(candidate.hostname) ? "http" : "https");
  return `${protocol}://${candidate.host}`;
}
