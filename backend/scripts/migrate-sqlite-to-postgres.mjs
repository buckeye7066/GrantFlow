import Database from 'better-sqlite3'
import pg from 'pg'
import path from 'path'

const { Pool } = pg

function parseArgs(argv) {
  const args = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i++
    }
  }
  return args
}

function isTruthy(v) {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(v || '').toLowerCase())
}

function shouldUseSsl(connectionString) {
  if (!connectionString) return false
  // Parse the actual host/query instead of substring-matching the raw
  // connection string, so a value like "postgres://x@evil-proxy.rlwy.net.attacker.example/db"
  // or a password/db-name that happens to contain "localhost" can't flip the
  // SSL decision the wrong way.
  let parsed
  try {
    parsed = new URL(connectionString)
  } catch {
    return true
  }
  const host = (parsed.hostname || '').toLowerCase()
  // Railway public proxy almost always requires SSL.
  if (host === 'proxy.rlwy.net' || host.endsWith('.proxy.rlwy.net')) return true
  if ((parsed.searchParams.get('sslmode') || '').toLowerCase() === 'require') return true
  if (host === 'localhost' || host === '127.0.0.1') return false
  return true
}

function redactConnString(value) {
  return String(value || '').replace(/:(?:[^@/]+)@/, ':***@')
}

async function getPgColumns(pool, tableName) {
  const { rows } = await pool.query(
    `
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position ASC
    `,
    [tableName],
  )
  const map = new Map()
  for (const r of rows) map.set(r.column_name, { data_type: r.data_type, udt_name: r.udt_name })
  return map
}

async function getPgPrimaryKeyColumns(pool, tableName) {
  const { rows } = await pool.query(
    `
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass
        AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)
    `,
    [tableName],
  )
  return rows.map(r => r.column_name)
}

async function getPgUniqueConstraints(pool, tableName) {
  const { rows } = await pool.query(
    `
      SELECT
        con.conname AS name,
        con.contype AS type,
        array_agg(att.attname ORDER BY u.ordinality) AS columns
      FROM pg_constraint con
      JOIN unnest(con.conkey) WITH ORDINALITY AS u(attnum, ordinality) ON true
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.attnum
      WHERE con.conrelid = $1::regclass
        AND con.contype IN ('p','u')
      GROUP BY con.conname, con.contype
      ORDER BY con.contype DESC, array_length(array_agg(att.attname), 1) ASC
    `,
    [tableName],
  )
  return rows.map(r => ({ name: r.name, type: r.type, columns: normalizePgArray(r.columns) }))
}

function normalizePgArray(v) {
  if (!v) return []
  if (Array.isArray(v)) return v
  if (typeof v !== 'string') return []

  // pg often returns text[] as "{a,b}".
  let s = v.trim()
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1)
  if (s === '') return []

  // Simple split (column names here are safe identifiers; no embedded commas expected).
  return s.split(',').map(x => x.replace(/^"(.*)"$/, '$1').trim()).filter(Boolean)
}

function getSqliteColumns(sqliteDb, tableName) {
  try {
    return sqliteDb.prepare(`PRAGMA table_info(${tableName})`).all().map(r => r.name)
  } catch {
    return null
  }
}

async function getPgCount(pool, tableName) {
  const { rows } = await pool.query(`SELECT COUNT(*)::bigint AS c FROM "${tableName}"`)
  return Number(rows?.[0]?.c || 0)
}

function getSqliteCount(sqliteDb, tableName) {
  try {
    return Number(sqliteDb.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get()?.c || 0)
  } catch {
    return null
  }
}

function toPgValue(val, pgColType) {
  if (val === undefined) return null
  if (val === null) return null

  const t = (pgColType?.data_type || '').toLowerCase()
  const udt = (pgColType?.udt_name || '').toLowerCase()

  const isBool = t === 'boolean'
  const isJson = t === 'json' || t === 'jsonb' || udt === 'json' || udt === 'jsonb'
  const isDate = t === 'date'
  const isTimestamp = t.includes('timestamp') || t === 'timestamp with time zone' || t === 'timestamp without time zone'

  if (isBool) {
    if (val === 1 || val === '1') return true
    if (val === 0 || val === '0') return false
    if (typeof val === 'boolean') return val
    if (typeof val === 'string') return isTruthy(val)
    return Boolean(val)
  }

  if (isDate || isTimestamp) {
    // SQLite often stores dates as TEXT; some values are non-dates ("Rolling", "Ongoing").
    if (typeof val === 'string') {
      const s = val.trim()
      if (!s) return null
      if (/^(rolling|ongoing|open|varies|tbd|unknown|none)$/i.test(s)) return null

      const ms = Date.parse(s)
      if (Number.isNaN(ms)) return null

      if (isDate) {
        // YYYY-MM-DD
        const d = new Date(ms)
        const yyyy = d.getUTCFullYear()
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
        const dd = String(d.getUTCDate()).padStart(2, '0')
        return `${yyyy}-${mm}-${dd}`
      }
      return new Date(ms).toISOString()
    }
  }

  if (isJson) {
    if (typeof val === 'object') return val
    if (typeof val === 'string') {
      try {
        return JSON.parse(val)
      } catch {
        // Preserve as string-ish json to avoid failing the whole row
        return val.startsWith('[') ? [] : val.startsWith('{') ? {} : { value: val }
      }
    }
  }

  return val
}

function buildInsertSql(tableName, cols, conflictCols) {
  const colList = cols.map(c => `"${c}"`).join(', ')
  const conflictTarget =
    conflictCols && conflictCols.length > 0 ? `(${conflictCols.map(c => `"${c}"`).join(', ')})` : null

  const updateCols = conflictCols?.length
    ? cols.filter(c => !conflictCols.includes(c))
    : []

  const updateSet =
    updateCols.length > 0
      ? updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')
      : null

  const onConflict =
    conflictTarget && updateSet
      ? `ON CONFLICT ${conflictTarget} DO UPDATE SET ${updateSet}`
      : conflictTarget
        ? `ON CONFLICT ${conflictTarget} DO NOTHING`
        : `ON CONFLICT DO NOTHING`

  return { colList, onConflict }
}

async function getBestConflictColumns(pool, tableName, availableCols) {
  const constraints = await getPgUniqueConstraints(pool, tableName)

  // Table-specific “known good” uniqueness (avoids id-vs-natural-key collisions).
  if (
    tableName === 'profile_sections' &&
    availableCols.includes('profile_id') &&
    availableCols.includes('section_key')
  ) {
    return ['profile_id', 'section_key']
  }

  const pk = constraints.find(c => c.type === 'p')?.columns || []

  // Prefer smallest UNIQUE constraint that doesn't involve id, and that we can satisfy with inserted cols.
  const uniqueCandidates = constraints
    .filter(c => c.type === 'u')
    .map(c => c.columns)
    .filter(cols => cols.length > 0)
    .filter(cols => cols.every(c => availableCols.includes(c)))
    .sort((a, b) => a.length - b.length)

  const nonIdUnique = uniqueCandidates.find(cols => !cols.includes('id'))
  if (nonIdUnique) return nonIdUnique
  if (uniqueCandidates.length > 0) return uniqueCandidates[0]

  // Fallback to primary key.
  const pkOk = (Array.isArray(pk) ? pk : normalizePgArray(pk)).filter(c => availableCols.includes(c))
  return pkOk
}

async function migrateTable({ sqliteDb, pool, tableName, dryRun, batchSize }) {
  const sqliteCols = getSqliteColumns(sqliteDb, tableName)
  if (!sqliteCols || sqliteCols.length === 0) {
    console.log(`- ${tableName}: skip (missing in sqlite)`)
    return { tableName, sqliteTotal: 0, migrated: 0, skipped: 0 }
  }

  const pgColsMap = await getPgColumns(pool, tableName)
  if (pgColsMap.size === 0) {
    console.log(`- ${tableName}: skip (missing in postgres)`)
    return { tableName, sqliteTotal: 0, migrated: 0, skipped: 0 }
  }

  const commonCols = sqliteCols.filter(c => pgColsMap.has(c))
  if (commonCols.length === 0) {
    console.log(`- ${tableName}: skip (no common columns)`)
    return { tableName, sqliteTotal: 0, migrated: 0, skipped: 0 }
  }

  const conflictCols = await getBestConflictColumns(pool, tableName, commonCols)
  const { colList, onConflict } = buildInsertSql(tableName, commonCols, conflictCols)

  const total = sqliteDb.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get()?.c || 0
  console.log(
    `- ${tableName}: ${total} row(s), cols=${commonCols.length}, conflict=${conflictCols.join(',') || 'n/a'}`,
  )
  if (total === 0) return { tableName, sqliteTotal: 0, migrated: 0, skipped: 0 }

  const selectSql = `SELECT ${commonCols.map(c => `"${c}"`).join(', ')} FROM ${tableName}`
  const iter = sqliteDb.prepare(selectSql).iterate()

  let migrated = 0
  let batch = []

  const flush = async () => {
    if (batch.length === 0) return
    const rows = batch
    batch = []

    const values = []
    const placeholders = []
    let idx = 1
    for (const r of rows) {
      const rowVals = []
      for (const c of commonCols) {
        rowVals.push(toPgValue(r[c], pgColsMap.get(c)))
      }
      values.push(...rowVals)
      const rowPh = commonCols.map(() => `$${idx++}`)
      placeholders.push(`(${rowPh.join(', ')})`)
    }

    const sql = `INSERT INTO "${tableName}" (${colList}) VALUES ${placeholders.join(', ')} ${onConflict}`

    if (!dryRun) {
      await pool.query(sql, values)
    }

    migrated += rows.length
  }

  for (const row of iter) {
    batch.push(row)
    if (batch.length >= batchSize) await flush()
  }
  await flush()

  return { tableName, sqliteTotal: total, migrated, skipped: total - migrated }
}

async function main() {
  const args = parseArgs(process.argv)
  const sqlitePath =
    args.sqlite ||
    process.env.SQLITE_DB_PATH ||
    path.resolve(process.cwd(), 'seed', 'grantflow.db')
  const postgresUrl = args.postgres || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
  const dryRun = Boolean(args['dry-run'])
  const batchSize = Number(args.batch || 300)
  const verifyCounts = args['verify-counts'] !== undefined ? isTruthy(args['verify-counts']) : true
  const assertFresh = args['assert-fresh'] !== undefined ? isTruthy(args['assert-fresh']) : true

  if (!postgresUrl) {
    console.error('Missing Postgres URL. Provide --postgres or set DATABASE_PUBLIC_URL.')
    process.exit(1)
  }

  console.log('=== SQLite → Postgres Migration ===')
  console.log('sqlite:', sqlitePath)
  console.log('postgres:', redactConnString(postgresUrl))
  console.log('dryRun:', dryRun)
  console.log('batchSize:', batchSize)
  console.log('verifyCounts:', verifyCounts)
  console.log('assertFresh:', assertFresh)

  const sqliteDb = new Database(sqlitePath, { readonly: true, fileMustExist: true })

  const pool = new Pool({
    connectionString: postgresUrl,
    max: 4,
    ...(shouldUseSsl(postgresUrl) ? { ssl: { rejectUnauthorized: false } } : {}),
  })

  const tablesInOrder = [
    // core identities
    'users',
    'organizations',
    'profiles',
    'profile_sections',
    // docs + links
    'documents',
    'profile_documents',
    // auth/session-ish (optional)
    'user_credentials',
    'user_sessions',
    'auth_refresh_token_history',
    'user_verification_codes',
    'oauth_states',
    'app_runtime_secrets',
    // opportunities + pipeline
    'funding_opportunities',
    'grants',
    'expenses',
    // crawler/audit
    'crawler_jobs',
    'crawl_logs',
    'audit_logs',
    'service_applications',
  ]

  const results = []

  try {
    // Keep it safe but fast.
    await pool.query('SET statement_timeout = 0')
    await pool.query('BEGIN')

    if (assertFresh) {
      for (const t of tablesInOrder) {
        const c = await getPgCount(pool, t)
        if (c !== 0) {
          throw new Error(
            `Target Postgres is not empty. Table "${t}" has ${c} row(s). Re-run with --assert-fresh false if intentional.`,
          )
        }
      }
      console.log('✓ Target Postgres appears fresh (all target tables empty).')
    }

    for (const t of tablesInOrder) {
      const r = await migrateTable({ sqliteDb, pool, tableName: t, dryRun, batchSize })
      results.push(r)
    }

    if (verifyCounts) {
      console.log('\n=== Verification (row counts) ===')
      const mismatches = []
      for (const r of results) {
        const sqliteTotal = Number(r.sqliteTotal || 0)
        const pgTotal = await getPgCount(pool, r.tableName)
        const ok = sqliteTotal === pgTotal
        console.log(
          `- ${r.tableName}: sqlite=${sqliteTotal} postgres=${pgTotal} ${ok ? '✓' : '✗'}`,
        )
        if (!ok) mismatches.push({ table: r.tableName, sqlite: sqliteTotal, postgres: pgTotal })
      }

      if (mismatches.length > 0) {
        const msg =
          `Row count mismatches detected (${mismatches.length}). ` +
          `This likely indicates conflicts/skips or a non-fresh target DB. ` +
          `First mismatch: ${mismatches[0].table} sqlite=${mismatches[0].sqlite} postgres=${mismatches[0].postgres}`
        throw new Error(msg)
      }

      console.log('✓ Verification passed (all table row counts match).')
    }

    if (dryRun) {
      await pool.query('ROLLBACK')
      console.log('Dry run complete (rolled back).')
    } else {
      await pool.query('COMMIT')
      console.log('Migration committed.')
    }
  } catch (e) {
    try {
      await pool.query('ROLLBACK')
    } catch { /* ignore */ }
    console.error('Migration failed:', e?.message || e)
    process.exitCode = 1
  } finally {
    try {
      sqliteDb.close()
    } catch { /* ignore */ }
    await pool.end()
  }

  const total = results.reduce((s, r) => s + (r.migrated || 0), 0)
  console.log('Total rows migrated:', total)
}

await main()
