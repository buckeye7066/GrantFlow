-- Give back the rows a RE-CRAWL wiped.
--
-- The adapter (138/0142) worked, and the type fix (139/0143) let it persist. Then
-- the crawler quietly undid it.
--
-- `upsertFundingOpportunity` clears nullable fields on a `live_crawl` re-ingest
-- "when source no longer has them (avoids stale data)". That treats an ingest
-- carrying no amount as the source ASSERTING it has none. For a LISTING endpoint
-- that is false: grants.gov `search2` — which every grants.gov crawl uses —
-- returns no award fields at all, ever. So each re-crawl claimed "no amount"
-- about rows the API had just given us figures for, and nulled them.
--
-- Measured in prod 2026-07-16:
--   * FY26 Pathways: enriched to $5M–$10M at 14:51, re-crawled 23:28 → NULL.
--   * Occupational Safety: NOT re-crawled since 14:51 → still holds $9M.
--   * Fleet: `live_crawl` rows carried an amount 13/538 (2.4%) versus
--     `funding_api` 147/866 (17%). Active-pipeline coverage decayed 21% → 15%
--     in seven hours, and would have kept sliding back toward the 13% this whole
--     line of work started from.
--
-- `amount_enrich_attempted_at` SURVIVES the wipe, so each wiped row is BURNED:
-- blank, and permanently excluded from the sweep's candidate query. The code fix
-- (silence is not a denial) stops any further wipes, but it cannot revive what
-- was already lost — the burn is permanent by design.
--
-- Narrow + idempotent, same predicate as 139: adapter-readable rows that still
-- carry no dollar figure and no amount text. A row with an amount is untouched;
-- no other source is touched.
--
-- GENERALIZE: an ingest that says NOTHING about a field is SILENT, not
-- authoritative. Only clear a value when the incoming source actually asserts
-- something about it — otherwise the least-informed writer in the system wins,
-- and the best-informed one (an official API) gets overwritten by a listing that
-- structurally cannot carry the data.
UPDATE funding_opportunities
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(amount_min, 0) <= 0
   AND COALESCE(amount_max, 0) <= 0
   AND amount_text IS NULL
   AND (
        LOWER(COALESCE(source, '')) IN ('grants.gov', 'grants_gov')
     OR LOWER(COALESCE(record_origin, '')) = 'grants_gov'
     OR LOWER(COALESCE(source_url, '')) LIKE '%grants.gov/%'
     OR LOWER(COALESCE(application_url, '')) LIKE '%grants.gov/%'
   );
