-- 068_opportunity_kind_and_trust_tier.sql
--
-- Reality gate phase 1.2: classify every funding_opportunities row so the
-- consumer/UI layer can show "what kind of result this is" without having to
-- re-derive it from URL/origin heuristics every render.
--
-- opportunity_kind values:
--   'direct'       — a real grant/scholarship/benefit with an application path.
--   'benefit'      — a public/nonprofit assistance program the user can apply to.
--   'directory'    — a directory/portal that lists or routes to funding (e.g.
--                    United Way, Feeding America). Not itself a funding source.
--   'referral'     — a "call this person/agency" pointer, no portal of its own.
--   'school_portal'— a school's institutional aid / financial aid landing page.
--
-- source_trust_tier values (used together with link verification):
--   'official_api'         — first-party API like grants.gov.
--   'official_portal'      — first-party human portal (.gov / .edu / .mil).
--   'verified_directory'   — verified third-party directory (e.g. CoF locator).
--   'community_directory'  — community/NGO directory (e.g. United Way pages).
--   'open_web'             — open-web crawl, lower trust.
--   'manual_curated'       — manually curated by an operator.
--
-- Both columns are nullable so existing rows backfill lazily; the reality gate
-- fills them at insert/update time and a one-shot backfill script can fill in
-- legacy rows.

ALTER TABLE funding_opportunities
  ADD COLUMN opportunity_kind TEXT;

ALTER TABLE funding_opportunities
  ADD COLUMN source_trust_tier TEXT;

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_opportunity_kind
  ON funding_opportunities(opportunity_kind);

CREATE INDEX IF NOT EXISTS idx_funding_opportunities_source_trust_tier
  ON funding_opportunities(source_trust_tier);
