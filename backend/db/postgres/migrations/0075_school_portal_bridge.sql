-- 0075_school_portal_bridge.sql
--
-- Postgres counterpart to 079_school_portal_bridge.sql.
-- Lets school student-information systems bridge their roster into
-- GrantFlow profiles so the portal can show eligible funding to
-- students.
--
-- Idempotent: IF NOT EXISTS on every object.

CREATE TABLE IF NOT EXISTS school_partners (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ein TEXT,
  ipeds_id TEXT,
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','suspended','revoked')),
  allowed_origins JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_partners_status ON school_partners(status);
CREATE INDEX IF NOT EXISTS idx_school_partners_slug   ON school_partners(slug);

CREATE TABLE IF NOT EXISTS school_partner_api_keys (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  school_partner_id TEXT NOT NULL
    REFERENCES school_partners(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  created_by TEXT,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_school_partner_api_keys_partner
  ON school_partner_api_keys(school_partner_id);
CREATE INDEX IF NOT EXISTS idx_school_partner_api_keys_hash
  ON school_partner_api_keys(key_hash);

CREATE TABLE IF NOT EXISTS school_student_links (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  school_partner_id TEXT NOT NULL
    REFERENCES school_partners(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  external_student_id TEXT NOT NULL,
  email TEXT,
  consent_status TEXT NOT NULL DEFAULT 'granted'
    CHECK(consent_status IN ('pending','granted','revoked')),
  consented_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  last_sync_payload_hash TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_partner_id, external_student_id)
);

CREATE INDEX IF NOT EXISTS idx_school_student_links_profile
  ON school_student_links(profile_id);
CREATE INDEX IF NOT EXISTS idx_school_student_links_email
  ON school_student_links(email);
CREATE INDEX IF NOT EXISTS idx_school_student_links_consent
  ON school_student_links(consent_status);
