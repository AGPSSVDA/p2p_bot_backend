-- Method 2 (Phase 1): store images the buyer uploads in the Binance order chat.
--
-- Phase 1 only records WHAT was uploaded (Binance image URL + metadata).
-- Downloading / OCR / classification (Aadhaar vs PAN) happens in a later phase,
-- which is why document_type stays nullable here.

ALTER TABLE seller_verification_documents
  ADD COLUMN IF NOT EXISTS image_url     VARCHAR(1000) NULL AFTER document_type,
  ADD COLUMN IF NOT EXISTS thumbnail_url VARCHAR(1000) NULL AFTER image_url,
  ADD COLUMN IF NOT EXISTS image_type    VARCHAR(20)   NULL AFTER thumbnail_url,
  ADD COLUMN IF NOT EXISTS image_width   INT           NULL AFTER image_type,
  ADD COLUMN IF NOT EXISTS image_height  INT           NULL AFTER image_width,
  -- Binance chat message id/uuid: used to dedupe so re-polling the chat
  -- does not insert the same uploaded image twice.
  ADD COLUMN IF NOT EXISTS chat_message_id   VARCHAR(64) NULL AFTER image_height,
  ADD COLUMN IF NOT EXISTS chat_message_uuid VARCHAR(64) NULL AFTER chat_message_id;

-- One row per uploaded chat image. Prevents duplicates when the poller re-reads chat.
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_chat_message
  ON seller_verification_documents (order_number, chat_message_id);
