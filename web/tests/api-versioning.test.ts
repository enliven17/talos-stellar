import { describe, it, expect } from "vitest";
import {
  API_CURRENT_VERSION,
  API_DEFAULT_VERSION,
  addVersionHeaders,
  getVersionConfig,
  isVersionedPath,
  negotiateApiVersion,
  parseVersionFromPath,
  stripVersionPrefix,
  SUPPORTED_VERSIONS,
} from "../src/lib/api-versioning";

describe("parseVersionFromPath", () => {
  it("extracts version from /api/v1/... paths", () => {
    expect(parseVersionFromPath("/api/v1/talos")).toBe("1");
    expect(parseVersionFromPath("/api/v1/health")).toBe("1");
    expect(parseVersionFromPath("/api/v1/talos/me")).toBe("1");
    expect(parseVersionFromPath("/api/v1/talos/123/activity")).toBe("1");
  });

  it("returns null for unversioned paths", () => {
    expect(parseVersionFromPath("/api/talos")).toBeNull();
    expect(parseVersionFromPath("/api/health/live")).toBeNull();
    expect(parseVersionFromPath("/health")).toBeNull();
    expect(parseVersionFromPath("/api/v1")).toBeNull();
  });

  it("returns null for non-API paths", () => {
    expect(parseVersionFromPath("/_next/static/chunk.js")).toBeNull();
    expect(parseVersionFromPath("/favicon.ico")).toBeNull();
  });
});

describe("isVersionedPath", () => {
  it("returns true for version-prefixed paths", () => {
    expect(isVersionedPath("/api/v1/talos")).toBe(true);
    expect(isVersionedPath("/api/v1/")).toBe(true);
  });

  it("returns false for unversioned paths", () => {
    expect(isVersionedPath("/api/talos")).toBe(false);
    expect(isVersionedPath("/api/")).toBe(false);
  });
});

describe("getVersionConfig", () => {
  it("returns config for known versions", () => {
    const config = getVersionConfig("1");
    expect(config).toBeDefined();
    expect(config!.version).toBe("1");
    expect(config!.deprecated).toBe(false);
  });

  it("returns undefined for unknown versions", () => {
    expect(getVersionConfig("2")).toBeUndefined();
    expect(getVersionConfig("99")).toBeUndefined();
    expect(getVersionConfig("v1")).toBeUndefined();
  });

  it("returns undefined for inherited Object.prototype keys (malformed Accept-Version input)", () => {
    // SUPPORTED_VERSIONS is a plain object; a naive `obj[version]` lookup
    // would resolve these to truthy, non-ApiVersionConfig values.
    expect(getVersionConfig("constructor")).toBeUndefined();
    expect(getVersionConfig("__proto__")).toBeUndefined();
    expect(getVersionConfig("toString")).toBeUndefined();
    expect(getVersionConfig("hasOwnProperty")).toBeUndefined();
  });
});

describe("negotiateApiVersion", () => {
  it("prefers path version over default", () => {
    const result = negotiateApiVersion("/api/v1/talos");
    expect(result.version).toBe("1");
  });

  it("falls back to default for unversioned paths", () => {
    const result = negotiateApiVersion("/api/talos");
    expect(result.version).toBe(API_DEFAULT_VERSION);
  });

  it("considers Accept-Version header when no path version", () => {
    const result = negotiateApiVersion("/api/talos", "1");
    expect(result.version).toBe("1");
  });

  it("ignores Accept-Version when path version takes precedence", () => {
    const result = negotiateApiVersion("/api/v1/talos", "2");
    expect(result.version).toBe("1");
  });

  it("returns default for unknown Accept-Version", () => {
    const result = negotiateApiVersion("/api/talos", "99");
    expect(result.version).toBe(API_DEFAULT_VERSION);
  });

  it("returns default for an Accept-Version matching an inherited object key", () => {
    const result = negotiateApiVersion("/api/talos", "constructor");
    expect(result.version).toBe(API_DEFAULT_VERSION);
    expect(result.config).toBe(SUPPORTED_VERSIONS[API_DEFAULT_VERSION]);
  });

  it("returns default for an empty-string Accept-Version", () => {
    const result = negotiateApiVersion("/api/talos", "");
    expect(result.version).toBe(API_DEFAULT_VERSION);
  });

  it("returns default for null Accept-Version", () => {
    const result = negotiateApiVersion("/api/talos", null);
    expect(result.version).toBe(API_DEFAULT_VERSION);
  });

  it("returns default for non-API paths", () => {
    const result = negotiateApiVersion("/health");
    expect(result.version).toBe(API_DEFAULT_VERSION);
  });
});

describe("stripVersionPrefix", () => {
  it("strips v1 prefix from /api/v1/talos", () => {
    expect(stripVersionPrefix("/api/v1/talos")).toBe("/api/talos");
  });

  it("strips v1 prefix from nested paths", () => {
    expect(stripVersionPrefix("/api/v1/talos/123/activity")).toBe(
      "/api/talos/123/activity",
    );
  });

  it("strips v1 prefix with trailing slash", () => {
    expect(stripVersionPrefix("/api/v1/")).toBe("/api/");
  });

  it("unchanged for unversioned paths", () => {
    expect(stripVersionPrefix("/api/talos")).toBe("/api/talos");
  });
});

describe("addVersionHeaders", () => {
  it("adds X-API-Version header", () => {
    const headers = new Headers();
    addVersionHeaders(headers, {
      version: "1",
      config: { version: "1", deprecated: false },
    });
    expect(headers.get("X-API-Version")).toBe("1");
  });

  it("does not add Deprecation/Sunset for non-deprecated versions", () => {
    const headers = new Headers();
    addVersionHeaders(headers, {
      version: "1",
      config: { version: "1", deprecated: false },
    });
    expect(headers.has("Deprecation")).toBe(false);
    expect(headers.has("Sunset")).toBe(false);
  });

  it("adds Deprecation and Sunset for deprecated versions", () => {
    const headers = new Headers();
    addVersionHeaders(headers, {
      version: "1",
      config: {
        version: "1",
        deprecated: true,
        sunset: "Sat, 01 Jan 2027 00:00:00 GMT",
      },
    });
    expect(headers.get("Deprecation")).toBe("true");
    expect(headers.get("Sunset")).toBe("Sat, 01 Jan 2027 00:00:00 GMT");
  });

  it("adds Deprecation without Sunset when a version is deprecated with no sunset date set", () => {
    // A missing `sunset` must not silently suppress the Deprecation signal —
    // sunset is optional metadata layered on top of `deprecated`, not a
    // second flag that has to also be true.
    const headers = new Headers();
    addVersionHeaders(headers, {
      version: "1",
      config: { version: "1", deprecated: true },
    });
    expect(headers.get("Deprecation")).toBe("true");
    expect(headers.has("Sunset")).toBe(false);
  });
});

describe("constants", () => {
  it("API_CURRENT_VERSION matches DEFAULT", () => {
    expect(API_CURRENT_VERSION).toBe(API_DEFAULT_VERSION);
  });

  it("SUPPORTED_VERSIONS includes v1", () => {
    expect(SUPPORTED_VERSIONS["1"]).toBeDefined();
  });
});
