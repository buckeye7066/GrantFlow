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

const SAVED_GRANTS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_saved_grants_user_id ON saved_grants(user_id);',
  'CREATE INDEX IF NOT EXISTS idx_saved_grants_opportunity_id ON saved_grants(opportunity_id);',
  'CREATE INDEX IF NOT EXISTS idx_saved_grants_profile_id ON saved_grants(profile_id);',
]

const SQLITE_CREATE_SAVED_GRANTS = `
  CREATE TABLE IF NOT EXISTS saved_grants (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL DEFAULT '',
    opportunity_id TEXT NOT NULL,
    saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    notes TEXT DEFAULT NULL,
    UNIQUE(user_id, profile_id, opportunity_id)
  );
`

const POSTGRES_CREATE_SAVED_GRANTS = `
  CREATE TABLE IF NOT EXISTS saved_grants (
    id TEXT PRIMARY KEY DEFAULT (gen_random_uuid()::text),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL DEFAULT '',
    opportunity_id TEXT NOT NULL,
    saved_at TIMESTAMPTZ DEFAULT now(),
    notes TEXT DEFAULT NULL,
    UNIQUE(user_id, profile_id, opportunity_id)
  );
`

/**
 * Bring an existing Postgres saved_grants table up to the profile-scoped shape
 * (RC-14). Every statement is idempotent so this is safe to run on every boot.
 */
async function ensurePostgresSavedGrants(db) {
  await db.prepare(POSTGRES_CREATE_SAVED_GRANTS).run()
  await db.prepare('ALTER TABLE saved_grants ADD COLUMN IF NOT EXISTS profile_id TEXT;').run()
  await db.prepare("UPDATE saved_grants SET profile_id = '' WHERE profile_id IS NULL;").run()
  await db.prepare("ALTER TABLE saved_grants ALTER COLUMN profile_id SET DEFAULT '';").run()
  await db.prepare('ALTER TABLE saved_grants ALTER COLUMN profile_id SET NOT NULL;').run()
  // Replace the old 2-column unique with the profile-scoped one.
  await db
    .prepare('ALTER TABLE saved_grants DROP CONSTRAINT IF EXISTS saved_grants_user_id_opportunity_id_key;')
    .run()
  await db
    .prepare(
      'CREATE UNIQUE INDEX IF NOT EXISTS saved_grants_user_profile_opp_uidx ON saved_grants(user_id, profile_id, opportunity_id);',
    )
    .run()
}

/**
 * SQLite cannot ALTER a UNIQUE constraint, so an old-shape table is healed by
 * rebuilding it. This function fully owns creation + heal so the crash-recovery
 * check runs BEFORE any CREATE could mask a partially-rebuilt table.
 */
async function ensureSqliteSavedGrants(db) {
  const mainRow = await db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'saved_grants';")
    .get()
  const leftoverRow = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_grants_rc14';")
    .get()

  // Recover from a crash mid-rebuild (source dropped, rename not yet done).
  if (leftoverRow?.name && !mainRow?.sql) {
    await db.prepare('ALTER TABLE saved_grants_rc14 RENAME TO saved_grants;').run()
    return
  }

  // Fresh DB — create the canonical profile-scoped table.
  if (!mainRow?.sql) {
    await db.prepare(SQLITE_CREATE_SAVED_GRANTS).run()
    return
  }

  const normalized = String(mainRow.sql).replace(/\s+/g, ' ').toLowerCase()
  const hasProfileColumn = normalized.includes('profile_id')
  const hasProfileUnique = normalized.includes('unique(user_id, profile_id, opportunity_id)')
  if (hasProfileColumn && hasProfileUnique) return // already profile-scoped

  // Rebuild. Follow SQLite's recommended table-mutation procedure and disable
  // foreign-key enforcement for the duration: it lets the copy preserve any
  // pre-existing orphan rows (rather than OR IGNORE silently dropping them) and
  // avoids the rename tripping the FK check. PRAGMA is a no-op inside a
  // transaction, but this helper runs outside one on the request path.
  let prevForeignKeys = 1
  try {
    const row = await db.prepare('PRAGMA foreign_keys;').get()
    if (row && row.foreign_keys !== undefined && row.foreign_keys !== null) {
      prevForeignKeys = Number(row.foreign_keys)
    }
  } catch { /* dialect without this pragma — ignore */ }

  try {
    await db.prepare('PRAGMA foreign_keys = OFF;').run()
  } catch { /* ignore */ }

  try {
    // The SELECT only reads columns present in every historical shape and writes
    // the literal '' for profile_id, so it works whether or not the source table
    // already had a profile_id column.
    await db.prepare('DROP TABLE IF EXISTS saved_grants_rc14;').run()
    await db
      .prepare(
        `CREATE TABLE saved_grants_rc14 (
          id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          profile_id TEXT NOT NULL DEFAULT '',
          opportunity_id TEXT NOT NULL,
          saved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          notes TEXT DEFAULT NULL,
          UNIQUE(user_id, profile_id, opportunity_id)
        );`,
      )
      .run()
    await db
      .prepare(
        `INSERT OR IGNORE INTO saved_grants_rc14 (id, user_id, profile_id, opportunity_id, saved_at, notes)
          SELECT id, user_id, '', opportunity_id, saved_at, notes FROM saved_grants;`,
      )
      .run()
    await db.prepare('DROP TABLE saved_grants;').run()
    await db.prepare('ALTER TABLE saved_grants_rc14 RENAME TO saved_grants;').run()
  } finally {
    if (prevForeignKeys === 1) {
      try {
        await db.prepare('PRAGMA foreign_keys = ON;').run()
      } catch { /* ignore */ }
    }
  }
}

export async function ensureSavedGrantsSchema(db) {
  if (!db || typeof db.prepare !== 'function') return
  if (ensuredDbs.has(db)) return
  if (ensurePromises.has(db)) return ensurePromises.get(db)

  const ensurePromise = (async () => {
    const isPostgres = db?.dialect === 'postgres'

    await ensureFundingOpportunityLinkStatus(db)

    if (isPostgres) {
      await ensurePostgresSavedGrants(db)
    } else {
      await ensureSqliteSavedGrants(db)
    }

    for (const sql of SAVED_GRANTS_INDEXES) {
      await db.prepare(sql).run()
    }
    ensuredDbs.add(db)
  })()

  ensurePromises.set(db, ensurePromise)

  try {
    return await ensurePromise
  } finally {
    ensurePromises.delete(db)
  }
}
