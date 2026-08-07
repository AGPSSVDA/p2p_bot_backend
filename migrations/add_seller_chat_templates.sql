-- Editable chat messages for the SELLER bot (Method 1 & Method 2).
--
-- Reuses the existing template_groups / template_messages tables (same as the
-- buyer bot) so we get the same caching + {variable} fill + multi-variation
-- behaviour for free. A `category` column separates buyer vs seller keys so each
-- frontend page shows only its own messages.

-- 1) category column — existing rows are the buyer bot's, so default to 'buyer'.
ALTER TABLE template_groups
  ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'buyer' AFTER template_key;

-- 2) Seed the seller template keys (idempotent — INSERT ... WHERE NOT EXISTS).
--    message_text seeds are the current hardcoded defaults; admin can edit them.
--    Placeholders use {var} tokens filled by the bot at send time.

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_cooldown_24h', 'seller', 'Buyer placed an order within the last 24h. Placeholder: {hours}.', 1
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_cooldown_24h');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_liveness_request', 'seller', 'Ask the buyer to complete the Binance liveness check.', 2
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_liveness_request');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_liveness_timeout', 'seller', 'Liveness check timed out; order cancelled.', 3
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_liveness_timeout');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_upload_request', 'seller', 'Method 2: after liveness, ask buyer to upload Aadhaar front, back and PAN.', 4
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_upload_request');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_name_mismatch', 'seller', 'Aadhaar/PAN name does not match KYC. Placeholders: {docType}, {kycName}, {docName}, {attempt}, {maxAttempts}.', 5
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_name_mismatch');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_unreadable', 'seller', 'Could not read the name/number on the document. Placeholders: {docType}, {attempt}, {maxAttempts}.', 6
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_unreadable');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_pan_failed', 'seller', 'PAN verification (Surepass) failed. Placeholders: {reason}, {attempt}, {maxAttempts}.', 7
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_pan_failed');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_not_document', 'seller', 'Uploaded image is not a valid Aadhaar/PAN or is unreadable. Placeholder: {missing}.', 8
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_not_document');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_missing', 'seller', 'Reminder of which documents are still pending. Placeholder: {missing}.', 9
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_missing');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_limit_exceeded', 'seller', '3 attempts exceeded for a document; ask buyer to cancel. Placeholder: {docType}.', 10
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_limit_exceeded');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_doc_timeout', 'seller', 'Document verification window timed out.', 11
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_doc_timeout');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_thank_you', 'seller', 'Final thank-you message after payment completes.', 12
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_thank_you');

INSERT INTO template_groups (template_key, category, small_description, sort_order)
SELECT 'seller_verification_unavailable', 'seller', 'OpenAI credit exhausted — verification temporarily unavailable (generic buyer message).', 13
WHERE NOT EXISTS (SELECT 1 FROM template_groups WHERE template_key = 'seller_verification_unavailable');

-- 3) Seed one default message (step_order 1) for each seller key, if none exist.
INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'You have already placed an order in the last 24 hours. Only one order per 24 hours is allowed. Please place a new order after {hours} hour(s).',
  1
FROM template_groups g
WHERE g.template_key = 'seller_cooldown_24h'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id, 'Please complete the liveness check on Binance to proceed with your order.', 1
FROM template_groups g
WHERE g.template_key = 'seller_liveness_request'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id, 'Liveness check timeout. Your order has been cancelled. Please try again.', 1
FROM template_groups g
WHERE g.template_key = 'seller_liveness_timeout'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'Liveness verified. Please upload the following for document verification: 1) Aadhaar card - front, 2) Aadhaar card - back, 3) PAN card. You can send them in any order.',
  1
FROM template_groups g
WHERE g.template_key = 'seller_doc_upload_request'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'Name mismatch on {docType}: your Binance KYC name is "{kycName}" but the document shows "{docName}". Please upload a matching {docType}. (Attempt {attempt}/{maxAttempts})',
  1
FROM template_groups g
WHERE g.template_key = 'seller_doc_name_mismatch'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'Could not read your {docType}. Please re-upload a clear image. (Attempt {attempt}/{maxAttempts})',
  1
FROM template_groups g
WHERE g.template_key = 'seller_doc_unreadable'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'PAN verification failed ({reason}). Please re-upload a clear, valid PAN card image. (Attempt {attempt}/{maxAttempts})',
  1
FROM template_groups g
WHERE g.template_key = 'seller_doc_pan_failed'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'This image is not a valid Aadhaar or PAN, or it could not be read. {missing}',
  1
FROM template_groups g
WHERE g.template_key = 'seller_doc_not_document'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id, 'Please upload a clear image of: {missing}.', 1
FROM template_groups g
WHERE g.template_key = 'seller_doc_missing'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'You have exceeded the {docType} verification limit (3 attempts). I cannot verify this order - please cancel this order.',
  1
FROM template_groups g
WHERE g.template_key = 'seller_doc_limit_exceeded'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id, 'Document verification timed out. You can cancel this order and try again.', 1
FROM template_groups g
WHERE g.template_key = 'seller_doc_timeout'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'Payment completed! Thank you for trading with us! Your crypto will be released shortly.',
  1
FROM template_groups g
WHERE g.template_key = 'seller_thank_you'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);

INSERT INTO template_messages (template_id, message_text, step_order)
SELECT g.id,
  'Sorry, document verification is temporarily unavailable right now. Please try again later or cancel this order.',
  1
FROM template_groups g
WHERE g.template_key = 'seller_verification_unavailable'
  AND NOT EXISTS (SELECT 1 FROM template_messages m WHERE m.template_id = g.id);
