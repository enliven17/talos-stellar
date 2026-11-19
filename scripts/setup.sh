#!/bin/bash
# Talos Protocol — Production Setup Script
# Run this to verify your deployment configuration

set -e

echo "🚀 Talos Protocol — Setup Verification"
echo "========================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
WARN=0
FAIL=0

check_var() {
    local var_name=$1
    local var_value=${!var_name}
    local required=${2:-true}
    
    if [ -z "$var_value" ]; then
        if [ "$required" = "true" ]; then
            echo -e "${RED}❌ Missing: $var_name${NC}"
            FAIL=$((FAIL + 1))
        else
            echo -e "${YELLOW}⚠️  Optional: $var_name${NC}"
            WARN=$((WARN + 1))
        fi
    else
        echo -e "${GREEN}✅ Set: $var_name${NC}"
        PASS=$((PASS + 1))
    fi
}

echo "📋 Checking Environment Variables..."
echo "------------------------------------"
check_var "DATABASE_URL"
check_var "DIRECT_URL"
check_var "STELLAR_NETWORK"
check_var "STELLAR_HORIZON_URL"
check_var "STELLAR_RPC_URL"
check_var "STELLAR_OPERATOR_SECRET_KEY"
check_var "NEXT_PUBLIC_TALOS_REGISTRY_CONTRACT"
check_var "NEXT_PUBLIC_TALOS_NAME_SERVICE_CONTRACT"
check_var "NEXT_PUBLIC_STELLAR_WALLET_NETWORK"
check_var "X402_FACILITATOR_URL"
check_var "X402_API_KEY"
check_var "OPENAI_API_KEY"
check_var "TAVILY_API_KEY"
check_var "NEXT_PUBLIC_TALOS_CREATION_XLM" "false"

echo ""
echo "📋 Checking Tools..."
echo "------------------------------------"

# Check Node.js
if command -v node &> /dev/null; then
    echo -e "${GREEN}✅ Node.js: $(node --version)${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}❌ Node.js not found${NC}"
    FAIL=$((FAIL + 1))
fi

# Check pnpm
if command -v pnpm &> /dev/null; then
    echo -e "${GREEN}✅ pnpm: $(pnpm --version)${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${RED}❌ pnpm not found${NC}"
    FAIL=$((FAIL + 1))
fi

# Check Rust (for contracts)
if command -v rustc &> /dev/null; then
    echo -e "${GREEN}✅ Rust: $(rustc --version)${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${YELLOW}⚠️  Rust not found (required for contracts)${NC}"
    WARN=$((WARN + 1))
fi

# Check Soroban CLI
if command -v stellar &> /dev/null; then
    echo -e "${GREEN}✅ Stellar CLI: installed${NC}"
    PASS=$((PASS + 1))
else
    echo -e "${YELLOW}⚠️  Stellar CLI not found (required for contracts)${NC}"
    WARN=$((WARN + 1))
fi

echo ""
echo "📋 Checking Database..."
echo "------------------------------------"

# Try to connect to database
if [ -n "$DATABASE_URL" ]; then
    cd web
    if pnpm db:push &> /dev/null; then
        echo -e "${GREEN}✅ Database connection successful${NC}"
        PASS=$((PASS + 1))
    else
        echo -e "${RED}❌ Database connection failed${NC}"
        FAIL=$((FAIL + 1))
    fi
    cd ..
else
    echo -e "${YELLOW}⚠️  DATABASE_URL not set, skipping check${NC}"
    WARN=$((WARN + 1))
fi

echo ""
echo "========================================"
echo -e "${GREEN}Passed: $PASS${NC}"
echo -e "${YELLOW}Warnings: $WARN${NC}"
echo -e "${RED}Failed: $FAIL${NC}"
echo ""

if [ $FAIL -eq 0 ]; then
    echo -e "${GREEN}🎉 Setup looks good!${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Deploy web: cd web && vercel --prod"
    echo "  2. Deploy contracts: cd contracts && pnpm build && soroban contract deploy ..."
    echo "  3. Update contract IDs in Vercel env vars"
    echo "  4. Visit your deployed app!"
else
    echo -e "${RED}⚠️  Please fix the issues above before deploying${NC}"
    exit 1
fi
