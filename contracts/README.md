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

### 3. TalosGovernance
- **Purpose**: Token-weighted governance for Talos Protocol
- **Features**:
  - Proposal creation for Talos governance decisions
  - Token-weighted voting based on Pulse token holdings
  - Snapshot-based vote weight calculation (balances at proposal creation)
  - Quorum and consensus-based proposal approval/rejection
  - Configurable voting periods and thresholds
  - Events: `proposal_created`, `vote_cast`, `proposal_status_changed`

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

## Deployment Guide

### Step 1: Environment Setup

Before deploying, ensure all prerequisites are installed and configured:

```bash
# 1. Install/update Rust and WASM target
rustup update
rustup target add wasm32-unknown-unknown

# 2. Install Stellar CLI (replaces soroban-cli)
cargo install --locked stellar-cli --features opt

# 3. Create a Stellar keypair for the deployer account
stellar keys generate --network testnet deployer

# 4. Fund the deployer account
# Visit: https://lab.stellar.org (testnet) or contact Stellar support (mainnet)
# Ensure the account has enough XLM (~2-5 XLM for deployment gas)

# 5. (Optional) Set environment variables
export STELLAR_NETWORK=testnet  # or mainnet
export STELLAR_ACCOUNT_ID=<your-deployer-public-key>  # G...
export TALOS_PROTOCOL_WALLET=<protocol-wallet-public-key>  # G...
```

### Step 2: Build Contracts

From the `contracts/` directory:

```bash
cd contracts

# Build all contracts in release mode (optimized for WASM)
cargo build --target wasm32-unknown-unknown --release

# Output location:
# - target/wasm32-unknown-unknown/release/talos_registry.wasm
# - target/wasm32-unknown-unknown/release/talos_name_service.wasm
```

**Testnet vs Mainnet**: The `--network` flag in deployment commands switches targets:
- **Testnet** (`--network testnet`): Test environment, free XLM from friendbot, instant finality
- **Mainnet** (`--network mainnet`): Production environment, real XLM costs, canonical ledger

### Step 3: Deploy Contracts

Option A: Manual Deployment (full control)

```bash
# Deploy TalosRegistry
REGISTRY_CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/talos_registry.wasm \
  --network testnet \
  --source deployer)
echo "TalosRegistry: $REGISTRY_CONTRACT"

# Deploy TalosNameService  
NAME_SERVICE_CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/talos_name_service.wasm \
  --network testnet \
  --source deployer)
echo "TalosNameService: $NAME_SERVICE_CONTRACT"

# Initialize TalosNameService with TalosRegistry address
stellar contract invoke \
  --id "$NAME_SERVICE_CONTRACT" \
  --network testnet \
  --source deployer \
  -- \
  initialize \
  --registry_id "$REGISTRY_CONTRACT"
```

Option B: Automated Deployment (recommended)

```bash
# Run the deployment script from contracts/ directory
./deploy.sh testnet --source deployer

# The script will:
# 1. Build contracts in release mode
# 2. Deploy both contracts
# 3. Initialize TalosNameService
# 4. Output environment variable assignments
```

### Step 4: Post-Deployment Configuration

After deployment, save the contract IDs to your configuration:

```bash
# Add to web/.env.local:
NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=C...
NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=C...

# Also add to contracts/.env if deploying from contracts/:
TALOS_REGISTRY_CONTRACT=C...
TALOS_NAME_SERVICE_CONTRACT=C...
TALOS_PROTOCOL_WALLET=G...  # Receives protocol fees
```

### Step 5: Verify Deployment

Confirm contracts are deployed and initialized:

```bash
# Check TalosRegistry exists and returns next ID
stellar contract invoke \
  --id "$REGISTRY_CONTRACT" \
  --network testnet \
  -- \
  next_talos_id

# Expected output: 0 (no Talos created yet)

# Check TalosNameService is initialized
stellar contract invoke \
  --id "$NAME_SERVICE_CONTRACT" \
  --network testnet \
  -- \
  is_name_available \
  --name myagent

# Expected output: true (no names registered yet)
```

### Environment Variables Reference

| Variable | Format | Purpose | Example |
|----------|--------|---------|---------|
| `STELLAR_ACCOUNT_ID` | G-address | Deployer public key | `GBZLPFCWX4QIZTJQ6QXRZ...` |
| `STELLAR_SECRET_KEY` | S-key | Deployer secret key (deploy only, never commit) | `SBZVYK6IXGLZ...` |
| `TALOS_PROTOCOL_WALLET` | G-address | Receives 3% protocol fee on Talos creation | `GA3HQZTKR4U...` |
| `NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT` | C-address | TalosRegistry contract ID | `CBZLPFCWX4QIZ...` |
| `NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT` | C-address | TalosNameService contract ID | `CBZLPFCWX4QIZ...` |

### Deployment Checklist

- [ ] Rust toolchain installed: `rustc --version`
- [ ] WASM target installed: `rustup target list --installed | grep wasm32`
- [ ] Stellar CLI installed: `stellar --version`
- [ ] Deployer keypair created: `stellar keys ls`
- [ ] Deployer account has XLM: `stellar account info --source deployer --network testnet`
- [ ] Contracts build successfully: `cargo build --target wasm32-unknown-unknown --release`
- [ ] WASM files exist: `ls target/wasm32-unknown-unknown/release/*.wasm`
- [ ] TalosRegistry deployed: `stellar contract info --id <REGISTRY_ID> --network testnet`
- [ ] TalosNameService initialized: `stellar contract invoke --id <NAME_SERVICE_ID> -- next_talos_id`
- [ ] Contract IDs added to `.env.local`

### Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "Signature verification failed" | Wrong network | Verify `--network testnet\|mainnet` matches keypair |
| "Account not found" | Deployer unfunded | Fund via lab.stellar.org or friendbot |
| "Build failed" | Missing WASM target | Run `rustup target add wasm32-unknown-unknown` |
| "Contract not initialized" | TalosNameService init skipped | Run initialize command with registry_id |
| "WASM too large" | Optimization issue | Run release build only: `--release` flag |

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

## Event Schema

Both contracts emit typed Soroban events on every meaningful state change. Off-chain consumers (dashboards, indexers, Stellar Expert) can subscribe using topic filters.

### TalosRegistry

| Event | Topics | Data | Emitted on |
|-------|--------|------|-----------|
| `tls_crt` | `(symbol_short!("tls_crt"), creator: Address)` | `(talos_id: u32, name: String, category: String)` | `create_talos` success |
| `pat_upd` | `(symbol_short!("pat_upd"), talos_id: u32)` | `(creator: Address, creator_share: u32, investor_share: u32)` | `update_patron` success |
| `fee_chg` | `(symbol_short!("fee_chg"),)` | `(old_bps: u32, new_bps: u32)` | `set_protocol_fee` success |

**Filtering examples**

```rust
// All Talos created by a specific address — filter on topics[1] == creator
(symbol_short!("tls_crt"), creator_address)

// All patron updates for a specific Talos — filter on topics[1] == talos_id
(symbol_short!("pat_upd"), 42u32)

// Any protocol fee change — filter on topics[0] == "fee_chg"
(symbol_short!("fee_chg"),)
```

### TalosNameService

| Event | Topics | Data | Emitted on |
|-------|--------|------|-----------|
| `name_reg` | `(symbol_short!("name_reg"), talos_id: u32)` | `(name: String, owner: Address)` | `register_name` success |

**Filtering examples**

```rust
// Name registration for a specific Talos — filter on topics[1] == talos_id
(symbol_short!("name_reg"), 42u32)
```

### Design rationale

- The first topic is always the event-type symbol so generic listeners can dispatch on it.
- Filterable entities (creator, talos_id) are placed in subsequent topic slots so Soroban's topic-indexed subscriptions can narrow results without fetching all events.
- Event data carries the full context needed to act without a follow-up RPC call.

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
