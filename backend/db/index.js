import Database from 'better-sqlite3';
import pg from 'pg';

// Validate critical environment on startup
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { assertProfileScopedSql } from './scopedQuery.js';

// Validate critical environment on startup
if (process.env.NODE_ENV === 'production') {
  const hasRailwayEnv = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);
  const hasPostgresUrl = /^postgres(ql)?:\/\//i.test(String(process.env.DATABASE_URL || ''));
  const hasPostgresVars = Boolean(process.env.PGHOST && process.env.PGUSER && process.env.PGDATABASE);

  if (hasRailwayEnv && !hasPostgresUrl && !hasPostgresVars) {
    throw new Error('[db] FATAL: Railway production deployment detected but no Postgres configuration found. Set DATABASE_URL or PGHOST/PGUSER/PGDATABASE.');
  }
}

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function isPostgresUrl(value) {
  return /^postgres(ql)?:\/\//i.test(String(value || '').trim());
}

function inferPostgresUrlFromEnv() {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim()
  if (isPostgresUrl(databaseUrl)) return databaseUrl

  // Many managed Postgres providers (including Railway) inject PG* vars rather than DATABASE_URL.
  const host = String(process.env.PGHOST || process.env.POSTGRES_HOST || '').trim()
  const port = String(process.env.PGPORT || process.env.POSTGRES_PORT || '5432').trim()
  const user = String(process.env.PGUSER || process.env.POSTGRES_USER || '').trim()
  const password = String(process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || '').trim()
  const database = String(process.env.PGDATABASE || process.env.POSTGRES_DB || '').trim()
  const sslMode = String(process.env.PGSSLMODE || '').trim()

  if (!host || !user || !database) return null

  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user)
  const base = `postgres://${auth}@${host}:${port}/${encodeURIComponent(database)}`

  // Railway Postgres commonly requires SSL; we accept explicit PGSSLMODE as a signal,
  // otherwise we default SSL-on for production Railway runtimes.
  const forceSsl = Boolean(sslMode) || (isProd() && isRailwayRuntime())
  return forceSsl ? `${base}?sslmode=require` : base
}

function normalizeProvider(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'pg') return 'postgres';
  if (v === 'postgresql') return 'postgres';
  return v;
}

function detectProvider() {
  // Railway production invariant:
  // If Railway provides a Postgres DATABASE_URL, always prefer Postgres even if DB_PROVIDER is stale/mis-set.
  const isRailway =
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RAILWAY_PROJECT_ID) ||
    Boolean(process.env.RAILWAY_SERVICE_ID)
  const inferredUrl = inferPostgresUrlFromEnv()
  if (isRailway && inferredUrl) return 'postgres'

  const explicit =
    normalizeProvider(process.env.DB_PROVIDER) ||
    normalizeProvider(process.env.DB_DIALECT);
  const hasPostgresUrl = Boolean(inferredUrl)

  // Production safety: prefer Postgres when a postgres:// DATABASE_URL is present,
  // even if an old DB_PROVIDER/DB_DIALECT value is still set to sqlite.
  // This prevents "DB_PROVIDER=sqlite" config drift from taking the service down.
  if (hasPostgresUrl) {
    if (explicit && explicit !== 'postgres' && isProd()) {
      console.warn(
        `[db] Overriding DB_PROVIDER/DB_DIALECT="${explicit}" to "postgres" because DATABASE_URL is a postgres:// URL (production).`,
      )
      return 'postgres'
    }
    if (!explicit) return 'postgres'
  }

  if (explicit) return explicit;
  return 'sqlite';
}

function isProd() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production';
}

function isRailwayRuntime() {
  // Railway sets a variety of env vars; treat any of these as strong signal.
  return Boolean(
    process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_SERVICE_ID ||
      process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_STATIC_URL ||
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.RAILWAY_DEPLOYMENT_ID,
  )
}

function looksLikeRailwayVolumePath(p) {
  // Railway persistent volumes are commonly mounted at /mnt/data
  return typeof p === 'string' && p.replace(/\\/g, '/').startsWith('/mnt/data/');
}

function resolveDefaultSqlitePath(dataDir) {
  const explicit = process.env.SQLITE_DB_PATH;
  if (explicit && String(explicit).trim()) return String(explicit).trim();

  // Production safety: prefer Railway persistent volume if present.
  // This prevents "lost data" on redeploy when SQLITE_DB_PATH isn't configured.
  const railwayDir = '/mnt/data';
  try {
    if (fs.existsSync(railwayDir) && fs.statSync(railwayDir).isDirectory()) {
      // Verify volume is actually writable
      const testFile = join(railwayDir, '.write-test');
      fs.writeFileSync(testFile, 'test');
      fs.unlinkSync(testFile);
      return join(railwayDir, 'grantflow.db');
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'production' && isRailwayRuntime()) {
      console.error('[db] Railway volume /mnt/data exists but is not writable:', error.message);
    }
  }

  return join(dataDir, 'grantflow.db');
}

function isArrayArgList(args) {
  return args.length === 1 && Array.isArray(args[0]);
}

function toParamArray(args) {
  return isArrayArgList(args) ? args[0] : args;
}

function normalizePostgresParams(values) {
  if (!Array.isArray(values)) return values
  return values.map((v) => {
    if (v === undefined) return null
    if (typeof v === 'object' && v !== null && !Buffer.isBuffer(v) && !(v instanceof Date) && !Array.isArray(v)) {
      try { return JSON.stringify(v) } catch { return String(v) }
    }
    return v
  })
}

// Convert SQLite-style `?` placeholders to Postgres-style `$1, $2, ...`.
// We only replace placeholders that are outside of single/double-quoted strings.
function qmarkToDollarPlaceholders(sql) {
  let out = '';
  let idx = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      out += ch;
      if (ch === '*' && sql[i + 1] === '/') {
        out += '/';
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === '-' && sql[i + 1] === '-') {
        out += '--';
        i++;
        inLineComment = true;
        continue;
      }
      if (ch === '/' && sql[i + 1] === '*') {
        out += '/*';
        i++;
        inBlockComment = true;
        continue;
      }
    }

    if (ch === "'" && !inDouble) {
      // Handle escaped single quotes '' inside single-quoted strings
      if (inSingle && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      out += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    if (ch === '?' && !inSingle && !inDouble) {
      idx += 1;
      out += `$${idx}`;
      continue;
    }

    out += ch;
  }

  return { text: out, count: idx };
}

// Convert SQLite-style named parameters (e.g. @id) to Postgres-style ($1, $2, ...).
// Returns the ordered parameter name list to map object bindings to an array.
function atNameToDollarPlaceholders(sql) {
  let out = '';
  const names = [];
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (inLineComment) {
      out += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      out += ch;
      if (ch === '*' && sql[i + 1] === '/') {
        out += '/';
        i++;
        inBlockComment = false;
      }
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === '-' && sql[i + 1] === '-') {
        out += '--';
        i++;
        inLineComment = true;
        continue;
      }
      if (ch === '/' && sql[i + 1] === '*') {
        out += '/*';
        i++;
        inBlockComment = true;
        continue;
      }
    }

    if (ch === "'" && !inDouble) {
      if (inSingle && sql[i + 1] === "'") {
        out += "''";
        i++;
        continue;
      }
      inSingle = !inSingle;
      out += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      out += ch;
      continue;
    }

    if (ch === '@' && !inSingle && !inDouble) {
      // Parse identifier: @foo_bar123
      let j = i + 1;
      let ident = '';
      while (j < sql.length) {
        const c = sql[j];
        if (!/[A-Za-z0-9_]/.test(c)) break;
        ident += c;
        j++;
      }
      if (ident.length > 0) {
        names.push(ident);
        out += `$${names.length}`;
        i = j - 1;
        continue;
      }
    }

    out += ch;
  }

  return { text: out, names };
}

function isObjectBindings(args) {
  return args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0]);
}

function bindingsToValues(names, bindings) {
  return names.map((name) => bindings[name]);
}

export function normalizeSqliteValue(value) {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value instanceof Date) return value.toISOString()
  // better-sqlite3 cannot bind objects/arrays; stringify for TEXT/JSON columns.
  // (Buffers are handled by SQLite directly; Dates handled above.)
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return value
}

export function normalizeSqliteArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) {
    return [args[0].map(normalizeSqliteValue)]
  }
  if (
    args.length === 1 &&
    args[0] &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0]) &&
    !(args[0] instanceof Date) &&
    !Buffer.isBuffer(args[0])
  ) {
    const bindings = args[0]
    const normalized = {}
    for (const [key, val] of Object.entries(bindings)) {
      normalized[key] = normalizeSqliteValue(val)
    }
    return [normalized]
  }
  return args.map(normalizeSqliteValue)
}

function formatPgSyntaxSnippet({ sql, position }) {
  const rawSql = String(sql || '')
  const pos = Number(position)
  if (!rawSql || !Number.isFinite(pos) || pos <= 0) return null

  // Postgres positions are 1-based character offsets.
  const index = Math.max(0, Math.min(rawSql.length, pos - 1))
  const window = 80
  const start = Math.max(0, index - window)
  const end = Math.min(rawSql.length, index + window)

  const snippet = rawSql
    .slice(start, end)
    .replace(/\s+/g, ' ')
    .trim()

  return snippet ? `…${snippet}…` : null
}

function decoratePgErrorWithSqlSnippet(error, sql) {
  const code = error?.code ? String(error.code) : null
  if (code !== '42601') return error // syntax_error

  const snippet = formatPgSyntaxSnippet({ sql, position: error?.position })
  if (!snippet) return error

  const baseMessage = error instanceof Error ? error.message : String(error)
  const nextMessage = `${baseMessage} (sql_snippet=${snippet})`

  if (error instanceof Error) {
    error.message = nextMessage
    return error
  }

  return new Error(nextMessage)
}

class SqliteDb {
  constructor(sqlitePath) {
    this.dialect = 'sqlite';
    this.path = sqlitePath;
    this._db = new Database(sqlitePath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma(`busy_timeout = ${Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000)}`);
    this._db.pragma('synchronous = NORMAL');
    this._db.pragma('foreign_keys = ON');
    this._db.pragma(`cache_size = ${Number(process.env.SQLITE_CACHE_SIZE_KB || -64000)}`);
    this._db.pragma('temp_store = MEMORY');
  }

  // Compatibility with better-sqlite3 API used throughout the codebase.
  // Returns a function that runs `fn` inside a transaction.
  transaction(fn) {
    const wrapped = this._db.transaction(fn);
    return (...args) => wrapped(...args);
  }

  prepare(sql) {
    assertProfileScopedSql(sql);
    const stmt = this._db.prepare(sql);
    return {
      get: (...args) => stmt.get(...normalizeSqliteArgs(args)),
      all: (...args) => stmt.all(...normalizeSqliteArgs(args)),
      run: (...args) => stmt.run(...normalizeSqliteArgs(args)),
    };
  }

  exec(sql) {
    return this._db.exec(sql);
  }

  /**
   * better-sqlite3 escape hatch for migrations that need to modify
   * sqlite_master (e.g. RC-13 widening the grants.status CHECK without a
   * full table rebuild). Pass-through to the raw connection so callers can
   * temporarily flip unsafe mode + writable_schema.
   */
  unsafeMode(enable) {
    return this._db.unsafeMode(Boolean(enable))
  }

  async healthcheck() {
    // Keep async signature for parity with Postgres, but run synchronously here.
    this.prepare('SELECT 1 as ok').get();
    return { ok: true, dialect: this.dialect };
  }

  async withTransaction(fn) {
    // Always use manual BEGIN/COMMIT/ROLLBACK rather than better-sqlite3's
    // native transaction() wrapper.  The native wrapper rejects async callbacks
    // with "Transaction function cannot return a promise" and detecting async
    // reliably across Node versions / transpilers proved fragile.  The manual
    // path works for both sync and async callbacks.
    while (this._asyncTxLock) {
      await this._asyncTxLock;
    }
    let unlock;
    this._asyncTxLock = new Promise((r) => { unlock = r; });

    this._db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this._db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this._db.exec('ROLLBACK'); } catch { /* ignore rollback errors */ }
      throw err;
    } finally {
      this._asyncTxLock = null;
      unlock();
    }
  }

  close() {
    this._db.close();
  }
}

class PostgresTx {
  constructor(client) {
    this.dialect = 'postgres';
    this._client = client;
  }

  prepare(sql) {
    assertProfileScopedSql(sql);
        sql = fixBooleanIntegers(sql);
    const hasNamed = /@[_A-Za-z][_A-Za-z0-9]*/.test(sql);
    const converted = hasNamed ? atNameToDollarPlaceholders(sql) : qmarkToDollarPlaceholders(sql);
    return {
      get: async (...args) => {
        const values = normalizePostgresParams(
          hasNamed && isObjectBindings(args)
            ? bindingsToValues(converted.names, args[0])
            : toParamArray(args));
        try {
          const res = await this._client.query(converted.text, values);
          return res.rows[0];
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      all: async (...args) => {
        const values = normalizePostgresParams(
          hasNamed && isObjectBindings(args)
            ? bindingsToValues(converted.names, args[0])
            : toParamArray(args));
        try {
          const res = await this._client.query(converted.text, values);
          return res.rows;
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      run: async (...args) => {
        const values = normalizePostgresParams(
          hasNamed && isObjectBindings(args)
            ? bindingsToValues(converted.names, args[0])
            : toParamArray(args));
        try {
          const res = await this._client.query(converted.text, values);
          return {
            changes: res.rowCount ?? 0,
            lastInsertRowid: null,
          };
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
    };
  }

  async exec(sql) {
    await this._client.query({ text: sql, queryMode: 'simple' });
  }
}


// Fix SQLite boolean-as-integer comparisons for PostgreSQL compatibility.
// SQLite uses INTEGER for booleans (0/1), but PostgreSQL uses BOOLEAN (TRUE/FALSE).
// This converts patterns like "is_active = 1" to "is_active = TRUE" for known boolean column prefixes.
// Only rewrite known boolean column names that are definitively boolean in the schema.
// Do NOT use a prefix wildcard (is_\w+) as it matches integer columns like is_priority_level.
const KNOWN_BOOLEAN_COLUMNS = [
  'is_active', 'is_archived', 'is_verified', 'is_published', 'is_deleted',
  'is_eligible', 'is_approved', 'is_rejected', 'is_flagged', 'is_locked',
  'is_recurring', 'is_featured', 'is_hidden', 'is_system',
  'active', 'activated', 'verified', 'archived', 'published', 'ocr_used',
  // funding_opportunities / grants boolean columns. These are BOOLEAN in the
  // Postgres schema but were stored as 0/1 integers under SQLite, so any
  // unguarded `is_national = 1` / `requires_match = 0` style comparison threw
  // `operator does not exist: boolean = integer` (HTTP 500) on the funding
  // pipeline. Listing them here lets the shim rewrite `= 1`/`= 0` to
  // `= TRUE`/`= FALSE` everywhere, instead of relying on each call site to
  // hand-write an `isPostgres ? 'IS TRUE' : '= 1'` branch.
  'is_national', 'is_loan', 'requires_match', 'requires_501c3',
  'usable_for_housing', 'refund_potential', 'verified_url',
  // Hamilton automation booleans (hamilton_blockers / portal policies +
  // providers). These are BOOLEAN in Postgres, so any inline `= 1`/`= 0`
  // literal (e.g. the hard-stop resolver marking requires_user_action) must
  // be rewritten to TRUE/FALSE or Postgres throws "boolean = integer".
  'requires_user_action', 'admin_required', 'user_required',
  'automation_allowed', 'agent_submission_allowed', 'scraping_allowed',
  'api_available', 'manual_only', 'live_supported', 'automation_supported',
  'session_reuse_supported', 'credential_reference_supported',
  'captcha_likely', 'two_factor_likely',
  // application_missing_info.resolved / dead_letter_queue.resolved — BOOLEAN in
  // Postgres. enforceInvariants.js and applicationTaskStore.js queried
  // `resolved = 0`, which threw "operator does not exist: boolean = integer"
  // on every call (caught and silently swallowed to [] by the caller's
  // try/catch, so the blocked-task re-check invariant silently no-op'd).
  'resolved'
];
const BOOL_COL_PATTERN = KNOWN_BOOLEAN_COLUMNS.map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const BOOL_TRUE_RE = new RegExp(`\\b(${BOOL_COL_PATTERN})\\s*=\\s*1\\b`, 'gi');
const BOOL_FALSE_RE = new RegExp(`\\b(${BOOL_COL_PATTERN})\\s*=\\s*0\\b`, 'gi');

export function fixBooleanIntegers(sql) {
  return sql
    .replace(BOOL_TRUE_RE, '$1 = TRUE')
    .replace(BOOL_FALSE_RE, '$1 = FALSE');
}
class PostgresDb {
  constructor(connectionString) {
    this.dialect = 'postgres';
    this.url = connectionString;
    this._poolEnded = false;
    const sslMode = String(process.env.PGSSLMODE || '').trim().toLowerCase();
    const requireSsl = connectionString.includes('sslmode=require') || (isProd() && isRailwayRuntime() && sslMode !== 'disable');
    this._pool = new Pool({
      connectionString,
      max: Number(process.env.DB_POOL_MAX || process.env.PG_POOL_MAX || 20),
      idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PG_POOL_CONN_TIMEOUT_MS || 10000),
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
      ...(requireSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    this._pool.on('error', (err) => {
      console.error('[db] PostgreSQL pool background error:', err?.message || err)
    })
  }

  prepare(sql) {
    assertProfileScopedSql(sql);
        sql = fixBooleanIntegers(sql);
    const hasNamed = /@[_A-Za-z][_A-Za-z0-9]*/.test(sql);
    const converted = hasNamed ? atNameToDollarPlaceholders(sql) : qmarkToDollarPlaceholders(sql);
    return {
      get: async (...args) => {
        const values = normalizePostgresParams(
          hasNamed && isObjectBindings(args) ? bindingsToValues(converted.names, args[0]) : toParamArray(args));
        try {
          const res = await this._pool.query(converted.text, values);
          return res.rows[0];
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      all: async (...args) => {
        const values = normalizePostgresParams(
          hasNamed && isObjectBindings(args) ? bindingsToValues(converted.names, args[0]) : toParamArray(args));
        try {
          const res = await this._pool.query(converted.text, values);
          return res.rows;
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      run: async (...args) => {
        const values = normalizePostgresParams(
          hasNamed && isObjectBindings(args) ? bindingsToValues(converted.names, args[0]) : toParamArray(args));
        try {
          const res = await this._pool.query(converted.text, values);
          return {
            changes: res.rowCount ?? 0,
            lastInsertRowid: null,
          };
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
    };
  }

  async exec(sql) {
    await this._pool.query({ text: sql, queryMode: 'simple' });
  }

  async healthcheck() {
    await this.prepare('SELECT 1 as ok').get();
    return { ok: true, dialect: this.dialect };
  }

  async withTransaction(fn) {
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PostgresTx(client);
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // Compatibility shim: many existing call sites use better-sqlite3's `db.transaction(fn)()`.
  // Under Postgres this returns an async function (callers must `await` it when we flip DB_PROVIDER).
  transaction(fn) {
    // Wrap fn so it runs inside a transaction.
    // The callback receives the same arguments it would under better-sqlite3
    // (no injected tx object) so existing call sites work without modification.
    // Code that needs an explicit tx object should call withTransaction() directly.
    return async (...args) => this.withTransaction(() => fn(...args));
  }

  async close() {
    if (this._poolEnded) return
    this._poolEnded = true
    await this._pool.end();
  }
}

let singleton = null;

export function getDb() {
  if (singleton) {
    // Validate singleton is still healthy in production
    if (process.env.NODE_ENV === 'production') {
      try {
        if (singleton.dialect === 'sqlite') {
          singleton._db.prepare('SELECT 1').get();
        } else if (singleton.dialect === 'postgres') {
          // Non-blocking: only re-create if healthcheck rejects.
          // We do NOT await here to keep getDb() synchronous at the call site;
          // broken pools will surface on the next real query.
          singleton.healthcheck().catch((error) => {
            console.error('[db] Postgres singleton healthcheck failed, clearing singleton for recreation on next call:', error.message);
            singleton = null;
          });
        }
      } catch (error) {
        console.error('[db] Singleton database connection is broken, recreating:', error.message);
        singleton = null;
      }
    }
    if (singleton) return singleton;
  }

  const provider = detectProvider();

  // Production invariant (Railway): Postgres must be used in production.
  // We keep an explicit escape hatch for emergency recovery only.
  if (isProd() && provider !== 'postgres') {
    const allowSqliteInProd =
      String(process.env.ALLOW_SQLITE_IN_PROD || '').trim().toLowerCase() === 'true'
    if (!allowSqliteInProd) {
      throw new Error(
        `[db] Production must use Postgres. Refusing to start with provider="${provider}".\n` +
          `Configure a Railway Postgres database so DATABASE_URL is a postgres:// connection string.\n` +
          `If you must temporarily run SQLite in production (NOT recommended), set ALLOW_SQLITE_IN_PROD=true.`,
      )
    }
  }

  if (provider === 'postgres') {
    const url = inferPostgresUrlFromEnv()
    if (!url || !isPostgresUrl(url)) {
      throw new Error(
        '[db] Postgres configuration missing. Set DATABASE_URL to a postgres:// connection string, ' +
          'or set PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE (Railway-style).',
      )
    }

    singleton = new PostgresDb(url)
    return singleton
  }

  // sqlite fallback (default)
  if (isProd() && isRailwayRuntime()) {
    // Production invariant: Railway deployments must use Postgres, not SQLite.
    // SQLite volumes can work, but they are too easy to misconfigure and silently lose data on redeploy.
    throw new Error(
      '[db] Refusing to start on Railway production with SQLite.\n' +
        'Configure a Railway Postgres plugin and set DATABASE_URL (postgres://...), or set DB_PROVIDER=postgres.',
    );
  }

  const dataDir = join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const sqlitePath = resolveDefaultSqlitePath(dataDir);

  // Production-grade invariant: SQLite must be on a persistent volume.
  // - If running on Railway and /mnt/data exists, we default there automatically.
  // - If still not on /mnt/data, fail fast unless explicitly allowed.
  //
  // NOTE: Railway deployments occasionally come up without the volume mounted during
  // initial provisioning or misconfiguration. In that case, crashing hard yields a
  // perpetual 502 and blocks recovery via the Admin UI. On Railway production we warn
  // loudly and continue booting so the system remains reachable, while `/health`
  // can still signal the misconfiguration.
  if (isProd() && !looksLikeRailwayVolumePath(sqlitePath)) {
    const allowEphemeral =
      String(process.env.ALLOW_EPHEMERAL_SQLITE || '').trim().toLowerCase() === 'true';
    if (!allowEphemeral && !isRailwayRuntime()) {
      throw new Error(
        `[db] Refusing to start with ephemeral SQLite path in production: ${sqlitePath}\n` +
          `Set SQLITE_DB_PATH to a persistent volume path (e.g. /mnt/data/grantflow.db on Railway),\n` +
          `or set ALLOW_EPHEMERAL_SQLITE=true to override (NOT recommended).`,
      );
    }
    if (!allowEphemeral && isRailwayRuntime()) {
      console.warn(
        `[db] WARNING: Running with ephemeral SQLite path on Railway production: ${sqlitePath}\n` +
          `Mount a persistent volume at /mnt/data (recommended), or switch to Postgres (preferred).`,
      )
    }
  }

  singleton = new SqliteDb(sqlitePath);
  return singleton;
}

export const db = getDb();

