-- Artificial per-request token overhead for OpenAI usage accounting.
--
-- Business rule: every OpenAI request is charged an EXTRA fixed number of tokens
-- (default 2000, env OPENAI_TOKEN_OVERHEAD) on top of the real usage. These
-- overhead tokens are folded into total_tokens + cost_usd of each row, so all the
-- Settings-page numbers (total spent, total tokens, today's spend, remaining
-- credit, per-request tokens) reflect the inflated figure. When remaining credit
-- hits 0, the bot refuses further OpenAI calls ("token limit exceeded") even if
-- the real OpenAI account still has credit.
--
-- We record how much overhead was baked into each row so it stays auditable.

-- request_count already added earlier via ALTER on both DBs; keep it here for
-- fresh installs (harmless if it already exists — run once).
ALTER TABLE openai_usage_log
  ADD COLUMN request_count INT DEFAULT 1 AFTER purpose;

-- Overhead tokens baked into this row's total_tokens/cost_usd (0 for pre-overhead
-- rows before they are backfilled).
ALTER TABLE openai_usage_log
  ADD COLUMN overhead_tokens INT DEFAULT 0 AFTER request_count;
