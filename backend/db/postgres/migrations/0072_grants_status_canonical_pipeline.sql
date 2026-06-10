-- 0072_grants_status_canonical_pipeline.sql (Postgres)
--
-- RC-13: widen grants.status CHECK to accept the 3 missing canonical
-- pipeline stages (`saved`, `gathering_documents`, `ready_to_submit`).
-- Legacy stages already in the constraint stay accepted so historical rows
-- aren't invalidated. Mirrors SQLite migration 076.
--
-- Idempotent: DROP CONSTRAINT IF EXISTS then re-add with the canonical full
-- set. Re-running is a no-op (drop is conditional, add re-creates).

ALTER TABLE grants DROP CONSTRAINT IF EXISTS grants_status_check;

ALTER TABLE grants ADD CONSTRAINT grants_status_check CHECK (status IN (
    -- Canonical 11-stage pipeline (RC-13, shared/pipelineStages.js):
    'discovered',
    'saved',
    'interested',
    'gathering_documents',
    'drafting',
    'ready_to_submit',
    'submitted',
    'follow_up',
    'awarded',
    'declined',
    'archived',
    -- Legacy stages preserved for back-compat with pre-RC-13 rows:
    'discovery',
    'auto_applied',
    'application_prep',
    'revision',
    'portal',
    'pending_review',
    'report',
    'declined_no_review',
    'closed',
    'app_prep',
    'under_review',
    'rejected',
    'deadline_passed'
));
