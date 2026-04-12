#!/usr/bin/env bash
# ─── Talos Protocol — Soroban Contract Deploy ─────────────────────────────────
# Usage: ./deploy.sh [testnet|mainnet] [--source <key-name>]
#
# Prerequisites:
#   1. Rust + wasm32 target: rustup target add wasm32-unknown-unknown
#   2. Stellar CLI: cargo install --locked stellar-cli --features opt
#   3. A funded Stellar keypair configured: stellar keys generate deployer --network testnet
#
# The script prints the two contract IDs you must add to .env.local:
#   NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=C...
#   NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=C...

set -euo pipefail

NETWORK="${1:-testnet}"
SOURCE="${3:-deployer}"  # default key name in stellar keys store

# Detect --source flag
for i in "$@"; do
  case $i in
    --source) SOURCE="${@:$((${#@}+1))}";;  # next arg
  esac
done

echo "▶  Building Soroban contracts (release)..."
cargo build --target wasm32-unknown-unknown --release 2>&1 | tail -5

REGISTRY_WASM="target/wasm32-unknown-unknown/release/talos_registry.wasm"
NAME_SERVICE_WASM="target/wasm32-unknown-unknown/release/talos_name_service.wasm"

if [[ ! -f "$REGISTRY_WASM" ]]; then
  echo "✗  Build failed — $REGISTRY_WASM not found"
  exit 1
fi

echo ""
echo "▶  Deploying TalosRegistry to $NETWORK..."
REGISTRY_ID=$(stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --network "$NETWORK" \
  --source "$SOURCE")

echo "   TalosRegistry:    $REGISTRY_ID"

echo ""
echo "▶  Deploying TalosNameService to $NETWORK..."
NAME_SERVICE_ID=$(stellar contract deploy \
  --wasm "$NAME_SERVICE_WASM" \
  --network "$NETWORK" \
  --source "$SOURCE")

echo "   TalosNameService: $NAME_SERVICE_ID"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Add these to web/.env.local:"
echo ""
echo "  NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=$REGISTRY_ID"
echo "  NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=$NAME_SERVICE_ID"
echo "═══════════════════════════════════════════════════════"
