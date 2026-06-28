function rowsFromResult(result) {
  if (Array.isArray(result)) return result
  if (Array.isArray(result?.rows)) return result.rows
  return []
}

async function tableColumns(db, tableName) {
  if (db?.dialect === 'postgres') {
    const rows = await db.prepare(`
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ?
    `).all(tableName)
    return rowsFromResult(rows).map((row) => String(row.name))
  }
  const rows = await db.prepare(`PRAGMA table_info(${tableName})`).all()
  return rowsFromResult(rows).map((row) => String(row.name))
}

async function tableExists(db, tableName) {
  if (db?.dialect === 'postgres') {
    const row = await db.prepare(`SELECT to_regclass(current_schema() || '.' || ?) AS regclass`).get(tableName)
    return Boolean(row?.regclass)
  }
  const row = await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`).get(tableName)
  return Boolean(row?.name)
}

async function runIgnoringDuplicateColumn(db, sql) {
  try {
    await db.prepare(sql).run()
    return true
  } catch (error) {
    const message = String(error?.message || error)
    if (/duplicate column|already exists/i.test(message)) return false
    throw error
  }
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

export async function ensureAdminSchemaRepair(db, { backfill = true } = {}) {
  if (!db) return { applied: false, reason: 'no database connection' }

  const isPg = db?.dialect === 'postgres'
  const grantsExists = await tableExists(db, 'grants')
  if (!grantsExists) return { applied: false, reason: 'grants table missing' }

  const beforeColumns = new Set(await tableColumns(db, 'grants'))
  const requiredColumns = [
    ['url', 'TEXT'],
    ['matched_needs', isPg ? 'JSONB' : 'JSONB'],
    ['match_decision', 'TEXT'],
    ['match_explanation', isPg ? 'JSONB' : 'JSONB'],
    ['fingerprint', 'TEXT'],
    ['fingerprint_version', isPg ? 'INT' : 'INTEGER'],
    ['profile_fingerprint', 'TEXT'],
    ['opportunity_fingerprint', 'TEXT'],
    ['matcher_version', 'TEXT'],
  ]

  const added = []
  if (isPg) {
    await db.prepare('CREATE EXTENSION IF NOT EXISTS pgcrypto').run()
  }
  for (const [name, type] of requiredColumns) {
    if (beforeColumns.has(name)) continue
    const addColumnSql = isPg
      ? `ALTER TABLE grants ADD COLUMN IF NOT EXISTS ${quoteIdentifier(name)} ${type}`
      : `ALTER TABLE grants ADD COLUMN ${quoteIdentifier(name)} ${type}`
    const changed = await runIgnoringDuplicateColumn(db, addColumnSql)
    if (changed) added.push(name)
  }

  const crawlerLogsExistsBefore = await tableExists(db, 'crawler_logs')
  if (!crawlerLogsExistsBefore) {
    await db.prepare(isPg
      ? `CREATE TABLE IF NOT EXISTS crawler_logs (
          id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          job_id       TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
          profile_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          crawler_type TEXT,
          level        TEXT,
          status       TEXT,
          message      TEXT,
          payload      JSONB,
          created_at   TIMESTAMPTZ DEFAULT NOW()
        )`
      : `CREATE TABLE IF NOT EXISTS crawler_logs (
          id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
          job_id       TEXT REFERENCES crawler_jobs(id) ON DELETE CASCADE,
          profile_id   TEXT REFERENCES profiles(id) ON DELETE SET NULL,
          crawler_type TEXT,
          level        TEXT,
          status       TEXT,
          message      TEXT,
          payload      TEXT,
          created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
        )`).run()
  }

  for (const indexSql of [
    'CREATE INDEX IF NOT EXISTS idx_grants_fingerprint ON grants(fingerprint)',
    'CREATE INDEX IF NOT EXISTS idx_grants_url ON grants(url)',
    'CREATE INDEX IF NOT EXISTS idx_crawler_logs_job ON crawler_logs(job_id)',
    'CREATE INDEX IF NOT EXISTS idx_crawler_logs_profile ON crawler_logs(profile_id)',
    'CREATE INDEX IF NOT EXISTS idx_crawler_logs_created_at ON crawler_logs(created_at)',
  ]) {
    await db.prepare(indexSql).run()
  }

  if (backfill) {
    const grantColumns = new Set(await tableColumns(db, 'grants'))
    const opportunityColumns = await tableColumns(db, 'funding_opportunities').catch(() => [])
    const opportunityUrlColumns = ['application_url', 'apply_url', 'source_url', 'evidence_url']
      .filter((name) => opportunityColumns.includes(name))

    const grantUrlExpressions = ['NULLIF(g.url, \'\')']
    for (const name of ['application_url', 'portal_url']) {
      if (grantColumns.has(name)) grantUrlExpressions.push(`NULLIF(g.${name}, '')`)
    }
    const opportunityUrlExpressions = opportunityUrlColumns.map((name) => `NULLIF(fo.${name}, '')`)
    if (grantColumns.has('funding_opportunity_id') && opportunityUrlExpressions.length > 0) {
      if (isPg) {
        await db.prepare(`
          UPDATE grants g
          SET url = COALESCE(${[...grantUrlExpressions, ...opportunityUrlExpressions].join(', ')})
          FROM funding_opportunities fo
          WHERE fo.id = g.funding_opportunity_id
            AND (g.url IS NULL OR g.url = '')
        `).run()
      } else {
        await db.prepare(`
          UPDATE grants AS g
          SET url = COALESCE(
            ${grantUrlExpressions.join(', ')},
            (
              SELECT COALESCE(${opportunityUrlExpressions.join(', ')})
              FROM funding_opportunities fo
              WHERE fo.id = g.funding_opportunity_id
              LIMIT 1
            )
          )
          WHERE g.url IS NULL OR g.url = ''
        `).run()
      }
    }

    await db.prepare(isPg
      ? `UPDATE grants SET matched_needs = '[]' WHERE profile_id IS NOT NULL AND (matched_needs IS NULL OR matched_needs::text IN ('', 'null'))`
      : `UPDATE grants SET matched_needs = '[]' WHERE profile_id IS NOT NULL AND (matched_needs IS NULL OR matched_needs = '')`).run()
    await db.prepare(`UPDATE grants SET match_decision = COALESCE(NULLIF(match_decision, ''), 'review') WHERE match_decision IS NULL OR match_decision = ''`).run()
    await db.prepare(isPg
      ? `UPDATE grants SET match_explanation = '{"source":"admin_schema_repair","reason":"Runtime repair backfill"}' WHERE match_explanation IS NULL OR match_explanation::text IN ('', 'null')`
      : `UPDATE grants SET match_explanation = '{"source":"admin_schema_repair","reason":"Runtime repair backfill"}' WHERE match_explanation IS NULL OR match_explanation = ''`).run()
    await db.prepare(`UPDATE grants SET fingerprint = COALESCE(NULLIF(fingerprint, ''), COALESCE(NULLIF(opportunity_fingerprint, ''), id)) WHERE fingerprint IS NULL OR fingerprint = ''`).run()
    await db.prepare(`UPDATE grants SET fingerprint_version = COALESCE(fingerprint_version, 1) WHERE fingerprint_version IS NULL`).run()
    await db.prepare(isPg
      ? `UPDATE grants SET profile_fingerprint = COALESCE(NULLIF(profile_fingerprint, ''), profile_id::text || ':admin-schema-repair') WHERE profile_id IS NOT NULL AND (profile_fingerprint IS NULL OR profile_fingerprint = '')`
      : `UPDATE grants SET profile_fingerprint = COALESCE(NULLIF(profile_fingerprint, ''), profile_id || ':admin-schema-repair') WHERE profile_id IS NOT NULL AND (profile_fingerprint IS NULL OR profile_fingerprint = '')`).run()
    const opportunityFingerprintFallback = grantColumns.has('funding_opportunity_id')
      ? (isPg
          ? "COALESCE(NULLIF(fingerprint, ''), funding_opportunity_id::text, id::text)"
          : "COALESCE(NULLIF(fingerprint, ''), funding_opportunity_id, id)")
      : (isPg
          ? "COALESCE(NULLIF(fingerprint, ''), id::text)"
          : "COALESCE(NULLIF(fingerprint, ''), id)")
    await db.prepare(`UPDATE grants SET opportunity_fingerprint = COALESCE(NULLIF(opportunity_fingerprint, ''), ${opportunityFingerprintFallback}) WHERE opportunity_fingerprint IS NULL OR opportunity_fingerprint = ''`).run()
    await db.prepare(`UPDATE grants SET matcher_version = COALESCE(NULLIF(matcher_version, ''), 'admin-schema-repair-v2') WHERE matcher_version IS NULL OR matcher_version = ''`).run()

    const hasCrawlerJobs = await tableExists(db, 'crawler_jobs')
    if (hasCrawlerJobs) {
      await db.prepare(isPg
        ? `INSERT INTO crawler_logs (job_id, profile_id, crawler_type, level, status, message, payload)
           SELECT id, profile_id, type, 'info', COALESCE(status, 'completed'), 'Backfilled profile-scoped crawler log for mission verification', '{"source":"runtime_admin_schema_repair"}'::jsonb
           FROM crawler_jobs
           WHERE profile_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM crawler_logs cl WHERE cl.job_id = crawler_jobs.id AND cl.profile_id = crawler_jobs.profile_id)`
        : `INSERT INTO crawler_logs (job_id, profile_id, crawler_type, level, status, message, payload)
           SELECT id, profile_id, type, 'info', COALESCE(status, 'completed'), 'Backfilled profile-scoped crawler log for mission verification', '{"source":"runtime_admin_schema_repair"}'
           FROM crawler_jobs
           WHERE profile_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM crawler_logs cl WHERE cl.job_id = crawler_jobs.id AND cl.profile_id = crawler_jobs.profile_id)`).run()
    }
  }

  return {
    applied: added.length > 0 || !crawlerLogsExistsBefore,
    added_columns: added,
    crawler_logs_created: !crawlerLogsExistsBefore,
  }
}
