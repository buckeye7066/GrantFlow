import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

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
      return join(railwayDir, 'grantflow.db');
    }
  } catch {
    // ignore
  }

  return join(dataDir, 'grantflow.db');
}

function isArrayArgList(args) {
  return args.length === 1 && Array.isArray(args[0]);
}

function toParamArray(args) {
  return isArrayArgList(args) ? args[0] : args;
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

function normalizeSqliteValue(value) {
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

function normalizeSqliteArgs(args) {
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
  }

  // Compatibility with better-sqlite3 API used throughout the codebase.
  // Returns a function that runs `fn` inside a transaction.
  transaction(fn) {
    const wrapped = this._db.transaction(fn);
    return (...args) => wrapped(...args);
  }

  prepare(sql) {
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

  async healthcheck() {
    // Keep async signature for parity with Postgres, but run synchronously here.
    this.prepare('SELECT 1 as ok').get();
    return { ok: true, dialect: this.dialect };
  }

  async withTransaction(fn) {
    this.exec('BEGIN');
    try {
      const result = await fn(this);
      this.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw error;
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
    const hasNamed = /@[_A-Za-z][_A-Za-z0-9]*/.test(sql);
    const converted = hasNamed ? atNameToDollarPlaceholders(sql) : qmarkToDollarPlaceholders(sql);
    return {
      get: async (...args) => {
        const values =
          hasNamed && isObjectBindings(args)
            ? bindingsToValues(converted.names, args[0])
            : toParamArray(args);
        try {
          const res = await this._client.query(converted.text, values);
          return res.rows[0];
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      all: async (...args) => {
        const values =
          hasNamed && isObjectBindings(args)
            ? bindingsToValues(converted.names, args[0])
            : toParamArray(args);
        try {
          const res = await this._client.query(converted.text, values);
          return res.rows;
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      run: async (...args) => {
        const values =
          hasNamed && isObjectBindings(args)
            ? bindingsToValues(converted.names, args[0])
            : toParamArray(args);
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
    // Allow multi-statement SQL (needed for schema migrations).
    await this._client.query({ text: sql, queryMode: 'simple' });
  }
}

class PostgresDb {
  constructor(connectionString) {
    this.dialect = 'postgres';
    this.url = connectionString;
    this._pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_MS || 30000),
      connectionTimeoutMillis: Number(process.env.PG_POOL_CONN_TIMEOUT_MS || 10000),
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),
    });
  }

  prepare(sql) {
    const hasNamed = /@[_A-Za-z][_A-Za-z0-9]*/.test(sql);
    const converted = hasNamed ? atNameToDollarPlaceholders(sql) : qmarkToDollarPlaceholders(sql);
    return {
      get: async (...args) => {
        const values = hasNamed && isObjectBindings(args) ? bindingsToValues(converted.names, args[0]) : toParamArray(args);
        try {
          const res = await this._pool.query(converted.text, values);
          return res.rows[0];
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      all: async (...args) => {
        const values = hasNamed && isObjectBindings(args) ? bindingsToValues(converted.names, args[0]) : toParamArray(args);
        try {
          const res = await this._pool.query(converted.text, values);
          return res.rows;
        } catch (error) {
          throw decoratePgErrorWithSqlSnippet(error, converted.text)
        }
      },
      run: async (...args) => {
        const values = hasNamed && isObjectBindings(args) ? bindingsToValues(converted.names, args[0]) : toParamArray(args);
        try {
          const res = await this._pool.query(converted.text, values);
          // better-sqlite3 shape compatibility (best-effort)
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
    // Allow multi-statement SQL (needed for schema migrations).
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
    return async (...args) => this.withTransaction((tx) => fn(...args, tx));
  }

  async close() {
    await this._pool.end();
  }
}

let singleton = null;

export function getDb() {
  if (singleton) return singleton;

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

