-- 079_school_portal_bridge.sql
--
-- Adds the three tables that let a school's student-information system
-- merge what they already know about a student with the GrantFlow profile,
-- so the school portal can show students which funding sources they are
-- actually eligible for.
--
-- Design:
--   - school_partners: one row per registered institution
--   - school_partner_api_keys: hashed bearer tokens issued to a partner
--   - school_student_links: per-student bridge between the partner's
--     external student id and a GrantFlow profile, with a consent state
--     so a student can opt out at any time.
--
-- Idempotent: every CREATE uses IF NOT EXISTS so re-applying is safe.
-- All FK targets exist in the canonical schema.

CREATE TABLE IF NOT EXISTS school_partners (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ein TEXT,
  ipeds_id TEXT,
  contact_name TEXT,
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active','suspended','revoked')),
  allowed_origins TEXT DEFAULT '[]',
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_school_partners_status ON school_partners(status);
CREATE INDEX IF NOT EXISTS idx_school_partners_slug   ON school_partners(slug);

CREATE TABLE IF NOT EXISTS school_partner_api_keys (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  school_partner_id TEXT NOT NULL
    REFERENCES school_partners(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  label TEXT,
  created_by TEXT,
  last_used_at DATETIME,
  expires_at DATETIME,
  revoked_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_school_partner_api_keys_partner
  ON school_partner_api_keys(school_partner_id);
CREATE INDEX IF NOT EXISTS idx_school_partner_api_keys_hash
  ON school_partner_api_keys(key_hash);

CREATE TABLE IF NOT EXISTS school_student_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  school_partner_id TEXT NOT NULL
    REFERENCES school_partners(id) ON DELETE CASCADE,
  profile_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  external_student_id TEXT NOT NULL,
  email TEXT,
  consent_status TEXT NOT NULL DEFAULT 'granted'
    CHECK(consent_status IN ('pending','granted','revoked')),
  consented_at DATETIME,
  revoked_at DATETIME,
  last_synced_at DATETIME,
  last_sync_payload_hash TEXT,
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(school_partner_id, external_student_id)
);

CREATE INDEX IF NOT EXISTS idx_school_student_links_profile
  ON school_student_links(profile_id);
CREATE INDEX IF NOT EXISTS idx_school_student_links_email
  ON school_student_links(email);
CREATE INDEX IF NOT EXISTS idx_school_student_links_consent
  ON school_student_links(consent_status);
