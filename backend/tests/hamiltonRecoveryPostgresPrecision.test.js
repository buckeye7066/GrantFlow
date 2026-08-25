import { describe, it, expect } from 'vitest'
import { reconcileOrphanedApplicationTasks } from '../startup/hamiltonTaskRecovery.js'

/**
 * POSTGRES MICROSECONDS vs A JS Date's MILLISECONDS.
 *
 * The restart-recovery compare-and-swap guarded with a bare `updated_at = ?`.
 * On Postgres the driver returns `2026-08-23T11:18:22.124970` as a JS Date
 * TRUNCATED to `.124`, so binding it back could never equal the stored value:
 * the UPDATE matched 0 rows, the loop `continue`d, and `demoted` stayed 0 —
 * silently, because the summary only logged when demoted > 0.
 *
 * Measured in prod 2026-08-24: 82 of 82 tasks stuck in `filling_portal` for ~32
 * hours carried sub-millisecond digits, so recovery was a GUARANTEED no-op
 * there — while every SQLite test passed, because SQLite round-trips its
 * timestamps exactly. A SQLite fixture CANNOT reproduce this, so these tests
 * drive a fake handle that reports the postgres dialect and records the SQL.
 */

// A stand-in that behaves the way pg does: the UPDATE only matches when the
// predicate actually admits a stored value carrying microseconds.
function makeFakePg({ storedMicroIso, scannedDate }) {
  const seen = []
  const db = {
    dialect: 'postgres',
    prepare(sql) {
      seen.push(sql)
      return {
        all: async () => (/SELECT/i.test(sql)
          ? [{ id: 'task-1', status: 'filling_portal', updated_at: scannedDate }]
          : []),
        get: async () => undefined,
        run: async () => {
          // Exact equality can never match a microsecond-bearing value.
          if (sql.includes("updated_at = ?")) return { rowCount: 0 }
          // The tolerant upper bound admits it.
          if (sql.includes("updated_at < CAST(? AS timestamptz) + interval '1 millisecond'")) {
            const stored = Date.parse(storedMicroIso.slice(0, 23) + 'Z')
            return { rowCount: stored < scannedDate.getTime() + 1 ? 1 : 0 }
          }
          return { rowCount: 0 }
        },
      }
    },
  }
  return { db, seen }
}

const STORED_MICRO = '2026-08-23T11:18:22.124970'
const SCANNED = new Date('2026-08-23T11:18:22.124Z') // what the pg driver hands back

describe('restart recovery survives Postgres microsecond precision', () => {
  it('DEMOTES a stale task whose updated_at carries microseconds (was a silent no-op)', async () => {
    const { db } = makeFakePg({ storedMicroIso: STORED_MICRO, scannedDate: SCANNED })
    const out = await reconcileOrphanedApplicationTasks(db, {
      staleMinutes: 45,
      now: SCANNED.getTime() + 32 * 60 * 60 * 1000, // 32h later, as in prod
      logger: { warn() {}, info() {} },
    })
    expect(out.scanned).toBe(1)
    expect(out.demoted).toBe(1)
    expect(out.skipped_unchanged).toBe(0)
  })

  it('uses a millisecond-tolerant guard on postgres, never a bare equality', async () => {
    const { db, seen } = makeFakePg({ storedMicroIso: STORED_MICRO, scannedDate: SCANNED })
    await reconcileOrphanedApplicationTasks(db, {
      staleMinutes: 45,
      now: SCANNED.getTime() + 32 * 60 * 60 * 1000,
      logger: { warn() {}, info() {} },
    })
    const update = seen.find((s) => /UPDATE application_tasks/i.test(s))
    expect(update).toBeTruthy()
    expect(update.includes("updated_at < CAST(? AS timestamptz) + interval '1 millisecond'")).toBe(true)
    expect(update.includes("updated_at = ?")).toBe(false)
  })

  it('COUNTS a zero-row compare-and-swap instead of skipping it invisibly', async () => {
    // A handle where nothing ever matches — the exact prod shape. The sweep must
    // report it rather than return a comfortable demoted:0.
    const db = {
      dialect: 'postgres',
      prepare: (sql) => ({
        all: async () => (/SELECT/i.test(sql)
          ? [{ id: 't', status: 'filling_portal', updated_at: SCANNED }]
          : []),
        get: async () => undefined,
        run: async () => ({ rowCount: 0 }),
      }),
    }
    const warnings = []
    const out = await reconcileOrphanedApplicationTasks(db, {
      staleMinutes: 45,
      now: SCANNED.getTime() + 32 * 60 * 60 * 1000,
      logger: { warn: (m) => warnings.push(String(m)), info() {} },
    })
    expect(out.demoted).toBe(0)
    expect(out.skipped_unchanged).toBe(1)
    expect(warnings.join(' ')).toMatch(/changed NONE/)
  })
})
