const ensuredDbs = new WeakSet()
const ensurePromises = new WeakMap()

async function ensureFundingOpportunityLinkStatus(db) {
  const isPostgres = db?.dialect === 'postgres'
  if (isPostgres) {
    await db
      .prepare("ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS link_status TEXT DEFAULT 'unknown';")
      .run()
    await db
      .prepare('CREATE INDEX IF NOT EXISTS idx_funding_opps_link_status ON funding_opportunities(link_status);')
      .run()
    return
  }

  const columns = await db.prepare('PRAGMA table_info(funding_opportunities);').all()
  const hasTable = Array.isArray(columns) && columns.length > 0
  if (!hasTable) return

  const hasLinkStatus = columns.some((column) => String(column?.name || '').toLowerCase() === 'link_status')
  if (!hasLinkStatus) {
    await db.prepare("ALTER TABLE funding_opportunities ADD COLUMN link_status TEXT DEFAULT 'unknown';").run()
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_funding_opps_link_status ON funding_opportunities(link_status);').run()
}

export async function ensureSavedGrantsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredDbs.has(db)) return
  if (ensurePromises.has(db)) return ensurePromises.get(db)

  const ensurePromise = (async () => {
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

    await ensureFundingOpportunityLinkStatus(db)
    await db.prepare(createTable).run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);').run()
    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)

  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}
