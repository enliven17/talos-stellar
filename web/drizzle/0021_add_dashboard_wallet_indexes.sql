-- 0021_add_dashboard_wallet_indexes.sql
--
-- Index the wallet/public-key columns that /api/dashboard filters on so that a
-- wallet lookup uses index scans instead of sequential scans.
--
-- tls_patrons: the dashboard queries by stellarPublicKey alone. The only
-- existing index is the composite unique (talosId, stellarPublicKey), which
-- cannot serve a stellarPublicKey-only predicate.
--
-- tls_talos: the dashboard builds an OR predicate across walletPublicKey,
-- creatorPublicKey, investorPublicKey, and treasuryPublicKey. None of these
-- columns had indexes. Separate single-column btree indexes let the planner
-- bitmap-OR across them for the OR condition.
--
-- All indexes are additive (CREATE INDEX IF NOT EXISTS) and safe to apply
-- on a live database. Rollback: DROP INDEX.

-- Patron wallet lookup (single-column — the composite unique index starts
-- with talosId and cannot serve a stellarPublicKey-only filter)
CREATE INDEX IF NOT EXISTS "tls_patrons_stellarPublicKey_idx"
  ON "tls_patrons" ("stellarPublicKey");
--> statement-breakpoint

-- TALOS owner-key lookups (dashboard OR predicate)
CREATE INDEX IF NOT EXISTS "tls_talos_walletPublicKey_idx"
  ON "tls_talos" ("walletPublicKey");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_talos_creatorPublicKey_idx"
  ON "tls_talos" ("creatorPublicKey");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_talos_investorPublicKey_idx"
  ON "tls_talos" ("investorPublicKey");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tls_talos_treasuryPublicKey_idx"
  ON "tls_talos" ("treasuryPublicKey");
