#!/usr/bin/env bash
#
# scripts/explain-dashboard-indexes.sh
#
# Runs EXPLAIN for the two dashboard queries that issue #958 indexes and
# verifies the planner uses index scans (not sequential scans).
#
# Requires a database with the 0021_add_dashboard_wallet_indexes migration
# applied and seed data present.  Set DATABASE_URL / PGPASSWORD as needed.
#
# Usage:
#   bash scripts/explain-dashboard-indexes.sh
#
# Exit codes:
#   0 — both queries use index scans
#   1 — one or both queries use sequential scans

set -euo pipefail

DB_URL="${DATABASE_URL:?DATABASE_URL is required}"
PGPASSWORD_VALUE="${PGPASSWORD:-}"

# Use psql's connection string from DATABASE_URL.
export PGPASSWORD="$PGPASSWORD_VALUE"

WALLET="GDUMMYWALLET0000000000000000000000000000000000000000000000000"

echo "=== EXPLAIN: tls_patrons by stellarPublicKey ==="
PATRON_PLAN=$(psql "$DB_URL" -t -c "
  EXPLAIN SELECT \"talosId\" FROM tls_patrons WHERE \"stellarPublicKey\" = '$WALLET';
")

echo "$PATRON_PLAN"
echo ""

# Check for Index Scan / Bitmap Index Scan in the patron plan
if echo "$PATRON_PLAN" | grep -qiE "Index Scan|Bitmap Index Scan"; then
  echo "✓ patron query uses index scan"
else
  echo "✗ patron query uses sequential scan"
  exit 1
fi

echo ""
echo "=== EXPLAIN: tls_talos by owner key OR predicate ==="
TALOS_PLAN=$(psql "$DB_URL" -t -c "
  EXPLAIN SELECT * FROM tls_talos
  WHERE \"walletPublicKey\" = '$WALLET'
     OR \"creatorPublicKey\" = '$WALLET'
     OR \"investorPublicKey\" = '$WALLET'
     OR \"treasuryPublicKey\" = '$WALLET';
")

echo "$TALOS_PLAN"
echo ""

# Check for Index Scan / Bitmap Index Scan in the talos plan
if echo "$TALOS_PLAN" | grep -qiE "Index Scan|Bitmap Index Scan"; then
  echo "✓ talos owner query uses index scan"
else
  echo "✗ talos owner query uses sequential scan"
  exit 1
fi

echo ""
echo "All dashboard queries use index scans. ✓"
