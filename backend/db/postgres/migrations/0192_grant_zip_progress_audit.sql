-- The protected production-readiness audit needs only aggregate ZIP progress.
-- Granting SELECT on this non-sensitive checkpoint table avoids widening the
-- auditor to application/profile data; the role may not exist in fresh DBs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantflow_auditor') THEN
    GRANT SELECT ON TABLE national_zip_progress TO grantflow_auditor;
  END IF;
END $$;
