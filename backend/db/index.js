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

function normalizeProvider(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'pg') return 'postgres';
  if (v === 'postgresql') return 'postgres';
  return v;
}

function detectProvider() {
  const explicit =
    normalizeProvider(process.env.DB_PROVIDER) ||
    normalizeProvider(process.env.DB_DIALECT);

  if (explicit) return explicit;
  if (isPostgresUrl(process.env.DATABASE_URL)) return 'postgres';
  return 'sqlite';
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

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

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

class SqliteDb {
  constructor(sqlitePath) {
    this.dialect = 'sqlite';
    this.path = sqlitePath;
    this._db = new Database(sqlitePath);
    this._db.pragma('journal_mode = WAL');
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
      get: (...args) => stmt.get(...args),
      all: (...args) => stmt.all(...args),
      run: (...args) => stmt.run(...args),
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
    const converted = qmarkToDollarPlaceholders(sql);
    return {
      get: async (...args) => {
        const values = toParamArray(args);
        const res = await this._client.query(converted.text, values);
        return res.rows[0];
      },
      all: async (...args) => {
        const values = toParamArray(args);
        const res = await this._client.query(converted.text, values);
        return res.rows;
      },
      run: async (...args) => {
        const values = toParamArray(args);
        const res = await this._client.query(converted.text, values);
        return {
          changes: res.rowCount ?? 0,
          lastInsertRowid: null,
        };
      },
    };
  }

  async exec(sql) {
    await this._client.query(sql);
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
    });
  }

  prepare(sql) {
    const converted = qmarkToDollarPlaceholders(sql);
    return {
      get: async (...args) => {
        const values = toParamArray(args);
        const res = await this._pool.query(converted.text, values);
        return res.rows[0];
      },
      all: async (...args) => {
        const values = toParamArray(args);
        const res = await this._pool.query(converted.text, values);
        return res.rows;
      },
      run: async (...args) => {
        const values = toParamArray(args);
        const res = await this._pool.query(converted.text, values);
        // better-sqlite3 shape compatibility (best-effort)
        return {
          changes: res.rowCount ?? 0,
          lastInsertRowid: null,
        };
      },
    };
  }

  async exec(sql) {
    // pg can execute multiple semicolon-separated statements; result is last statement.
    await this._pool.query(sql);
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

  if (provider === 'postgres') {
    const url = String(process.env.DATABASE_URL || '').trim();
    if (!isPostgresUrl(url)) {
      throw new Error(
        '[db] DB_PROVIDER=postgres requires DATABASE_URL to be set to a postgres:// connection string',
      );
    }
    singleton = new PostgresDb(url);
    return singleton;
  }

  // sqlite fallback (default)
  const dataDir = join(__dirname, '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const sqlitePath = process.env.SQLITE_DB_PATH || join(dataDir, 'grantflow.db');
  singleton = new SqliteDb(sqlitePath);
  return singleton;
}

export const db = getDb();

