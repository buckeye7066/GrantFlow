const ensuredDbs = new WeakSet()
const ensurePromises = new WeakMap()

// Reconcile saved_grants schema by adding profile_id if missing. SQLite cannot
// remove the inline UNIQUE(user_id, opportunity_id) constraint via ALTER, so
// we leave it alone here — the formal migration (075) does the rebuild. This
// helper is the runtime safety net so request-time use of the route never
// 500s on an environment where the migration hasn't been run yet (tests, etc).
async function ensureSavedGrantsProfileColumn(db, isPostgres) {
  if (isPostgres) {
    await db
      .prepare(
        'ALTER TABLE saved_grants ADD COLUMN IF NOT EXISTS profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE;',
      )
      .run()
    return
  }
  // SQLite: probe pragma; ALTER ADD COLUMN if missing.
  const cols = await db.prepare('PRAGMA table_info(saved_grants);').all()
  const hasProfileId = Array.isArray(cols) && cols.some((c) => String(c?.name || '').toLowerCase() === 'profile_id')
  if (!hasProfileId) {
    await db.prepare('ALTER TABLE saved_grants ADD COLUMN profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE;').run()
  }
}

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
    // Fresh-DB shape: profile_id-aware. Migrations 075 (SQLite) / 0071
    // (Postgres) bring legacy shapes up to this. The runtime self-heal here
    // creates the new shape on a brand-new DB so we never bake a
    // soon-to-be-rebuilt table into a fresh test/CI instance.
    const createTable = isPostgres
      ? `
          CREATE TABLE IF NOT EXISTS saved_grants (
            id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
            opportunity_id TEXT NOT NULL,
            saved_at TIMESTAMPTZ DEFAULT now(),
            notes TEXT DEFAULT NULL
          );
        `
      : `
          CREATE TABLE IF NOT EXISTS saved_grants (
            id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            profile_id TEXT REFERENCES profiles(id) ON DELETE CASCADE,
            opportunity_id TEXT NOT NULL,
            saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            notes TEXT DEFAULT NULL
          );
        `

    await ensureFundingOpportunityLinkStatus(db)
    await db.prepare(createTable).run()
    // Reconcile: if the table already existed in the old shape (no profile_id),
    // ALTER ADD COLUMN to bring it to the new shape. This is the same idea as
    // ensureFundingOpportunityLinkStatus and supports environments where the
    // formal migration hasn't been run yet (test fixtures, ephemeral DBs).
    await ensureSavedGrantsProfileColumn(db, isPostgres)
    // Partial unique indexes — separate so we can keep legacy NULL rows
    // visible to all profiles for a given user without forcing them into a
    // single bucket.
    if (isPostgres) {
      await db
        .prepare(
          'CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_profile_opp ON saved_grants(user_id, profile_id, opportunity_id) WHERE profile_id IS NOT NULL;',
        )
        .run()
      await db
        .prepare(
          'CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_legacy_opp ON saved_grants(user_id, opportunity_id) WHERE profile_id IS NULL;',
        )
        .run()
    } else {
      // SQLite supports the same partial-index syntax (>=3.8.0).
      await db
        .prepare(
          'CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_profile_opp ON saved_grants(user_id, profile_id, opportunity_id) WHERE profile_id IS NOT NULL;',
        )
        .run()
      await db
        .prepare(
          'CREATE UNIQUE INDEX IF NOT EXISTS uq_saved_grants_user_legacy_opp ON saved_grants(user_id, opportunity_id) WHERE profile_id IS NULL;',
        )
        .run()
    }
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);').run()
    await db.prepare('CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);').run()
    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)

  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}
