let ensurePromise = null
let ensured = false

export async function ensureSavedGrantsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensured) return
  if (ensurePromise) return ensurePromise

  ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'
    const createTable = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS saved_grants (
            id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            opportunity_id TEXT NOT NULL,
            saved_at TIMESTAMPTZ DEFAULT now(),
            notes TEXT DEFAULT NULL,
            UNIQUE(user_id, opportunity_id)
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS saved_grants (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            opportunity_id TEXT NOT NULL,
            saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            notes TEXT DEFAULT NULL,
            UNIQUE(user_id, opportunity_id)
          );
        `

    await db.prepare(createTable).run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);').run()
    ensured = true
  })()

  try {
    return await ensurePromise
  } finally {
    ensurePromise = null
  }
}
