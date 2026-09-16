-- Complete the non-sensitive ZIP coverage audit surface. The auditor already
-- reads funding_opportunities; this index contains only opportunity/ZIP links.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grantflow_auditor') THEN
    GRANT SELECT ON TABLE funding_opportunity_geo_index TO grantflow_auditor;
  END IF;
END $$;
