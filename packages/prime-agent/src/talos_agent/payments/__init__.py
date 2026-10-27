USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
USDC_MAINNET_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"

CANONICAL_USDC_ISSUERS: dict[str, str] = {
    "testnet": USDC_TESTNET_ISSUER,
    "mainnet": USDC_MAINNET_ISSUER,
}

# Number of decimal places USDC amounts are expressed in on-chain. Money is
# moved as integer smallest units (1 USDC == 1_000_000 units), so this value
# defines both the accepted price precision and the conversion scale.
# Shared by price parsing (tools/commerce.py) and the x402 signer so the two
# can never drift apart on what "amount" means.
USDC_DECIMALS: int = 6

# Multiplier turning a USDC decimal price into smallest units.
USDC_UNIT_SCALE: int = 10**USDC_DECIMALS

__all__ = [
    "CANONICAL_USDC_ISSUERS",
    "USDC_DECIMALS",
    "USDC_MAINNET_ISSUER",
    "USDC_TESTNET_ISSUER",
    "USDC_UNIT_SCALE",
]

