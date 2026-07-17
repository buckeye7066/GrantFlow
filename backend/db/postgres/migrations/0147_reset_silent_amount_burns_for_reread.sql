-- Give the SILENT-burned amount rows one fresh read.
-- Twin of sqlite migration 143_reset_silent_amount_burns_for_reread.sql — see it
-- for the full rationale. The 5th un-burn in this subsystem (cf. 0142/0143/0144/
-- 0145) and the safest: it resets ONLY rows marked attempted that never recorded
-- an answer (status still `not_listed`, no amount, no amount_text) and still have
-- a URL. Two things changed that make a re-read worth one bounded attempt: the
-- #958 extractor precision fix (skips program totals → real per-award figure),
-- and the fact that transient-burned rows never got a real answer. A genuine
-- JS-shell re-reads thin and re-burns (correct); an HTML scholarship page lands a
-- real amount or an evidenced `none_published`. Narrow, idempotent; a row with an
-- amount / real text / honest status is UNTOUCHED. `amount_enrich_attempts`
-- resets so MAX_ATTEMPTS starts fresh.

UPDATE funding_opportunities fo
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE fo.amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(fo.amount_min, 0) <= 0
   AND COALESCE(fo.amount_max, 0) <= 0
   AND fo.amount_text IS NULL
   AND (fo.amount_status IS NULL OR fo.amount_status = 'not_listed')
   AND COALESCE(fo.source_url, fo.application_url, fo.evidence_url) IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM grants g
      WHERE g.funding_opportunity_id = fo.id
        AND g.status IN (
          'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
          'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
          'pending_review', 'under_review', 'follow_up', 'report'
        )
   );

UPDATE grants g
   SET amount_enrich_attempted_at = NULL,
       amount_enrich_attempts = 0
 WHERE g.amount_enrich_attempted_at IS NOT NULL
   AND g.funding_opportunity_id IS NULL
   AND COALESCE(g.amount_requested, 0) <= 0
   AND COALESCE(g.amount_min, 0) <= 0
   AND COALESCE(g.amount_max, 0) <= 0
   AND (g.amount_text IS NULL OR g.amount_text = '')
   AND (g.amount_status IS NULL OR g.amount_status = 'not_listed')
   AND COALESCE(g.url, g.application_url) IS NOT NULL
   AND g.status IN (
     'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
     'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
     'pending_review', 'under_review', 'follow_up', 'report'
   );
