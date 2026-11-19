#!/usr/bin/env node
/**
 * verify-contracts-readme.test.mjs
 *
 * Verifies that contracts/README.md accurately documents TalosGovernance and
 * TalosDividends according to pub fn signatures, event schemas, error types,
 * and configuration constants.
 *
 * Run locally:
 *   node --test scripts/verify-contracts-readme.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");
const readmePath = resolve(rootDir, "contracts", "README.md");
const governanceSrcPath = resolve(rootDir, "contracts", "talos_governance", "src", "lib.rs");
const dividendsSrcPath = resolve(rootDir, "contracts", "talos_dividends", "src", "lib.rs");

describe("Contracts README Documentation Verification", () => {
  const readmeContent = readFileSync(readmePath, "utf-8");
  const governanceSrc = readFileSync(governanceSrcPath, "utf-8");
  const dividendsSrc = readFileSync(dividendsSrcPath, "utf-8");

  it("documents Sections 3 (TalosGovernance) and 4 (TalosDividends) under Contracts", () => {
    assert.ok(
      readmeContent.includes("### 3. TalosGovernance"),
      "README must contain '### 3. TalosGovernance'"
    );
    assert.ok(
      readmeContent.includes("### 4. TalosDividends"),
      "README must contain '### 4. TalosDividends'"
    );
  });

  it("documents all TalosGovernance pub fn entry points from lib.rs", () => {
    // Extract pub fn names within `impl TalosGovernance`
    const implBlockMatch = governanceSrc.match(
      /impl TalosGovernance\s*\{([\s\S]*?)\n\}\s*(?:#\[cfg\(test\)\]|\nimpl)/
    );
    assert.ok(implBlockMatch, "Failed to match impl TalosGovernance block");
    const implBlock = implBlockMatch[1];

    const pubFnMatches = Array.from(implBlock.matchAll(/pub fn ([a-zA-Z0-9_]+)\s*\(/g)).map(
      (m) => m[1]
    );
    assert.ok(pubFnMatches.length >= 15, "Expected at least 15 pub fn entry points in TalosGovernance");

    for (const fnName of pubFnMatches) {
      assert.ok(
        readmeContent.includes(fnName),
        `README is missing documentation for TalosGovernance entry point: ${fnName}`
      );
    }
  });

  it("documents all TalosDividends pub fn entry points from lib.rs", () => {
    // Extract pub fn names within `impl TalosDividends`
    const implBlockMatch = dividendsSrc.match(
      /impl TalosDividends\s*\{([\s\S]*?)\n\}\s*(?:\/\/ ── Tests|#\[cfg\(test\)\])/
    );
    assert.ok(implBlockMatch, "Failed to match impl TalosDividends block");
    const implBlock = implBlockMatch[1];

    const pubFnMatches = Array.from(implBlock.matchAll(/pub fn ([a-zA-Z0-9_]+)\s*\(/g)).map(
      (m) => m[1]
    );
    assert.ok(pubFnMatches.length >= 10, "Expected at least 10 pub fn entry points in TalosDividends");

    for (const fnName of pubFnMatches) {
      assert.ok(
        readmeContent.includes(fnName),
        `README is missing documentation for TalosDividends entry point: ${fnName}`
      );
    }
  });

  it("documents governance config parameters", () => {
    const configParams = [
      "quorum_threshold",
      "consensus_threshold",
      "voting_period_ledgers",
      "pulse_token_address",
    ];

    for (const param of configParams) {
      assert.ok(
        readmeContent.includes(param),
        `README is missing governance config parameter: ${param}`
      );
    }
  });

  it("documents dividend claim windows and expiry bounds", () => {
    assert.ok(
      readmeContent.includes("MIN_EXPIRY_SECS"),
      "README is missing MIN_EXPIRY_SECS"
    );
    assert.ok(
      readmeContent.includes("MAX_EXPIRY_SECS"),
      "README is missing MAX_EXPIRY_SECS"
    );
    assert.ok(
      readmeContent.includes("3_600"),
      "README is missing 3_600 seconds bound"
    );
    assert.ok(
      readmeContent.includes("31_536_000"),
      "README is missing 31_536_000 seconds bound"
    );
  });

  it("documents all TalosGovernance and TalosDividends events", () => {
    const events = [
      "prop_crt",
      "vote",
      "prop_stat",
      "qrm_rchd",
      "div_snap",
      "ep_cmt",
      "div_clm",
      "div_dst",
      "ep_rcv",
    ];

    for (const eventName of events) {
      assert.ok(
        readmeContent.includes(eventName),
        `README is missing event: ${eventName}`
      );
    }
  });

  it("documents all 16 TalosDividends ContractError variants", () => {
    const errorVariants = [
      "AlreadyInitialized",
      "NotInitialized",
      "Unauthorized",
      "EpochNotFound",
      "AlreadyClaimed",
      "EpochExpired",
      "EpochNotExpired",
      "ZeroAllocation",
      "InvalidEpochParams",
      "NotAPatron",
      "Overflow",
      "EpochAlreadyExists",
      "TalosNotFound",
      "AccountingOverflow",
      "AlreadyRecovered",
      "InvalidPatronShares",
    ];

    for (const variant of errorVariants) {
      assert.ok(
        readmeContent.includes(variant),
        `README is missing ContractError variant: ${variant}`
      );
    }
  });

  it("provides testnet invoke examples with placeholder IDs and no real secret keys", () => {
    assert.ok(
      readmeContent.includes("<GOVERNANCE_CONTRACT_ID>"),
      "Invoke examples must contain <GOVERNANCE_CONTRACT_ID>"
    );
    assert.ok(
      readmeContent.includes("<DIVIDENDS_CONTRACT_ID>"),
      "Invoke examples must contain <DIVIDENDS_CONTRACT_ID>"
    );
    assert.ok(
      readmeContent.includes("<ADMIN_STELLAR_ADDRESS>"),
      "Invoke examples must contain <ADMIN_STELLAR_ADDRESS>"
    );
    assert.ok(
      readmeContent.includes("<PROPOSER_STELLAR_ADDRESS>"),
      "Invoke examples must contain <PROPOSER_STELLAR_ADDRESS>"
    );
    assert.ok(
      readmeContent.includes("<VOTER_STELLAR_ADDRESS>"),
      "Invoke examples must contain <VOTER_STELLAR_ADDRESS>"
    );
    assert.ok(
      readmeContent.includes("<CLAIMANT_STELLAR_ADDRESS>"),
      "Invoke examples must contain <CLAIMANT_STELLAR_ADDRESS>"
    );

    const invokeSection = readmeContent.slice(readmeContent.indexOf("## Invoke Examples"));
    assert.doesNotMatch(
      invokeSection,
      /--source S[A-Z0-9]{55}/,
      "Invoke examples must not contain real secret keys"
    );
  });
});
