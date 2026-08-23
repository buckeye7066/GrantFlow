-- 0187: funder-aware lifecycle fields on funding_opportunities (owner rule
-- 2026-08-23 — the user's calendar shows submission → expected decision →
-- award → funder-required follow-ups, every date real or computed from a
-- funder-stated rule, never invented).
--
-- All nullable: a row the crawler has not captured these from simply shows the
-- cornerstones we already have (submitted_date / award_date / deadline). The
-- web extractor (blindPageFactExtractor) populates them when the funder's page
-- states them.
--   expected_decision_date  — a concrete "awards announced on <date>" the funder stated.
--   decision_review_days    — a stated review LENGTH ("decisions within 90 days"),
--                             used to derive an ESTIMATED, clearly-labeled decision date.
--   reporting_requirements  — JSON array of funder follow-ups:
--                             [{label, offset_days?, anchor?:'award_date'|'submitted_date', due_date?}]
ALTER TABLE funding_opportunities
  ADD COLUMN IF NOT EXISTS expected_decision_date date,
  ADD COLUMN IF NOT EXISTS decision_review_days integer,
  ADD COLUMN IF NOT EXISTS reporting_requirements jsonb;
