function hasTable(db, tableName) {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`)
      .get(tableName)
    return Boolean(row?.name)
  } catch {
    return false
  }
}

function hasColumn(db, tableName, columnName) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${tableName})`).all()
    return cols.some((c) => String(c.name).toLowerCase() === String(columnName).toLowerCase())
  } catch {
    return false
  }
}

export function ensureZipGeoCache(db) {
  if (!db) throw new Error('db required')
  if (!hasTable(db, 'zip_geo_cache')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS zip_geo_cache (
        zip_code TEXT PRIMARY KEY,
        city TEXT,
        state TEXT,
        county TEXT,
        lat REAL,
        lng REAL,
        last_resolved_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_zip_geo_state ON zip_geo_cache(state);
      CREATE INDEX IF NOT EXISTS idx_zip_geo_county ON zip_geo_cache(state, county);
    `)
  }
  return { ok: true }
}

export function ensureOpportunityGeoCoverage(db) {
  if (!db) throw new Error('db required')
  if (!hasTable(db, 'opportunity_geo_coverage')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS opportunity_geo_coverage (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        opportunity_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('zip','county','state','national')),
        state TEXT,
        county TEXT,
        city TEXT,
        zip_code TEXT,
        UNIQUE(opportunity_id, scope_type, COALESCE(state,''), COALESCE(county,''), COALESCE(zip_code,''))
      );
      CREATE INDEX IF NOT EXISTS idx_opp_geo_zip ON opportunity_geo_coverage(zip_code);
      CREATE INDEX IF NOT EXISTS idx_opp_geo_county ON opportunity_geo_coverage(state, county);
      CREATE INDEX IF NOT EXISTS idx_opp_geo_state ON opportunity_geo_coverage(state);
      CREATE INDEX IF NOT EXISTS idx_opp_geo_opp ON opportunity_geo_coverage(opportunity_id);
    `)
  }

  // Add columns to funding_opportunities if missing (useful for quick display + optional direct filtering)
  if (!hasColumn(db, 'funding_opportunities', 'city')) {
    try {
      db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN city TEXT`).run()
    } catch {
      // best-effort
    }
  }
  if (!hasColumn(db, 'funding_opportunities', 'county')) {
    try {
      db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN county TEXT`).run()
    } catch {
      // best-effort
    }
  }
  if (!hasColumn(db, 'funding_opportunities', 'zip_code')) {
    try {
      db.prepare(`ALTER TABLE funding_opportunities ADD COLUMN zip_code TEXT`).run()
    } catch {
      // best-effort
    }
  }

  // Indexes (ignore failures if already exist / sqlite variant)
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_opps_zip_code ON funding_opportunities(zip_code);
      CREATE INDEX IF NOT EXISTS idx_opps_state_zip ON funding_opportunities(state, zip_code);
    `)
  } catch {
    // best-effort
  }

  return { ok: true }
}

export default { ensureZipGeoCache, ensureOpportunityGeoCoverage }

