import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertSafeSeedDatabaseUrl } from "../src/db/seed-guard";

describe("local database seed safety", () => {
  it("accepts the local hostnames used by the development stack", () => {
    for (const host of ["localhost", "127.0.0.1", "::1", "postgres"]) {
      const urlHost = host === "::1" ? `[${host}]` : host;
      expect(() =>
        assertSafeSeedDatabaseUrl(
          `postgresql://user:pass@${urlHost}:5432/talos`,
          { nodeEnv: "development" },
        ),
      ).not.toThrow();
    }
  });

  it("rejects production-looking configuration unless explicitly overridden", () => {
    expect(() =>
      assertSafeSeedDatabaseUrl(
        "postgresql://user:pass@database.example.com:5432/talos",
        { nodeEnv: "development" },
      ),
    ).toThrow(/Refusing to seed database host/);

    expect(() =>
      assertSafeSeedDatabaseUrl(
        "postgresql://user:pass@database.example.com:5432/talos",
        { nodeEnv: "production" },
      ),
    ).toThrow(/Refusing to seed a production process/);

    expect(() =>
      assertSafeSeedDatabaseUrl(
        "postgresql://user:pass@database.example.com:5432/talos",
        { nodeEnv: "production", allowUnsafe: "true" },
      ),
    ).not.toThrow();
  });

  it("rejects missing or malformed database configuration", () => {
    expect(() => assertSafeSeedDatabaseUrl(undefined)).toThrow(
      /DATABASE_URL is not set/,
    );
    expect(() => assertSafeSeedDatabaseUrl("not-a-url")).toThrow(
      /not a valid PostgreSQL URL/,
    );
  });

  it("contains no private keys or credential-shaped values", () => {
    const seedSource = readFileSync(
      new URL("../src/db/seed.ts", import.meta.url),
      "utf8",
    );

    expect(seedSource).not.toMatch(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:sk|pk)_(?:live|test)?[_-]/i,
    );
    expect(seedSource).not.toMatch(/SECRET|PRIVATE_KEY|SECRET_KEY/i);
  });

  it("resets seed-owned tables and uses a stable commerce identity", () => {
    const seedSource = readFileSync(
      new URL("../src/db/seed.ts", import.meta.url),
      "utf8",
    );

    expect(seedSource.indexOf("await db.delete(tlsCommerceJobs)")).toBeLessThan(
      seedSource.indexOf("const talosData ="),
    );
    expect(seedSource).toContain('paymentSig: "seed-payment-community-voice-v1"');
    expect(seedSource).toContain('status: "completed"');
  });
});
