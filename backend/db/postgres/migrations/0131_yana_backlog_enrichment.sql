-- Migration 0131: backlog-enrichment bookkeeping on yana_lead_candidates.
--
-- Yana now revisits stored `needs_enrichment` leads (a bounded slice per run)
-- to find a REAL published contact email and promote them to `qualified`.
-- These columns bound the per-lead retry budget so the pass rotates through
-- the backlog instead of hammering the same unreachable org forever.

ALTER TABLE yana_lead_candidates
  ADD COLUMN IF NOT EXISTS enrich_attempts INTEGER NOT NULL DEFAULT 0;

ALTER TABLE yana_lead_candidates
  ADD COLUMN IF NOT EXISTS last_enrich_attempt_at TIMESTAMPTZ;
