import { getPublicBaseUrl } from "../public-url";
import { describe, it, expect, afterEach, vi } from "vitest";

describe("getPublicBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should return localhost in development if no headers provided", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = new Headers();
    expect(getPublicBaseUrl(headers)).toBe("http://localhost:3000");
  });

  it("should return configured APP_URL if no headers provided in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://talos.example.com");
    const headers = new Headers();
    expect(getPublicBaseUrl(headers)).toBe("https://talos.example.com");
  });

  it("should accept explicit trusted host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "trusted.example.com,also-trusted.com");
    const headers = new Headers({
      host: "trusted.example.com"
    });
    expect(getPublicBaseUrl(headers)).toBe("https://trusted.example.com"); // defaults to https
  });

  it("should prioritize x-forwarded-host and x-forwarded-proto", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "proxy.example.com");
    const headers = new Headers({
      host: "internal.local",
      "x-forwarded-host": "proxy.example.com",
      "x-forwarded-proto": "http"
    });
    expect(getPublicBaseUrl(headers)).toBe("http://proxy.example.com");
  });

  it("should fallback to APP_URL if host is untrusted", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://safe.example.com");
    const headers = new Headers({
      host: "evil.com"
    });
    expect(getPublicBaseUrl(headers)).toBe("https://safe.example.com");
  });

  it("should throw if host is untrusted and no APP_URL is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
    vi.stubEnv("TRUSTED_HOSTS", "good.com");
    
    const headers = new Headers({
      host: "evil.com"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Untrusted host header");
  });

  it("should accept localhost in development automatically", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = new Headers({
      host: "localhost:3000"
    });
    expect(getPublicBaseUrl(headers)).toBe("http://localhost:3000");
  });

  it("should accept localhost in test automatically", () => {
    vi.stubEnv("NODE_ENV", "test");
    const headers = new Headers({
      host: "127.0.0.1:8080"
    });
    expect(getPublicBaseUrl(headers)).toBe("http://127.0.0.1:8080");
  });

  it("should reject ambiguous x-forwarded-host", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = new Headers({
      "x-forwarded-host": "good.com, evil.com"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Ambiguous X-Forwarded-Host");
  });

  it("should reject ambiguous host", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = new Headers({
      "host": "good.com, evil.com"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Ambiguous Host");
  });

  it("should reject malformed host with path injection", () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = new Headers({
      "host": "good.com/evil"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Malformed host header");
  });

  it("should reject host headers with userinfo injection", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "trusted.example.com");
    const headers = new Headers({
      "host": "evil.com@trusted.example.com"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Malformed host header");
  });

  it("should reject host headers containing whitespace", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "trusted.example.com");
    const headers = new Headers({
      "x-forwarded-host": "trusted.example.com extra"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Malformed host header");
  });

  it("should reject conflicting trusted host and x-forwarded-host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "a.example.com,b.example.com");
    const headers = new Headers({
      host: "a.example.com",
      "x-forwarded-host": "b.example.com"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Conflicting host headers");
  });

  it("should accept matching host and x-forwarded-host", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "app.example.com");
    const headers = new Headers({
      host: "app.example.com",
      "x-forwarded-host": "app.example.com",
      "x-forwarded-proto": "https"
    });
    expect(getPublicBaseUrl(headers)).toBe("https://app.example.com");
  });

  it("should reject invalid x-forwarded-proto values", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "app.example.com");
    const headers = new Headers({
      host: "app.example.com",
      "x-forwarded-proto": "gopher"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Invalid X-Forwarded-Proto");
  });

  it("should reject ambiguous x-forwarded-proto", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_HOSTS", "app.example.com");
    const headers = new Headers({
      host: "app.example.com",
      "x-forwarded-proto": "https,http"
    });
    expect(() => getPublicBaseUrl(headers)).toThrow("Ambiguous X-Forwarded-Proto");
  });

  it("should use http for localhost in development without a forwarded proto", () => {
    vi.stubEnv("NODE_ENV", "development");
    const headers = new Headers({
      host: "localhost:3000",
      "x-forwarded-host": "localhost:3000"
    });
    expect(getPublicBaseUrl(headers)).toBe("http://localhost:3000");
  });

  it("should not trust localhost names in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_URL", "https://safe.example.com");
    const headers = new Headers({
      host: "localhost:3000"
    });
    expect(getPublicBaseUrl(headers)).toBe("https://safe.example.com");
  });
});
