import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import {
  CANONICAL_USDC_ISSUERS,
  StellarConfigError,
  resolveStellarAssetConfig,
  validateStellarAssetConfig,
  type StellarAssetConfigIssueCode,
  type StellarAssetEnv,
} from "../src/lib/stellar-config";

const TESTNET_ISSUER = CANONICAL_USDC_ISSUERS.testnet;
const MAINNET_ISSUER = CANONICAL_USDC_ISSUERS.mainnet;
const CUSTOM_ISSUER = Keypair.random().publicKey();
// Same as the testnet issuer with the last character changed → bad CRC16.
const BAD_CHECKSUM_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA6";

function codes(env: StellarAssetEnv): StellarAssetConfigIssueCode[] {
  const result = validateStellarAssetConfig(env);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("validateStellarAssetConfig", () => {
  describe("defaults (backwards compatible)", () => {
    it("defaults to testnet and the canonical testnet issuer when nothing is set", () => {
      expect(validateStellarAssetConfig({})).toEqual({
        ok: true,
        config: {
          network: "testnet",
          networkPassphrase: Networks.TESTNET,
          usdcIssuer: TESTNET_ISSUER,
          customIssuer: false,
        },
      });
    });

    it("defaults the issuer to Circle mainnet USDC on mainnet", () => {
      const result = validateStellarAssetConfig({ STELLAR_NETWORK: "mainnet" });
      expect(result).toEqual({
        ok: true,
        config: {
          network: "mainnet",
          networkPassphrase: Networks.PUBLIC,
          usdcIssuer: MAINNET_ISSUER,
          customIssuer: false,
        },
      });
    });

    it("treats empty and whitespace-only values as unset", () => {
      const result = validateStellarAssetConfig({
        NEXT_PUBLIC_STELLAR_NETWORK: "",
        STELLAR_NETWORK: "   ",
        NEXT_PUBLIC_STELLAR_USDC_ISSUER: "",
        STELLAR_USDC_ISSUER: " ",
      });
      expect(result.ok && result.config.usdcIssuer).toBe(TESTNET_ISSUER);
    });

    it("trims surrounding whitespace from valid values", () => {
      const result = validateStellarAssetConfig({
        STELLAR_NETWORK: " mainnet\n",
        STELLAR_USDC_ISSUER: ` ${MAINNET_ISSUER} `,
      });
      expect(result.ok && result.config).toMatchObject({
        network: "mainnet",
        usdcIssuer: MAINNET_ISSUER,
      });
    });
  });

  describe("matching pairs", () => {
    it.each([
      ["testnet", TESTNET_ISSUER],
      ["mainnet", MAINNET_ISSUER],
    ] as const)("accepts %s with its canonical issuer", (network, issuer) => {
      expect(
        validateStellarAssetConfig({
          NEXT_PUBLIC_STELLAR_NETWORK: network,
          STELLAR_NETWORK: network,
          NEXT_PUBLIC_STELLAR_USDC_ISSUER: issuer,
          STELLAR_USDC_ISSUER: issuer,
        }).ok,
      ).toBe(true);
    });

    it("prefers NEXT_PUBLIC_STELLAR_NETWORK when only it is set", () => {
      const result = validateStellarAssetConfig({ NEXT_PUBLIC_STELLAR_NETWORK: "mainnet" });
      expect(result.ok && result.config.network).toBe("mainnet");
    });

    it("allows a custom issuer on testnet and flags it", () => {
      const result = validateStellarAssetConfig({ STELLAR_USDC_ISSUER: CUSTOM_ISSUER });
      expect(result.ok && result.config).toMatchObject({
        usdcIssuer: CUSTOM_ISSUER,
        customIssuer: true,
      });
    });

    it.each(["STELLAR_ALLOW_CUSTOM_USDC_ISSUER", "NEXT_PUBLIC_STELLAR_ALLOW_CUSTOM_USDC_ISSUER"])(
      "allows a custom mainnet issuer with %s=true",
      (flag) => {
        const result = validateStellarAssetConfig({
          STELLAR_NETWORK: "mainnet",
          STELLAR_USDC_ISSUER: CUSTOM_ISSUER,
          [flag]: "true",
        });
        expect(result.ok && result.config.customIssuer).toBe(true);
      },
    );
  });

  describe("malformed values", () => {
    it.each(["Mainnet", "public", "pubnet", "futurenet", "TESTNET"])(
      "rejects network value %j",
      (value) => {
        expect(codes({ STELLAR_NETWORK: value })).toEqual(["invalid_network"]);
        expect(codes({ NEXT_PUBLIC_STELLAR_NETWORK: value })).toEqual(["invalid_network"]);
      },
    );

    it.each([
      ["bad checksum", BAD_CHECKSUM_ISSUER],
      ["secret seed", Keypair.random().secret()],
      ["too short", "GABC"],
      ["lowercase", TESTNET_ISSUER.toLowerCase()],
      ["contract id", "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"],
    ])("rejects issuer that is %s", (_label, value) => {
      expect(codes({ STELLAR_USDC_ISSUER: value })).toEqual(["invalid_issuer"]);
    });

    it("never echoes a full malformed value back in the message", () => {
      const seed = Keypair.random().secret();
      const result = validateStellarAssetConfig({ STELLAR_USDC_ISSUER: seed });
      expect(result.ok).toBe(false);
      const text = JSON.stringify(result);
      expect(text).not.toContain(seed);
      expect(text).toContain("STELLAR_USDC_ISSUER");
    });

    it("reports every problem at once instead of stopping at the first", () => {
      expect(
        codes({
          STELLAR_NETWORK: "testnet",
          NEXT_PUBLIC_STELLAR_USDC_ISSUER: "not-a-key",
          STELLAR_USDC_ISSUER: BAD_CHECKSUM_ISSUER,
        }),
      ).toEqual(["invalid_issuer", "invalid_issuer", "issuer_conflict"]);
    });
  });

  describe("mismatched pairs", () => {
    it("rejects the mainnet issuer on testnet", () => {
      expect(codes({ STELLAR_USDC_ISSUER: MAINNET_ISSUER })).toEqual([
        "issuer_network_mismatch",
      ]);
    });

    it("rejects the testnet issuer on mainnet", () => {
      expect(
        codes({ STELLAR_NETWORK: "mainnet", NEXT_PUBLIC_STELLAR_USDC_ISSUER: TESTNET_ISSUER }),
      ).toEqual(["issuer_network_mismatch"]);
    });

    it("rejects the testnet issuer on mainnet even with the custom-issuer opt-in", () => {
      expect(
        codes({
          STELLAR_NETWORK: "mainnet",
          STELLAR_USDC_ISSUER: TESTNET_ISSUER,
          STELLAR_ALLOW_CUSTOM_USDC_ISSUER: "true",
        }),
      ).toEqual(["issuer_network_mismatch"]);
    });

    it("rejects a custom mainnet issuer without the opt-in", () => {
      expect(codes({ STELLAR_NETWORK: "mainnet", STELLAR_USDC_ISSUER: CUSTOM_ISSUER })).toEqual([
        "unrecognized_mainnet_issuer",
      ]);
    });

    it.each(["1", "yes", "TRUE", "false"])(
      "only accepts the literal opt-in value true (got %j)",
      (flag) => {
        expect(
          codes({
            STELLAR_NETWORK: "mainnet",
            STELLAR_USDC_ISSUER: CUSTOM_ISSUER,
            STELLAR_ALLOW_CUSTOM_USDC_ISSUER: flag,
          }),
        ).toEqual(["unrecognized_mainnet_issuer"]);
      },
    );

    it("rejects public and server networks that disagree", () => {
      expect(
        codes({ NEXT_PUBLIC_STELLAR_NETWORK: "mainnet", STELLAR_NETWORK: "testnet" }),
      ).toEqual(["network_conflict"]);
    });

    it("rejects public and server issuers that disagree", () => {
      expect(
        codes({
          NEXT_PUBLIC_STELLAR_USDC_ISSUER: TESTNET_ISSUER,
          STELLAR_USDC_ISSUER: CUSTOM_ISSUER,
        }),
      ).toEqual(["issuer_conflict"]);
    });
  });
});

describe("resolveStellarAssetConfig", () => {
  it("returns the config for valid input", () => {
    expect(resolveStellarAssetConfig({}).usdcIssuer).toBe(TESTNET_ISSUER);
  });

  it("throws a StellarConfigError listing every issue", () => {
    let error: unknown;
    try {
      resolveStellarAssetConfig({ STELLAR_NETWORK: "mainnet", STELLAR_USDC_ISSUER: TESTNET_ISSUER });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StellarConfigError);
    const configError = error as StellarConfigError;
    expect(configError.issues.map((issue) => issue.code)).toEqual(["issuer_network_mismatch"]);
    expect(configError.message).toContain("[issuer_network_mismatch]");
    expect(configError.message).toContain("STELLAR_USDC_ISSUER");
  });
});

describe("stellar-config module load (startup)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("exports the validated network, passphrase and issuer", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "mainnet");
    vi.stubEnv("STELLAR_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_USDC_ISSUER", "");
    vi.stubEnv("STELLAR_USDC_ISSUER", "");
    vi.resetModules();

    const mod = await import("../src/lib/stellar-config");
    expect(mod.STELLAR_NETWORK).toBe("mainnet");
    expect(mod.STELLAR_NETWORK_PASSPHRASE).toBe(Networks.PUBLIC);
    expect(mod.USDC_ISSUER).toBe(MAINNET_ISSUER);
  });

  it("fails to load when the issuer does not match the network", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "");
    vi.stubEnv("STELLAR_NETWORK", "mainnet");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_USDC_ISSUER", "");
    vi.stubEnv("STELLAR_USDC_ISSUER", TESTNET_ISSUER);
    vi.resetModules();

    await expect(import("../src/lib/stellar-config")).rejects.toThrow(/issuer_network_mismatch/);
  });

  it("keeps lib/stellar.ts in sync with the validated config", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "mainnet");
    vi.stubEnv("STELLAR_NETWORK", "");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_USDC_ISSUER", "");
    vi.stubEnv("STELLAR_USDC_ISSUER", "");
    vi.resetModules();

    const stellar = await import("../src/lib/stellar");
    expect(stellar.getNetworkPassphrase()).toBe(Networks.PUBLIC);
    expect(stellar.getUSDCIssuer()).toBe(MAINNET_ISSUER);
  });

  it("instrumentation register() rejects invalid config on the nodejs runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public");
    vi.resetModules();

    const { register } = await import("../src/instrumentation");
    await expect(register()).rejects.toThrow(/invalid_network/);
  });

  it("instrumentation register() is a no-op on the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public");
    vi.resetModules();

    const { register } = await import("../src/instrumentation");
    await expect(register()).resolves.toBeUndefined();
  });
});
