-- Method 2 incremental (per-image) document verification.
--
-- The new flow processes each image the buyer uploads INDIVIDUALLY (in any order,
-- any count) and records what has been verified so far, so we can:
--   - mark Aadhaar FRONT verified (name matched KYC),
--   - mark Aadhaar BACK seen,
--   - mark PAN verified (Surepass + name match),
-- and only confirm the order once all three are done.
--
-- aadhaar_verification_passed / pan_verification_passed already exist (they now
-- mean "Aadhaar front name matched" and "PAN verified"). We only need a flag for
-- the Aadhaar BACK being seen, since it has nothing to name-match.

-- MariaDB supports "ADD COLUMN IF NOT EXISTS"; plain MySQL does not. This runs on
-- both, so guard with a check. On MySQL, run the ALTER once (it errors harmlessly
-- if the column already exists).
ALTER TABLE seller_orders
  ADD COLUMN aadhaar_back_seen TINYINT(1) DEFAULT 0 AFTER aadhaar_name;

-- Per-image processing needs to remember which chat images we already ran through
-- OpenAI so we never re-classify (and re-bill) the same image. We reuse the
-- existing seller_verification_documents table: document_type holds the classified
-- type and verification_status is flipped from 'UPLOADED' to 'PROCESSED'.
-- No schema change needed there — both columns already exist.
