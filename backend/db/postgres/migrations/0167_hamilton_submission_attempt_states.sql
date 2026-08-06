-- 0167_hamilton_submission_attempt_states.sql (PostgreSQL)
--
-- Durable external-submit boundary states. Keep this named CHECK in parity
-- with applicationTaskStore.TASK_STATUSES and the SQLite bootstrap/migration.

ALTER TABLE application_tasks
  DROP CONSTRAINT IF EXISTS application_tasks_status_check;

ALTER TABLE application_tasks
  ADD CONSTRAINT application_tasks_status_check CHECK (status IN (
    'queued','ready','waiting_for_user','waiting_for_admin','blocked_login_required',
    'blocked_missing_info','blocked_2fa','blocked_captcha','blocked_terms_or_policy',
    'in_progress','draft_completed','submitted','failed','cancelled','analyzing',
    'ready_to_start','generating_application','generating_documents','saving_documents',
    'launching_portal','waiting_for_login','waiting_for_2fa','waiting_for_captcha',
    'waiting_for_email_verification','waiting_for_window','waiting_for_missing_info',
    'filling_portal','submit_attempt_started','submit_evidence_pending',
    'submission_verification_required','saving_portal_draft','waiting_for_review',
    'ready_to_submit','ready_to_print_mail','ready_to_email','ready_to_fax','completed',
    'blocked'
  ));
