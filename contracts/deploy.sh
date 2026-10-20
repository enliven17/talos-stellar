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

usage() {
  echo "Usage: $0 [testnet|mainnet] [--source <key-name>]" >&2
}

NETWORK="testnet"
SOURCE="deployer"  # default key name in stellar keys store

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      if [[ $# -lt 2 ]]; then
        echo "✗  --source requires a value" >&2
        usage
        exit 1
      fi
      SOURCE="$2"
      shift 2
      ;;
    testnet|mainnet)
      NETWORK="$1"
      shift
      ;;
    *)
      echo "✗  Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# DRY_RUN=1 prints the resolved network/source and exits, without building
# or touching the network. Used by scripts/deploy.test.sh.
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "NETWORK=$NETWORK"
  echo "SOURCE=$SOURCE"
  exit 0
fi

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
echo "▶  Initializing TalosNameService with TalosRegistry address..."
stellar contract invoke \
  --id "$NAME_SERVICE_ID" \
  --network "$NETWORK" \
  --source "$SOURCE" \
  -- \
  initialize \
  --registry_id "$REGISTRY_ID"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  Add these to web/.env.local:"
echo ""
echo "  NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=$REGISTRY_ID"
echo "  NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=$NAME_SERVICE_ID"
echo "═══════════════════════════════════════════════════════"
