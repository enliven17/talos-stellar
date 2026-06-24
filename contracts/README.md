# Talos Protocol — Soroban Smart Contracts

Stellar-based smart contracts for the Talos Protocol, built with Rust and the Soroban SDK.

## Contracts

### 1. TalosRegistry
- **Purpose**: Creates and manages Talos entities on-chain
- **Features**:
  - Talos creation with metadata (name, category, description)
  - Patron configuration (creator/investor/treasury shares)
  - Kernel policy management (approval thresholds, GTM budget)
  - Pulse token metadata storage
  - 3% protocol fee to protocol wallet on creation
  - Events: `talos_created`, `patron_updated`

### 2. TalosNameService
- **Purpose**: Human-readable name registration for Talos IDs
- **Features**:
  - Name → Talos ID mapping (e.g., "marketbot" → 42)
  - Validation: 3-32 chars, lowercase alphanumeric + hyphens
  - No consecutive hyphens allowed
  - Events: `name_registered`

## Prerequisites

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Install Soroban CLI
cargo install --locked soroban-cli

# Install wasm-opt for optimization
cargo install wasm-opt
```

## Build

```bash
# Build all contracts
pnpm build

# Build individual contracts
pnpm build:registry
pnpm build:name-service
```

## Deploy to Stellar Testnet

```bash
# Setup testnet identity
soroban keys generate --network testnet mykey

# Deploy TalosRegistry
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/talos_registry.wasm \
  --source-account mykey \
  --network testnet

# Deploy TalosNameService
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/talos_name_service.wasm \
  --source-account mykey \
  --network testnet

# Initialize TalosRegistry (set protocol wallet)
soroban contract invoke \
  --id <REGISTRY_CONTRACT_ID> \
  --source-account mykey \
  --network testnet \
  -- \
  initialize \
  --protocol_wallet <PROTOCOL_WALLET_ADDRESS>
```

## Invoke Examples

```bash
# Create a Talos
soroban contract invoke \
  --id <REGISTRY_CONTRACT_ID> \
  --source-account mykey \
  --network testnet \
  -- \
  create_talos \
  --name "MyAgent" \
  --category "Marketing" \
  --description "AI marketing agent" \
  --patron '{"creator_share": 60, "investor_share": 25, "treasury_share": 15, "creator_addr": "G...", "investor_addr": "G...", "treasury_addr": "G..."}' \
  --kernel '{"approval_threshold": 1000, "gtm_budget": 20000, "min_patron_pulse": 1000}' \
  --pulse '{"total_supply": 1000000, "price_usd_cents": 250, "token_symbol": "AGNT"}' \
  --protocol_wallet "G..."

# Register a name (the owner address must authorize the transaction)
soroban contract invoke \
  --id <NAME_SERVICE_CONTRACT_ID> \
  --source-account mykey \
  --network testnet \
  -- \
  register_name \
  --owner <OWNER_STELLAR_ADDRESS> \
  --talos_id 1 \
  --name "myagent"

# Resolve a name
soroban contract invoke \
  --id <NAME_SERVICE_CONTRACT_ID> \
  --source-account mykey \
  --network testnet \
  -- \
  resolve_name \
  --name "myagent"
```

## Project Structure

```
contracts/
├── Cargo.toml                      # Workspace config
├── soroban-config.toml             # Soroban deployment config
├── talos_registry/
│   ├── Cargo.toml
│   └── src/
│       └── lib.rs                  # TalosRegistry contract
└── talos_name_service/
    ├── Cargo.toml
    └── src/
        └── lib.rs                  # TalosNameService contract
```

## Testing

From the `contracts/` workspace:

```bash
cd contracts
rustup target add wasm32-unknown-unknown

# Run all contract unit tests on the host test runtime
cargo test

# CI also checks the wasm target requested by the contracts workflow
cargo test --target wasm32-unknown-unknown

# Build optimized WASM artifacts for deployment
cargo build --target wasm32-unknown-unknown --release

# Run with output when debugging
cargo test -- --nocapture
```

The test suites live in each contract's `#[cfg(test)] mod tests` block and cover happy paths, duplicate/error cases, authorization requirements, and registry fee calculation.

## License

MIT
