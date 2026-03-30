export default async function ensurePortalCheckResultsTable(db) {
  if (!db) return

  if (db?.dialect === 'postgres') {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS portal_check_results (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        portal_name TEXT NOT NULL,
        portal_url TEXT,
        check_type TEXT DEFAULT 'scheduled',
        status TEXT DEFAULT 'completed',
        awards_detected INTEGER DEFAULT 0,
        results_json TEXT,
        checked_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_profile_id ON portal_check_results(profile_id);
      CREATE INDEX IF NOT EXISTS idx_portal_check_results_checked_at ON portal_check_results(checked_at);
    `)
    return
  }

  // SQLite
  await db.exec(`
    CREATE TABLE IF NOT EXISTS portal_check_results (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      portal_name TEXT NOT NULL,
      portal_url TEXT,
      check_type TEXT DEFAULT 'scheduled',
      status TEXT DEFAULT 'completed',
      awards_detected INTEGER DEFAULT 0,
      results_json TEXT,
      checked_at TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_portal_check_results_profile_id ON portal_check_results(profile_id);
    CREATE INDEX IF NOT EXISTS idx_portal_check_results_checked_at ON portal_check_results(checked_at);
  `)
}
