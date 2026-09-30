// To run this test locally: node --test scripts/parse-issue-metadata.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { parseIssueMetadata } from "./parse-issue-metadata.mjs";

test("successfully parses valid contributor metadata", () => {
  const markdown = `
### GitHub Handle

octocat

### Stellar Wallet Address

GA123456789012345678901234567890123456789012345678901234

### Primary Role

Developer
`;
  const result = parseIssueMetadata(markdown);
  assert.deepEqual(result, {
    githubHandle: "octocat",
    stellarWallet: "GA123456789012345678901234567890123456789012345678901234",
    primaryRole: "Developer"
  });
});

test("fails if input is missing required fields", () => {
  const markdown = `
### GitHub Handle

octocat
`;
  assert.throws(() => parseIssueMetadata(markdown), /Parsing failed: Missing required metadata field\./);
});

test("fails on malformed GitHub handle", () => {
  const markdown = `
### GitHub Handle

@octocat

### Stellar Wallet Address

GA123456789012345678901234567890123456789012345678901234

### Primary Role

Developer
`;
  assert.throws(() => parseIssueMetadata(markdown), /Parsing failed: Malformed input for GitHub handle\./);
});

test("fails on invalid wallet length or characters", () => {
  const markdown = `
### GitHub Handle

octocat

### Stellar Wallet Address

GBCV04CONTRIB000000000000000000000

### Primary Role

Developer
`;
  assert.throws(() => parseIssueMetadata(markdown), /Parsing failed: Malformed input for wallet address\./);
});

test("fails on invalid role", () => {
  const markdown = `
### GitHub Handle

octocat

### Stellar Wallet Address

GA123456789012345678901234567890123456789012345678901234

### Primary Role

CEO
`;
  assert.throws(() => parseIssueMetadata(markdown), /Parsing failed: Invalid role selected\./);
});

test("fails closed on ambiguous/extra fields", () => {
  const markdown = `
### GitHub Handle

octocat

### Stellar Wallet Address

GA123456789012345678901234567890123456789012345678901234

### Primary Role

Developer

### Secret Field

MySecretSeedPhrase
`;
  assert.throws(() => parseIssueMetadata(markdown), /Parsing failed: Ambiguous inputs or unrecognized fields present\./);
});

test("does not expose input in error messages", () => {
  const markdown = `
### GitHub Handle

octocat

### Stellar Wallet Address

invalid-wallet-string-that-might-be-a-secret
  
### Primary Role

Developer
`;
  try {
    parseIssueMetadata(markdown);
    assert.fail("Should have thrown");
  } catch (err) {
    assert.equal(err.message, "Parsing failed: Malformed input for wallet address.");
    assert.ok(!err.message.includes("invalid-wallet-string"));
  }
});
