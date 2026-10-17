export const API_CURRENT_VERSION = "1";
export const API_DEFAULT_VERSION = "1";

export const VERSION_REGEX = /^\/api\/v(\d+)\//;

export interface ApiVersionConfig {
  version: string;
  deprecated: boolean;
  sunset?: string;
}

export const SUPPORTED_VERSIONS: Record<string, ApiVersionConfig> = {
  "1": { version: "1", deprecated: false },
};

export function parseVersionFromPath(pathname: string): string | null {
  const match = pathname.match(VERSION_REGEX);
  return match ? match[1] : null;
}

export function isVersionedPath(pathname: string): boolean {
  return VERSION_REGEX.test(pathname);
}

export function getVersionConfig(version: string): ApiVersionConfig | undefined {
  // `version` may originate from an untrusted client header (Accept-Version).
  // A plain object lookup would resolve inherited keys like "constructor" or
  // "toString" to a truthy, non-ApiVersionConfig value — guard with an own-
  // property check so only explicitly registered versions ever match.
  if (!Object.prototype.hasOwnProperty.call(SUPPORTED_VERSIONS, version)) {
    return undefined;
  }
  return SUPPORTED_VERSIONS[version];
}

export function negotiateApiVersion(
  pathname: string,
  acceptVersion?: string | null,
): { version: string; config: ApiVersionConfig } {
  const pathVersion = parseVersionFromPath(pathname);
  if (pathVersion) {
    const config = getVersionConfig(pathVersion);
    if (config) return { version: pathVersion, config };
  }
  if (acceptVersion) {
    const config = getVersionConfig(acceptVersion);
    if (config) return { version: acceptVersion, config };
  }
  return {
    version: API_DEFAULT_VERSION,
    config: SUPPORTED_VERSIONS[API_DEFAULT_VERSION]!,
  };
}

export function stripVersionPrefix(pathname: string): string {
  return pathname.replace(VERSION_REGEX, "/api/");
}

export function addVersionHeaders(
  headers: Headers,
  versionInfo: { version: string; config: ApiVersionConfig },
): void {
  headers.set("X-API-Version", versionInfo.version);
  // `sunset` is optional metadata on top of `deprecated` — a version marked
  // deprecated without a sunset date must still surface as deprecated so
  // operators can't silently misconfigure this into a no-op.
  if (versionInfo.config.deprecated) {
    headers.set("Deprecation", "true");
    if (versionInfo.config.sunset) {
      headers.set("Sunset", versionInfo.config.sunset);
    }
  }
}
