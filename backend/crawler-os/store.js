// crawler-os/store.js
//
// The storage PRIMITIVE layer. Canonical storage services (storage.js) are
// written against this 6-method interface so the same semantics run on:
//   - createMemoryStore(): a real in-memory store (tests + local dev) — zero deps.
//   - createSqlStore(db):  a thin adapter over a better-sqlite3-style db for
//     production (Postgres/SQLite). Equality-only `where` clauses.
//
// Methods:
//   insert(table, row) -> row
//   upsert(table, keyFields[], row) -> row
//   get(table, where) -> row | null
//   all(table, where?) -> row[]
//   update(table, where, patch) -> count
//   remove(table, where) -> count
//
// `where` is a plain object of equality predicates: { profile_id, opportunity_id }.

function matches(row, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

/** A real in-memory store. Deterministic, synchronous, dependency-free. */
export function createMemoryStore() {
  const tables = new Map();
  const seq = new Map();
  const t = (name) => { if (!tables.has(name)) tables.set(name, []); return tables.get(name); };
  const nextId = (name) => { const n = (seq.get(name) ?? 0) + 1; seq.set(name, n); return n; };

  return {
    _tables: tables, // exposed for diagnostics/tests only
    insert(table, row) {
      const rec = { __rowid: nextId(table), ...row };
      t(table).push(rec);
      return rec;
    },
    upsert(table, keyFields, row) {
      const where = Object.fromEntries(keyFields.map((k) => [k, row[k]]));
      const existing = t(table).find((r) => matches(r, where));
      if (existing) { Object.assign(existing, row); return existing; }
      return this.insert(table, row);
    },
    get(table, where) { return t(table).find((r) => matches(r, where)) ?? null; },
    all(table, where) { return t(table).filter((r) => matches(r, where)).map((r) => ({ ...r })); },
    update(table, where, patch) {
      let n = 0;
      for (const r of t(table)) if (matches(r, where)) { Object.assign(r, patch); n++; }
      return n;
    },
    remove(table, where) {
      const arr = t(table);
      const before = arr.length;
      const kept = arr.filter((r) => !matches(r, where));
      tables.set(table, kept);
      return before - kept.length;
    },
  };
}

/**
 * createSqlStore — production adapter over a better-sqlite3-style `db`
 * (`db.prepare(sql).run/get/all`, `db.exec`). Equality-only where clauses.
 * NOTE: requires the host to provide `db` (e.g. better-sqlite3 or a pg shim).
 * Not exercised by the offline test suite; the memory store proves semantics.
 */
// SQL identifiers (table + column names) cannot be parameterized, so they are
// interpolated into the statement text. Every identifier MUST therefore be
// validated against a strict whitelist before it touches a SQL string —
// otherwise createSqlStore is an injection primitive the moment a caller passes
// an attacker-influenced table/column name. The storage service only uses fixed
// snake_case names, so this is defense-in-depth that also makes the adapter safe
// to expose directly. Anything that is not a plain [A-Za-z_][A-Za-z0-9_]* token
// (so: no spaces, quotes, semicolons, parentheses, dashes, dots) is refused.
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name, role = 'identifier') {
  if (typeof name !== 'string' || !SAFE_IDENT.test(name)) {
    throw new Error(`createSqlStore: unsafe SQL ${role} ${JSON.stringify(name)}`);
  }
  return name;
}
function assertIdents(names, role) {
  for (const n of names) assertIdent(n, role);
  return names;
}

export function createSqlStore(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('createSqlStore: db with .prepare required');
  const whereClause = (where) => {
    const keys = assertIdents(Object.keys(where ?? {}), 'column');
    if (!keys.length) return { sql: '', params: [] };
    return { sql: ' WHERE ' + keys.map((k) => `${k} = ?`).join(' AND '), params: keys.map((k) => where[k]) };
  };
  return {
    insert(table, row) {
      assertIdent(table, 'table');
      const cols = assertIdents(Object.keys(row), 'column');
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
      db.prepare(sql).run(...cols.map((c) => row[c]));
      return row;
    },
    upsert(table, keyFields, row) {
      assertIdent(table, 'table');
      assertIdents(keyFields, 'key column');
      const cols = assertIdents(Object.keys(row), 'column');
      const updates = cols.filter((c) => !keyFields.includes(c)).map((c) => `${c}=excluded.${c}`).join(', ');
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ` +
        `ON CONFLICT(${keyFields.join(',')}) DO UPDATE SET ${updates}`;
      db.prepare(sql).run(...cols.map((c) => row[c]));
      return row;
    },
    get(table, where) {
      const safeTable = assertIdent(table, 'table');
      const { sql: safeWhereSql, params } = whereClause(where);
      return db.prepare(`SELECT * FROM ${safeTable}${safeWhereSql} LIMIT 1`).get(...params) ?? null;
    },
    all(table, where) {
      const safeTable = assertIdent(table, 'table');
      const { sql: safeWhereSql, params } = whereClause(where);
      return db.prepare(`SELECT * FROM ${safeTable}${safeWhereSql}`).all(...params);
    },
    update(table, where, patch) {
      const safeTable = assertIdent(table, 'table');
      const setCols = assertIdents(Object.keys(patch), 'column');
      const { sql: safeWhereSql, params } = whereClause(where);
      const r = db.prepare(`UPDATE ${safeTable} SET ${setCols.map((c) => `${c}=?`).join(',')}${safeWhereSql}`)
        .run(...setCols.map((c) => patch[c]), ...params);
      return r.changes ?? 0;
    },
    remove(table, where) {
      const safeTable = assertIdent(table, 'table');
      const { sql: safeWhereSql, params } = whereClause(where);
      const r = db.prepare(`DELETE FROM ${safeTable}${safeWhereSql}`).run(...params);
      return r.changes ?? 0;
    },
  };
}

export default { createMemoryStore, createSqlStore };
