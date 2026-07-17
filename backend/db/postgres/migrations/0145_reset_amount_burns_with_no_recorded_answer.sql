-- Give back the rows that were burned WITHOUT a recorded answer.
-- Twin of sqlite migration 141_reset_amount_burns_with_no_recorded_answer.sql —
-- see that file for the full rationale, the prod measurements, and the honest
-- (LOW) expected yield. Kept in lockstep: MIGRATION PARITY.
--
-- Short version: a permanent one-shot mark is a claim about the ROW, not about
-- the strategy current when it was set, so a changed rule must re-open the rows
-- burned under the old one IN THE SAME PR (4th instance: cf. 0142 / 0143 / 0144).
-- Two populations are burned on evidence that does not exist — the pre-#944
-- unconditional burns (identifiable as attempts=0, since today's sweep always
-- writes attempts+1 with the mark; 28 rows in prod, all stamped 2026-07-15), and
-- the rows whose answer the sweep learned at real fetch cost and then discarded
-- (the write branch skipped exactly the 'not_listed' the extractor returns for
-- "read it, no figure here"). `none_published` now records that denial, but only
-- a row the sweep may re-read can ever carry it.
--
-- Narrow + idempotent, same posture as 0143/0144: burned, no dollar figure, no
-- amount text, has a URL, and NO recorded answer (status is silence — NULL or
-- the 'not_listed' default). A row with an amount, real amount text, or an
-- honest status ('varies', 'contact_required', 'none_published') is untouched,
-- so re-running can never undo real evidence. `amount_enrich_attempts` is
-- deliberately NOT reset — MAX_ATTEMPTS still bounds a broken host.
UPDATE funding_opportunities fo
   SET amount_enrich_attempted_at = NULL
 WHERE fo.amount_enrich_attempted_at IS NOT NULL
   AND COALESCE(fo.amount_min, 0) <= 0
   AND COALESCE(fo.amount_max, 0) <= 0
   AND fo.amount_text IS NULL
   AND (fo.amount_status IS NULL OR fo.amount_status = 'not_listed')
   AND COALESCE(fo.source_url, fo.application_url, fo.evidence_url) IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM grants g
      WHERE g.funding_opportunity_id = fo.id
        AND g.status IN (
          'discovery', 'discovered', 'interested', 'auto_applied', 'drafting',
          'application_prep', 'app_prep', 'revision', 'portal', 'submitted',
          'pending_review', 'under_review', 'follow_up', 'report'
        )
   );
