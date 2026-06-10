// 076_grants_status_canonical_pipeline.mjs (SQLite)
//
// RC-13: widen the grants.status CHECK constraint to accept the 3 missing
// canonical pipeline stages (`saved`, `gathering_documents`,
// `ready_to_submit`). Legacy stage names already in the constraint stay
// accepted so historical rows are not invalidated.
//
// Why a .mjs migration (not .sql)?
//   SQLite cannot DROP an inline CHECK constraint via ALTER TABLE. The two
//   documented options are:
//     (a) full table rebuild — fragile because the live `grants` table has
//         many columns added by separate migrations and we can't list them
//         deterministically from a single SQL file.
//     (b) writable_schema rewrite — surgical and data-preserving, but
//         requires bumping schema_version to force SQLite to re-parse, and
//         requires better-sqlite3's unsafeMode to allow sqlite_master writes.
//   We use (b). It only changes the schema entry — no data is touched.
//
// Safety:
//   - Wrapped in a transaction by the migration runner.
//   - The REPLACE is guarded by `sql NOT LIKE '%''saved''%'` so a re-run is
//     a no-op (idempotent). The migration runner's _migrations table also
//     prevents normal re-runs.
//   - PRAGMA integrity_check is run after the rewrite so any malformed
//     change fails the migration before commit.

const NEW_STAGES = `'saved', 'gathering_documents', 'ready_to_submit', `

export default async function up(db) {
  // Pure JS guard: only proceed if the current `grants` table SQL contains a
  // CHECK clause for status that doesn't already include 'saved'.
  const row = await db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='grants'`)
    .get()
  if (!row || typeof row.sql !== 'string') {
    // Fresh DB or unusual layout — nothing to migrate. The fresh-bootstrap
    // schema.sql already includes the new stages, so this is a no-op for
    // brand-new test fixtures.
    return
  }
  if (!row.sql.includes('CHECK(status IN (')) {
    // Table exists but has no inline status CHECK (very old shape). Nothing
    // for us to widen; later migrations or repair tools can add the CHECK
    // when needed.
    return
  }
  if (row.sql.includes("'saved'")) {
    // Already widened (idempotent re-run safety). Migration runner usually
    // prevents this via _migrations; this is belt-and-suspenders.
    return
  }

  const oldVersion = await db.prepare('PRAGMA schema_version').get()
  const oldVersionNumber = Number(oldVersion?.schema_version ?? 0)

  // The replacement string we insert into the SQL literal. SQL escapes a
  // single quote by doubling it, so 'foo' becomes ''foo'' inside a literal.
  const escapedStages = NEW_STAGES.replace(/'/g, "''")

  // Enable better-sqlite3's escape hatch so writable_schema works.
  if (typeof db.unsafeMode === 'function') {
    db.unsafeMode(true)
  }
  try {
    await db.exec('PRAGMA writable_schema = ON')
    // NOTE the trailing `'` BEFORE `)` — the close-quote belongs to the SQL
    // string literal, the close-paren belongs to the REPLACE() call.
    await db
      .prepare(
        `UPDATE sqlite_master
         SET sql = REPLACE(sql, 'CHECK(status IN (', 'CHECK(status IN (${escapedStages}')
         WHERE type='table' AND name='grants' AND sql NOT LIKE '%''saved''%'`,
      )
      .run()
    // Bump schema_version so SQLite re-parses the schema next time it touches
    // `grants`. Without this the new CHECK rule isn't applied to inserts.
    await db.exec(`PRAGMA schema_version = ${oldVersionNumber + 1}`)
    await db.exec('PRAGMA writable_schema = OFF')
  } finally {
    if (typeof db.unsafeMode === 'function') {
      db.unsafeMode(false)
    }
  }

  // Verify integrity. If the rewrite produced a malformed schema, this
  // throws and the surrounding transaction rolls back the change.
  const integrity = await db.prepare('PRAGMA integrity_check').all()
  const ok = Array.isArray(integrity) && integrity.every((r) => String(r?.integrity_check || '').toLowerCase() === 'ok')
  if (!ok) {
    throw new Error(
      `076_grants_status_canonical_pipeline: integrity_check failed after rewrite — ${JSON.stringify(integrity)}`,
    )
  }
}
