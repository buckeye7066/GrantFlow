#!/usr/bin/env node
/**
 * dedupe-profiles.mjs  (DEDUPE_PROFILES_SCRIPT_V1)
 *
 * Safely merge a DUPLICATE profile into a KEEPER profile, then remove the
 * duplicate in a resurrection-proof way.
 *
 * Why this exists
 * ---------------
 * Some people ended up with two profiles: a UUID profile holding all their
 * real data, and an empty "designated"/slug profile (e.g.
 * `profile-anastasia-white`, `profile-robert-white`) that boot-time seeding
 * keeps re-creating. We want one profile per person.
 *
 * What it does
 * ------------
 * For each (--keeper, --duplicate) pair (flags are repeatable and zipped in
 * order):
 *   1. Discovers EVERY table.column that references a profile id (any column
 *      literally named `profile_id`):
 *        - Postgres: read information_schema.columns.
 *        - SQLite: enumerate tables + PRAGMA table_info.
 *      This is data-driven so we never miss a child table.
 *   2. REASSIGNS every child row from duplicate -> keeper
 *      (`UPDATE <table> SET profile_id = <keeper> WHERE profile_id = <duplicate>`),
 *      so nothing the duplicate owns is lost. Unique-constraint collisions
 *      (a row already exists for the keeper) are handled by deleting the
 *      colliding duplicate-side row instead (keeper's copy wins).
 *   3. SOFT-deletes the duplicate (status='deleted') — the canonical pattern
 *      used by DELETE /api/profiles/:id for designated ids.
 *   4. Writes a row into `profile_tombstones` so neither
 *      ensureDesignatedProfiles.js NOR seedBaselineFromRepo.js ever resurrects
 *      it (both skip tombstoned ids; both also refuse to flip status<>'deleted').
 *
 * Safety
 * ------
 *   - DRY RUN by default. Pass --apply to actually mutate.
 *   - Idempotent: re-running after --apply is a no-op (duplicate already
 *     deleted + tombstoned, no child rows left to move).
 *   - Refuses to run if keeper == duplicate, if either id is missing, or if
 *     the "duplicate" still owns rows in a HIGH-VALUE table
 *     (grants / documents / profile_documents / profile_sections /
 *     funding_opportunities) UNLESS you pass --force-merge. The two known
 *     empties have zero of those, so the default guard catches mistakes.
 *
 * Usage
 * -----
 *   node backend/scripts/dedupe-profiles.mjs \
 *     --keeper c4a92724-9cee-416f-ba30-e91b9b5cd885 --duplicate profile-anastasia-white \
 *     --keeper 6b3c75ec-dc56-46f9-b380-394172688175 --duplicate profile-robert-white
 *   # ^ dry run. Add --apply to execute.
 *
 * In-container (Railway) run pattern:
 *   railway ssh "node backend/scripts/dedupe-profiles.mjs --keeper <K> --duplicate <D>"          # dry
 *   railway ssh "node backend/scripts/dedupe-profiles.mjs --keeper <K> --duplicate <D> --apply"  # do it
 */

import { db } from '../db/index.js'
import { runProfileContext } from '../db/scopedQuery.js'
import { isDesignatedProfileId } from '../utils/ensureDesignatedProfiles.js'

// ---- arg parsing -----------------------------------------------------------

function collectPairs(argv) {
  const keepers = []
  const duplicates = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keeper' && argv[i + 1]) keepers.push(String(argv[i + 1]).trim())
    if (argv[i] === '--duplicate' && argv[i + 1]) duplicates.push(String(argv[i + 1]).trim())
  }
  const pairs = []
  const n = Math.min(keepers.length, duplicates.length)
  for (let i = 0; i < n; i++) pairs.push({ keeper: keepers[i], duplicate: duplicates[i] })
  if (keepers.length !== duplicates.length) {
    console.warn(
      `[dedupe] WARNING: ${keepers.length} --keeper flag(s) vs ${duplicates.length} --duplicate flag(s); using ${n} pair(s).`,
    )
  }
  return pairs
}

const argv = process.argv.slice(2)
const isDryRun = !argv.includes('--apply')
const forceMerge = argv.includes('--force-merge')
const pairs = collectPairs(argv)

// Sane default for the known case if invoked with no flags.
if (pairs.length === 0) {
  pairs.push(
    { keeper: 'c4a92724-9cee-416f-ba30-e91b9b5cd885', duplicate: 'profile-anastasia-white' },
    { keeper: '6b3c75ec-dc56-46f9-b380-394172688175', duplicate: 'profile-robert-white' },
  )
  console.warn('[dedupe] No --keeper/--duplicate flags supplied; using built-in Anastasia + Robert pairs.')
}

const isPostgres = db.dialect === 'postgres'

// High-value tables: if the duplicate still owns rows here, abort unless --force-merge.
// (These are the columns most likely to represent real, irreplaceable user data.)
const HIGH_VALUE_TABLES = ['grants', 'documents', 'profile_documents', 'profile_sections', 'funding_opportunities']

// Tables we must never reassign/merge even though they carry a profile_id column:
// the tombstone ledger keys on the (deleted) profile id itself.
const EXCLUDED_TABLES = new Set(['profile_tombstones'])

// ---- schema discovery ------------------------------------------------------

/**
 * Return [{ table, column }] for every column literally named `profile_id`
 * in the live DB. Data-driven so we never miss a table.
 */
async function discoverProfileIdColumns() {
  if (isPostgres) {
    const rows = await db
      .prepare(
        `SELECT table_name AS table, column_name AS column
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name = 'profile_id'
          ORDER BY table_name`,
      )
      .all()
    return (rows || [])
      .map((r) => ({ table: r.table, column: r.column }))
      .filter((r) => !EXCLUDED_TABLES.has(r.table))
  }
  // SQLite (local/test): enumerate tables, then pragma each for a profile_id column.
  const tables = await db
    .prepare("SELECT name AS name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
  const out = []
  for (const t of tables || []) {
    const tableName = t.name
    if (!tableName || tableName === 'profiles') continue
    let cols = []
    try {
      cols = await db.prepare(`PRAGMA table_info(${tableName})`).all()
    } catch {
      cols = []
    }
    if (EXCLUDED_TABLES.has(tableName)) continue
    if ((cols || []).some((c) => c.name === 'profile_id')) {
      out.push({ table: tableName, column: 'profile_id' })
    }
  }
  return out
}

async function tableExists(table) {
  try {
    await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).all()
    return true
  } catch {
    return false
  }
}

async function countRows(table, profileId) {
  try {
    const row = await db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?`).get(profileId)
    return Number(row?.c || 0)
  } catch (err) {
    return { error: err?.message || String(err) }
  }
}

async function columnExists(table, column) {
  if (isPostgres) {
    const row = await db
      .prepare(
        `SELECT 1 AS ok FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ? AND column_name = ? LIMIT 1`,
      )
      .get(table, column)
    return Boolean(row?.ok)
  }
  try {
    const cols = await db.prepare(`PRAGMA table_info(${table})`).all()
    return (cols || []).some((c) => c.name === column)
  } catch {
    return false
  }
}

// ---- per-table reassignment ------------------------------------------------

/**
 * Reassign every row from duplicate -> keeper for one table.
 * Strategy:
 *   1. Try a plain bulk UPDATE.
 *   2. If that fails on a unique-constraint violation, fall back to a row-by-row
 *      move: try to move each row; on conflict, DELETE the duplicate-side row
 *      (keeper already has the equivalent), so the keeper's data wins.
 *
 * Returns { moved, deletedConflicts, error }.
 */
async function reassignTable(table, keeper, duplicate) {
  // Fast path: bulk update.
  try {
    const res = await db
      .prepare(`UPDATE ${table} SET profile_id = ? WHERE profile_id = ?`)
      .run(keeper, duplicate)
    return { moved: Number(res?.changes || 0), deletedConflicts: 0 }
  } catch (err) {
    const msg = String(err?.message || err)
    const isUnique = /unique|duplicate key|constraint/i.test(msg)
    if (!isUnique) return { moved: 0, deletedConflicts: 0, error: msg }
  }

  // Slow path: the table has a unique constraint involving profile_id and the
  // keeper already holds a colliding row. Prefer an `id` column to move rows
  // individually; otherwise delete the duplicate-side rows wholesale (the
  // keeper's equivalents are kept, so nothing unique is lost).
  const hasId = await columnExists(table, 'id')
  if (!hasId) {
    try {
      const del = await db.prepare(`DELETE FROM ${table} WHERE profile_id = ?`).run(duplicate)
      return { moved: 0, deletedConflicts: Number(del?.changes || 0) }
    } catch (err2) {
      return { moved: 0, deletedConflicts: 0, error: String(err2?.message || err2) }
    }
  }

  const rows = await db.prepare(`SELECT id FROM ${table} WHERE profile_id = ?`).all(duplicate)
  let moved = 0
  let deletedConflicts = 0
  for (const r of rows || []) {
    try {
      const res = await db.prepare(`UPDATE ${table} SET profile_id = ? WHERE id = ?`).run(keeper, r.id)
      moved += Number(res?.changes || 0)
    } catch (err) {
      const msg = String(err?.message || err)
      if (/unique|duplicate key|constraint/i.test(msg)) {
        const del = await db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(r.id)
        deletedConflicts += Number(del?.changes || 0)
      } else {
        return { moved, deletedConflicts, error: msg }
      }
    }
  }
  return { moved, deletedConflicts }
}

// ---- tombstone -------------------------------------------------------------

async function ensureTombstoneTable() {
  const ddl = isPostgres
    ? `CREATE TABLE IF NOT EXISTS profile_tombstones (
         profile_id TEXT PRIMARY KEY,
         deleted_at TIMESTAMPTZ DEFAULT now(),
         deleted_by TEXT,
         reason TEXT
       )`
    : `CREATE TABLE IF NOT EXISTS profile_tombstones (
         profile_id TEXT PRIMARY KEY,
         deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
         deleted_by TEXT,
         reason TEXT
       )`
  await db.prepare(ddl).run()
}

async function tombstone(duplicate, keeper) {
  await ensureTombstoneTable()
  const sql = isPostgres
    ? `INSERT INTO profile_tombstones (profile_id, deleted_by, reason)
       VALUES (?, 'dedupe-profiles.mjs', ?)
       ON CONFLICT (profile_id) DO UPDATE SET reason = excluded.reason, deleted_at = now()`
    : `INSERT INTO profile_tombstones (profile_id, deleted_by, reason)
       VALUES (?, 'dedupe-profiles.mjs', ?)
       ON CONFLICT (profile_id) DO UPDATE SET reason = excluded.reason, deleted_at = CURRENT_TIMESTAMP`
  await db.prepare(sql).run(duplicate, `merged into ${keeper}`)
}

async function softDeleteProfile(duplicate) {
  await db
    .prepare("UPDATE profiles SET status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(duplicate)
}

// ---- main ------------------------------------------------------------------

async function getProfile(id) {
  return db.prepare('SELECT id, display_name, primary_type, status FROM profiles WHERE id = ?').get(id)
}

async function isTombstoned(id) {
  await ensureTombstoneTable()
  const row = await db.prepare('SELECT profile_id FROM profile_tombstones WHERE profile_id = ?').get(id)
  return Boolean(row?.profile_id)
}

async function run() {
  console.log('='.repeat(72))
  console.log(`[dedupe] dialect=${db.dialect}  mode=${isDryRun ? 'DRY RUN (no writes)' : 'APPLY'}`)
  console.log(`[dedupe] pairs:`)
  for (const p of pairs) console.log(`   keeper=${p.keeper}  <-  duplicate=${p.duplicate}`)
  console.log('='.repeat(72))

  const profileIdColumns = await discoverProfileIdColumns()
  console.log(`[dedupe] Discovered ${profileIdColumns.length} table(s) with a profile_id column.`)

  let abort = false

  for (const { keeper, duplicate } of pairs) {
    console.log('\n' + '-'.repeat(72))
    console.log(`[dedupe] PAIR  keeper=${keeper}  duplicate=${duplicate}`)

    if (!keeper || !duplicate) {
      console.error('  ! Missing keeper or duplicate id; skipping.')
      abort = true
      continue
    }
    if (keeper === duplicate) {
      console.error('  ! keeper === duplicate; refusing.')
      abort = true
      continue
    }

    const keeperRow = await getProfile(keeper)
    const dupRow = await getProfile(duplicate)
    if (!keeperRow) {
      console.error(`  ! Keeper profile ${keeper} not found; refusing this pair.`)
      abort = true
      continue
    }
    if (!dupRow) {
      const already = await isTombstoned(duplicate)
      if (already) {
        console.log(`  · Duplicate profile ${duplicate} not found (already tombstoned — nothing to do).`)
        continue
      }
      // RESURRECTION GUARD: a designated/slug profile that was hard-deleted with
      // NO tombstone will be re-created at the next boot by
      // ensureDesignatedProfiles.js / seedBaselineFromRepo.js (they only skip
      // ids present in profile_tombstones). Write the tombstone now so it stays
      // gone. We only do this for known designated ids — a random missing id is
      // genuinely "nothing to do".
      if (isDesignatedProfileId(duplicate)) {
        if (isDryRun) {
          console.log(
            `  · Duplicate ${duplicate} is GONE but NOT tombstoned — it is a designated id and WILL ` +
              `resurrect at next boot. [DRY RUN] Would write a tombstone to prevent that.`,
          )
        } else {
          await tombstone(duplicate, keeper)
          console.log(
            `  · Duplicate ${duplicate} was already gone but not tombstoned; wrote tombstone ` +
              `(prevents boot-time resurrection of this designated profile).`,
          )
        }
        continue
      }
      console.log(`  · Duplicate profile ${duplicate} not found (nothing to do).`)
      continue
    }
    console.log(`  keeper:    ${keeperRow.display_name} (status=${keeperRow.status})`)
    console.log(`  duplicate: ${dupRow.display_name} (status=${dupRow.status})`)

    // Tally child rows on the duplicate across all profile_id columns.
    const tally = []
    let highValueCount = 0
    for (const { table } of profileIdColumns) {
      if (!(await tableExists(table))) continue
      const c = await countRows(table, duplicate)
      if (typeof c === 'object' && c.error) {
        tally.push({ table, count: `ERR: ${c.error}` })
        continue
      }
      if (c > 0) {
        tally.push({ table, count: c })
        if (HIGH_VALUE_TABLES.includes(table)) highValueCount += c
      }
    }

    if (tally.length === 0) {
      console.log('  duplicate owns NO child rows in any profile_id table.')
    } else {
      console.log('  duplicate child rows (before):')
      for (const t of tally) console.log(`     ${t.table.padEnd(40)} ${t.count}`)
    }

    if (highValueCount > 0 && !forceMerge) {
      console.error(
        `  ! Duplicate owns ${highValueCount} HIGH-VALUE row(s) (${HIGH_VALUE_TABLES.join('/')}).`,
      )
      console.error('    This looks like it may NOT be a safe empty duplicate.')
      console.error('    Re-run with --force-merge ONLY if you are certain you want to merge them into the keeper.')
      abort = true
      continue
    }

    if (isDryRun) {
      console.log('  [DRY RUN] Would reassign the above rows to the keeper, then soft-delete + tombstone the duplicate.')
      continue
    }

    // APPLY: reassign every child table, then soft-delete + tombstone.
    let totalMoved = 0
    let totalConflicts = 0
    for (const { table } of profileIdColumns) {
      if (!(await tableExists(table))) continue
      const before = await countRows(table, duplicate)
      if (typeof before === 'object' || before === 0) continue
      const result = await reassignTable(table, keeper, duplicate)
      if (result.error) {
        console.error(`     ! ${table}: ${result.error}`)
        abort = true
      } else {
        totalMoved += result.moved
        totalConflicts += result.deletedConflicts
        if (result.moved || result.deletedConflicts) {
          console.log(
            `     ${table.padEnd(40)} moved=${result.moved} droppedConflicts=${result.deletedConflicts}`,
          )
        }
      }
    }

    await softDeleteProfile(duplicate)
    await tombstone(duplicate, keeper)

    console.log(
      `  APPLIED: moved=${totalMoved} row(s), droppedConflicts=${totalConflicts}, ` +
        `soft-deleted + tombstoned ${duplicate}.`,
    )

    // After-state verification.
    const after = await getProfile(duplicate)
    const tomb = await isTombstoned(duplicate)
    let remaining = 0
    for (const { table } of profileIdColumns) {
      if (!(await tableExists(table))) continue
      const c = await countRows(table, duplicate)
      if (typeof c === 'number') remaining += c
    }
    console.log(`  AFTER: status=${after?.status} tombstoned=${tomb} remaining_child_rows=${remaining}`)
  }

  console.log('\n' + '='.repeat(72))
  if (isDryRun) {
    console.log('[dedupe] DRY RUN complete — nothing was written. Re-run with --apply to execute.')
  } else {
    console.log('[dedupe] APPLY complete.')
  }
  console.log('='.repeat(72))

  if (abort) {
    console.error('[dedupe] One or more pairs were skipped or errored (see above).')
    process.exitCode = 2
  }
}

// Run with a bypass profile context so the profile-scope SQL guard doesn't
// flag our intentionally cross-profile maintenance queries.
runProfileContext({ bypass: true, actorRole: 'admin_global' }, () =>
  run()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
      console.error('[dedupe] FATAL:', err)
      process.exit(1)
    }),
)
