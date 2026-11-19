# x402 Payment Fixtures

This directory contains deterministic XDR fixtures for testing x402 payment verification without relying on a live Stellar network.

## Fixtures:
- **valid.json**: Valid USDC payment with correct amount, recipient, and issuer. (Expects: Valid)
- **invalid-asset.json**: Invalid asset code (FAKE instead of USDC). (Expects: issuer/asset)
- **invalid-issuer.json**: Correct asset code (USDC) but incorrect issuer (Attacker). (Expects: issuer/asset)
- **invalid-recipient.json**: Incorrect recipient destination. (Expects: recipient)
- **invalid-amount.json**: Amount less than expected. (Expects: amount)
- **invalid-network.json**: Valid payment but signed for MAINNET instead of TESTNET. (Expects: network)
- **missing-ops.json**: Transaction with no operations. (Expects: missing-operation)

## Required Fields for verification:
- **Expected Amount**: `10.00`
- **Expected Recipient**: `GCEFRNTKTNYOS7QFQ7USU57N3NZZA65FXAVGA2WKFYJGKQZSM5WNAKRL`

To regenerate, modify the generation script or create a new mock transaction and save the XDR as a JSON object containing `{ "xdr": "..." }`.
