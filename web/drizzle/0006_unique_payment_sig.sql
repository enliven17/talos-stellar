-- Add unique constraint on paymentSig to prevent replay attacks via TOCTOU race
CREATE UNIQUE INDEX IF NOT EXISTS "tls_commerce_jobs_paymentSig_unique"
  ON "tls_commerce_jobs" ("paymentSig")
  WHERE "paymentSig" IS NOT NULL;
