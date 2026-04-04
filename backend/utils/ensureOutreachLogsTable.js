export default async function ensureOutreachLogsTable(db) {
  if (!db) return

  if (db?.dialect === 'postgres') {
    // Self-heal: allow running on every request safely.
    await db.exec(`
      CREATE TABLE IF NOT EXISTS outreach_logs (
        id TEXT PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),

        profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,

        funder TEXT NOT NULL,
        method TEXT NOT NULL CHECK(method IN ('email', 'call', 'meeting')),
        occurred_at TIMESTAMPTZ,
        subject TEXT,
        notes TEXT,
        metadata JSONB DEFAULT '{}'::jsonb,

        created_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outreach_logs_profile_id ON outreach_logs(profile_id);
      CREATE INDEX IF NOT EXISTS idx_outreach_logs_org_id ON outreach_logs(organization_id);
      CREATE INDEX IF NOT EXISTS idx_outreach_logs_funder ON outreach_logs(funder);
      CREATE INDEX IF NOT EXISTS idx_outreach_logs_occurred_at ON outreach_logs(occurred_at);
    `)

    // updated_at trigger (shared helper is created by earlier migrations; be defensive here too).
    await db.exec(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'set_updated_at') THEN
          CREATE OR REPLACE FUNCTION set_updated_at()
          RETURNS TRIGGER AS $fn$
          BEGIN
            NEW.updated_at = CURRENT_TIMESTAMP;
            RETURN NEW;
          END;
          $fn$ LANGUAGE plpgsql;
        END IF;
      END$$;
    `)

    await db.exec(`
      DROP TRIGGER IF EXISTS trg_outreach_logs_updated_at ON outreach_logs;
      CREATE TRIGGER trg_outreach_logs_updated_at
      BEFORE UPDATE ON outreach_logs
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
    `)

    return
  }

  // SQLite
  await db.exec(`
    CREATE TABLE IF NOT EXISTS outreach_logs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,

      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,

      funder TEXT NOT NULL,
      method TEXT NOT NULL CHECK(method IN ('email', 'call', 'meeting')),
      occurred_at DATETIME,
      subject TEXT,
      notes TEXT,
      metadata TEXT DEFAULT '{}',

      created_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outreach_logs_profile_id ON outreach_logs(profile_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_logs_org_id ON outreach_logs(organization_id);
    CREATE INDEX IF NOT EXISTS idx_outreach_logs_funder ON outreach_logs(funder);
    CREATE INDEX IF NOT EXISTS idx_outreach_logs_occurred_at ON outreach_logs(occurred_at);
  `)
}
