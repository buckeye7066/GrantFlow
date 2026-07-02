-- Migration 129: backlog-enrichment bookkeeping on yana_lead_candidates.
--
-- Yana now revisits stored `needs_enrichment` leads (a bounded slice per run)
-- to find a REAL published contact email and promote them to `qualified`.
-- These columns bound the per-lead retry budget so the pass rotates through
-- the backlog instead of hammering the same unreachable org forever.
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; the runtime ensureSchema() in
-- yanaLeadDiscovery.js also adds these defensively (try/catch), so a re-run
-- here failing on "duplicate column" is tolerated by the migration runner
-- convention of one statement per concern.

ALTER TABLE yana_lead_candidates ADD COLUMN enrich_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE yana_lead_candidates ADD COLUMN last_enrich_attempt_at DATETIME;
