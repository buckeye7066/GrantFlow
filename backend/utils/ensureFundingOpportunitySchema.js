/**
 * Boot-time self-heal for the funding_opportunities reality-gate columns.
 *
 * Production symptom (Railway logs):
 *   [comprehensiveCrawler] Error inserting ...: column "reality_status" of
 *   relation "funding_opportunities" does not exist
 *   [connectorIngest] complete {... inserted:0 ... lastError:"column
 *   \"reality_status\" ... does not exist"}
 *
 * Root cause: the columns are added by migration 0073 (Postgres) / 077
 * (SQLite), but the strict boot migration chain aborts on the first
 * non-idempotent migration against an already-populated DB, so it never
 * reaches 0073. Every crawler / connector / Robert write that targets
 * funding_opportunities then fails — the Funding Library can't take in new
 * data at all (mission goals #1, #6, #8).
 *
 * Fix: apply the reality-gate columns directly, idempotently, and
 * UNCONDITIONALLY at boot — independent of the _migrations ledger. Pure
 * ADD COLUMN IF NOT EXISTS (Postgres) / guarded ADD COLUMN (SQLite), so it is
 * a strict no-op once present and never throws fatally. Mirrors
 * ensureAgentSubsystemTables, which already cures the identical class of
 * "migration never applied → relation/column missing" production outage.
 */

// Columns added by 0073_funding_opportunities_reality_verdict.sql.
const REALITY_COLUMNS = [
  { name: 'reality_status', pg: 'TEXT', sqlite: 'TEXT' },
  { name: 'reality_reasons', pg: 'JSONB', sqlite: 'TEXT' },
  { name: 'final_url', pg: 'TEXT', sqlite: 'TEXT' },
  { name: 'http_status', pg: 'INTEGER', sqlite: 'INTEGER' },
]

// Identifier whitelist — names are hard-coded above, but guard anyway so a
// column name can never be interpolated unsafely into DDL.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

async function hasColumn(db, tableName, columnName) {
  try {
    if (db.dialect === 'postgres') {
      const row = await db
        .prepare(
          `SELECT 1 AS ok FROM information_schema.columns
            WHERE table_name = ? AND column_name = ? LIMIT 1`,
        )
        .get(tableName, columnName.toLowerCase())
      return Boolean(row && (row.ok === 1 || row.ok === true))
    }
    const cols = await db.prepare(`PRAGMA table_info(${tableName})`).all()
    return cols.some((c) => String(c.name).toLowerCase() === columnName.toLowerCase())
  } catch {
    return false
  }
}

function isAlreadyAppliedError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('already exists') ||
    msg.includes('duplicate column') ||
    (msg.includes('near "exists"') && msg.includes('syntax error'))
  )
}

/**
 * Ensure funding_opportunities has the reality-gate columns. Safe to call
 * repeatedly and on either dialect.
 *
 * @param {object} db - live DB handle (sqlite or postgres dialect)
 * @param {object} [opts]
 * @param {object} [opts.logger]
 * @returns {Promise<{ added: string[], present: string[], failed: Array<{column:string,error:string}> }>}
 */
export async function ensureFundingOpportunitySchema(db, { logger = console } = {}) {
  const out = { added: [], present: [], failed: [] }
  if (!db || typeof db.dialect !== 'string') {
    logger.warn?.('[funding-schema] no db handle, skipping')
    return out
  }

  for (const col of REALITY_COLUMNS) {
    if (!IDENT_RE.test(col.name)) continue
    if (await hasColumn(db, 'funding_opportunities', col.name)) {
      out.present.push(col.name)
      continue
    }
    const type = db.dialect === 'postgres' ? col.pg : col.sqlite
    try {
      if (db.dialect === 'postgres') {
        await db.exec(`ALTER TABLE funding_opportunities ADD COLUMN IF NOT EXISTS ${col.name} ${type}`)
      } else {
        // SQLite < 3.35 has no IF NOT EXISTS for ADD COLUMN; the hasColumn
        // guard above already prevents the duplicate, try/catch covers races.
        await db.exec(`ALTER TABLE funding_opportunities ADD COLUMN ${col.name} ${type}`)
      }
      out.added.push(col.name)
      logger.info?.(`[funding-schema] added funding_opportunities.${col.name}`)
    } catch (err) {
      if (isAlreadyAppliedError(err)) {
        out.present.push(col.name)
        continue
      }
      out.failed.push({ column: col.name, error: String(err?.message || err) })
      logger.warn?.(`[funding-schema] could not add ${col.name} (continuing): ${err?.message || err}`)
    }
  }

  // Index that 0073 also creates — idempotent, non-fatal.
  try {
    await db.exec(
      `CREATE INDEX IF NOT EXISTS idx_funding_opportunities_reality_status ON funding_opportunities(reality_status)`,
    )
  } catch (err) {
    logger.warn?.(`[funding-schema] reality_status index ensure skipped: ${err?.message || err}`)
  }

  if (out.added.length > 0 || out.failed.length > 0) {
    logger.info?.(
      `[funding-schema] self-heal complete: added=${out.added.length} present=${out.present.length} failed=${out.failed.length}`,
    )
  }
  return out
}
