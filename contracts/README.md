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

Before deploying, ensure you have:

### 1. Install Rust & Stellar Development Tools

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Add WebAssembly target
rustup target add wasm32-unknown-unknown

# Install Soroban CLI (latest stable)
cargo install --locked stellar-cli --features opt

# Verify installation
stellar --version
stellar contract --help
```

### 2. Setup Stellar Keys & Accounts

```bash
# Generate a keypair for testnet deployment
stellar keys generate --network testnet deployer

# Fund the account from Friendbot (testnet only)
# Get your public key first:
stellar keys show deployer --network testnet

# Visit https://laboratory.stellar.org/#account-creator?network=testnet
# Or use curl:
curl -X GET "https://friendbot.stellar.org/?addr=$(stellar keys show deployer --network testnet)"

# Verify funding
stellar account info deployer --network testnet
```

### 3. Configure Environment Variables

Create or update `contracts/soroban-config.toml`:

```toml
[network]
rpc_url = "https://soroban-testnet.stellar.org"
network_passphrase = "Test SDF Network ; September 2015"

[build]
optimization_level = "z"
```

## Build

```bash
# Build all contracts
pnpm build

# Build individual contracts
pnpm build:registry
pnpm build:name-service

# Verify WASM files were created
ls -lh target/wasm32-unknown-unknown/release/*.wasm
```

## Deploy: Step-by-Step

### Using the Deploy Script (Recommended)

```bash
cd contracts

# Deploy to testnet (interactive prompt for key selection)
./deploy.sh testnet

# Deploy to mainnet (production — requires funded mainnet account)
./deploy.sh mainnet --source deployer
```

The script outputs contract IDs. Save these to `web/.env.local`:

```env
NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

### Manual Deployment (Step-by-Step)

#### Step 1: Build Contracts

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

#### Step 2: Deploy TalosRegistry

```bash
export REGISTRY_WASM="target/wasm32-unknown-unknown/release/talos_registry.wasm"
export NETWORK="testnet"
export SOURCE_KEY="deployer"

REGISTRY_ID=$(stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --network "$NETWORK" \
  --source "$SOURCE_KEY")

echo "Registry Contract ID: $REGISTRY_ID"
```

#### Step 3: Deploy TalosNameService

```bash
export NAME_SERVICE_WASM="target/wasm32-unknown-unknown/release/talos_name_service.wasm"

NAME_SERVICE_ID=$(stellar contract deploy \
  --wasm "$NAME_SERVICE_WASM" \
  --network "$NETWORK" \
  --source "$SOURCE_KEY")

echo "Name Service Contract ID: $NAME_SERVICE_ID"
```

#### Step 4: Initialize TalosRegistry

```bash
stellar contract invoke \
  --id "$REGISTRY_ID" \
  --source "$SOURCE_KEY" \
  --network "$NETWORK" \
  -- \
  initialize \
  --protocol_wallet "G$(stellar keys show --network "$NETWORK" "$SOURCE_KEY" --public-key)"
```

## Testnet vs. Mainnet

| Aspect | Testnet | Mainnet |
|---|---|---|
| **Network ID** | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| **RPC Endpoint** | `https://soroban-testnet.stellar.org` | `https://soroban-mainnet.stellar.org` |
| **Funding** | Use Friendbot (free testnet faucet) | Real XLM required (paid) |
| **Contract State** | Resets periodically; non-production | Permanent; production data |
| **Deployment Risk** | Low; for testing | High; requires careful auditing |
| **Gas Costs** | Free (test lumens) | Real cost (mainnet XLM) |

### Testnet Deployment

```bash
# Generate and fund testnet key
stellar keys generate --network testnet deployer
curl -X GET "https://friendbot.stellar.org/?addr=$(stellar keys show deployer --network testnet)"

# Deploy
./deploy.sh testnet --source deployer
```

### Mainnet Deployment

⚠️ **Before deploying to mainnet:**
1. Audit contract code thoroughly
2. Test against mainnet-config in a staging environment
3. Ensure the deployment account holds sufficient XLM for gas fees
4. Verify contract IDs before adding to production `.env`

```bash
# Requires a funded mainnet key (real XLM)
# Mainnet keys should be stored in secure key management (e.g., hardware wallet integration)
./deploy.sh mainnet --source production_deployer
```

## Post-Deployment Verification

### 1. Verify Contract Deployment

```bash
# Check if contract exists on-chain
stellar contract info --id "$REGISTRY_ID" --network testnet

# Should return contract metadata and wasm hash
```

### 2. Query Contract State

```bash
# Check initialization status (if contract has state queries)
stellar contract invoke \
  --id "$REGISTRY_ID" \
  --network testnet \
  -- \
  get_protocol_wallet
```

### 3. Create Test Talos (TalosRegistry)

```bash
stellar contract invoke \
  --id "$REGISTRY_ID" \
  --source deployer \
  --network testnet \
  -- \
  create_talos \
  --name "Test Agent" \
  --category "Development" \
  --description "Test Talos for verification" \
  --patron '{
    "creator_share": 60,
    "investor_share": 25,
    "treasury_share": 15,
    "creator_addr": "G<YOUR_PUBLIC_KEY>",
    "investor_addr": "G<YOUR_PUBLIC_KEY>",
    "treasury_addr": "G<YOUR_PUBLIC_KEY>"
  }' \
  --kernel '{
    "approval_threshold": 1000,
    "gtm_budget": 20000,
    "min_patron_pulse": 1000
  }' \
  --pulse '{
    "total_supply": 1000000,
    "price_usd_cents": 250,
    "token_symbol": "TEST"
  }' \
  --protocol_wallet "G<YOUR_PUBLIC_KEY>"
```

### 4. Test Name Registration (TalosNameService)

```bash
# Register a name
stellar contract invoke \
  --id "$NAME_SERVICE_ID" \
  --source deployer \
  --network testnet \
  -- \
  register_name \
  --talos_id 1 \
  --name "testagent"

# Resolve the name (should return talos_id 1)
stellar contract invoke \
  --id "$NAME_SERVICE_ID" \
  --network testnet \
  -- \
  resolve_name \
  --name "testagent"

# Check if name is available (should return false after registration)
stellar contract invoke \
  --id "$NAME_SERVICE_ID" \
  --network testnet \
  -- \
  is_name_available \
  --name "testagent"
```

### 5. Verify Events

Check the Stellar Expert explorer for contract events:
- **Testnet**: `https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>`
- **Mainnet**: `https://stellar.expert/explorer/public/contract/<CONTRACT_ID>`

Look for:
- `talos_created` event with name and creator
- `name_registered` event with talos_id and name

## Integration with Web App

Once contracts are deployed and verified, add the contract IDs to the web app:

```bash
# web/.env.local
NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT=CXXXXXXXXX
NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT=CXXXXXXXXX
NEXT_PUBLIC_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NEXT_PUBLIC_SOROBAN_NETWORK=testnet
```

Then update `web/src/lib/soroban.ts` to use these contract IDs when invoking contract functions.

## Troubleshooting

| Issue | Solution |
|---|---|
| "Account does not exist" | Fund account with Friendbot or testnet XLM |
| "Insufficient balance for transaction fee" | Account needs more XLM; use Friendbot |
| "Invalid network passphrase" | Ensure `--network testnet` or `--network mainnet` matches config |
| "WASM hash mismatch" | Rebuild contracts: `cargo clean && cargo build ...` |
| "Contract already exists" | Cannot redeploy same WASM; must rebuild with changes |

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

```bash
# Run all tests
cargo test

# Run with output
cargo test -- --nocapture
```

## License

MIT
