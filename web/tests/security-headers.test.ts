import { describe, expect, it } from "vitest";
import { getSecurityHeaders } from "../src/lib/security-headers.mjs";

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
    "fails closed for an ambiguous environment (%s)", (environment) => {
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
});
