/**
 * googleBudget — the DAILY pacer for the Google Custom Search JSON API key
 * (mirrors braveBudget's test contract, minus the monthly pacing math —
 * Google's quota is per-UTC-day and resets at UTC midnight). Contract:
 *   1. tryConsumeGoogleQuery allows up to the daily budget (default 90,
 *      env GOOGLE_CSE_DAILY_BUDGET), then denies with
 *      'daily_budget_exhausted' — fails CLOSED at the cap.
 *   2. Day rollover at UTC midnight resets the used counter.
 *   3. State persists in system_kv ('google_cse_budget') across "deploys",
 *      and the persisted counter is a NUMBER (SQLite typeless trap).
 *   4. Storage problems FAIL OPEN — pacing must never kill web search;
 *      GOOGLE_BUDGET_ENABLED=false disables pacing entirely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  tryConsumeGoogleQuery,
  getGoogleBudgetState,
  dailyBudget,
  isGoogleBudgetEnabled,
  KV_KEY,
} from '../services/shared/googleBudget.js'

// One minute before / after the UTC midnight boundary between Aug 4 and Aug 5.
const AUG_4_LATE = Date.parse('2026-08-04T23:59:00Z')
const AUG_5_EARLY = Date.parse('2026-08-05T00:01:00Z')
const AUG_4_NOON = Date.parse('2026-08-04T12:00:00Z')

function makeDb() {
  return new Database(':memory:')
}

const envKeys = ['GOOGLE_CSE_DAILY_BUDGET', 'GOOGLE_BUDGET_ENABLED']
const savedEnv = {}
beforeEach(() => {
  for (const k of envKeys) { savedEnv[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of envKeys) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('configuration', () => {
  it('KV key is google_cse_budget (survives deploys in system_kv)', () => {
    expect(KV_KEY).toBe('google_cse_budget')
  })

  it('default daily budget is 90; GOOGLE_CSE_DAILY_BUDGET overrides; junk falls back to 90', () => {
    expect(dailyBudget()).toBe(90)
    process.env.GOOGLE_CSE_DAILY_BUDGET = '5'
    expect(dailyBudget()).toBe(5)
    process.env.GOOGLE_CSE_DAILY_BUDGET = '7.9'
    expect(dailyBudget()).toBe(7) // floored — a fractional query is not a thing
    for (const junk of ['abc', '0', '-3', '']) {
      process.env.GOOGLE_CSE_DAILY_BUDGET = junk
      expect(dailyBudget()).toBe(90)
    }
  })

  it('pacing is enabled by default and disabled only by an explicit false (case-insensitive)', () => {
    expect(isGoogleBudgetEnabled()).toBe(true)
    process.env.GOOGLE_BUDGET_ENABLED = 'false'
    expect(isGoogleBudgetEnabled()).toBe(false)
    process.env.GOOGLE_BUDGET_ENABLED = 'FALSE'
    expect(isGoogleBudgetEnabled()).toBe(false)
    process.env.GOOGLE_BUDGET_ENABLED = 'true'
    expect(isGoogleBudgetEnabled()).toBe(true)
  })
})

describe('tryConsumeGoogleQuery — consume flow', () => {
  it('allows up to the daily budget, then fails CLOSED with daily_budget_exhausted', async () => {
    process.env.GOOGLE_CSE_DAILY_BUDGET = '2'
    const db = makeDb()
    expect((await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })).allowed).toBe(true)
    expect((await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })).allowed).toBe(true)
    const third = await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe('daily_budget_exhausted')
    expect(third.state).toMatchObject({ day: '2026-08-04', used: 2, budget: 2 })
    db.close()
  })

  it('resets the used counter at UTC midnight (day rollover)', async () => {
    process.env.GOOGLE_CSE_DAILY_BUDGET = '1'
    const db = makeDb()
    expect((await tryConsumeGoogleQuery({ db, now: AUG_4_LATE })).allowed).toBe(true)
    // Same UTC day, budget spent → denied.
    expect((await tryConsumeGoogleQuery({ db, now: AUG_4_LATE })).allowed).toBe(false)
    // Two minutes later it is a NEW UTC day → fresh budget.
    const nextDay = await tryConsumeGoogleQuery({ db, now: AUG_5_EARLY })
    expect(nextDay.allowed).toBe(true)
    expect(nextDay.state).toMatchObject({ day: '2026-08-05', used: 1 })
    db.close()
  })

  it('persists in system_kv (survives a "deploy"), and the persisted counter is a NUMBER', async () => {
    const db = makeDb()
    await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })
    await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })
    const row = db.prepare('SELECT value, updated_at FROM system_kv WHERE key = ?').get(KV_KEY)
    expect(row).toBeTruthy()
    const parsed = JSON.parse(row.value)
    // SQLite is typeless, so the type assertion lives HERE: `used` must be a
    // real integer NUMBER inside the persisted JSON — a stringly counter
    // would make `state.used >= budget` a lexicographic comparison ('9' > '10')
    // and the fail-CLOSED bar silently wrong (the migration-139 confidence
    // class: SQLite tests pass, prod semantics break).
    expect(typeof parsed.used).toBe('number')
    expect(Number.isInteger(parsed.used)).toBe(true)
    expect(parsed.used).toBe(2)
    expect(typeof parsed.day).toBe('string')
    expect(parsed.day).toBe('2026-08-04')
    expect(() => new Date(row.updated_at).toISOString()).not.toThrow()
    db.close()
  })

  it('a stringly-persisted counter from a previous (buggy) writer is coerced back to a number on read', async () => {
    process.env.GOOGLE_CSE_DAILY_BUDGET = '5'
    const db = makeDb()
    db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(
      KV_KEY, JSON.stringify({ day: '2026-08-04', used: '3' }), new Date(AUG_4_NOON).toISOString(),
    )
    const res = await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })
    expect(res.allowed).toBe(true)
    expect(res.state.used).toBe(4)
    expect(typeof res.state.used).toBe('number')
    db.close()
  })

  it('fails OPEN when the db is missing, unusable, or unreadable', async () => {
    // No prepare at all → no_db_fail_open.
    const noDb = await tryConsumeGoogleQuery({ db: {}, now: AUG_4_NOON })
    expect(noDb.allowed).toBe(true)
    expect(noDb.reason).toBe('no_db_fail_open')
    // prepare throws → kv_unreadable_fail_open.
    const broken = { prepare: () => { throw new Error('db is on fire') } }
    const unreadable = await tryConsumeGoogleQuery({ db: broken, now: AUG_4_NOON })
    expect(unreadable.allowed).toBe(true)
    expect(unreadable.reason).toBe('kv_unreadable_fail_open')
  })

  it('GOOGLE_BUDGET_ENABLED=false disables pacing entirely (no db touched)', async () => {
    process.env.GOOGLE_BUDGET_ENABLED = 'false'
    const broken = { prepare: () => { throw new Error('must never be called') } }
    const res = await tryConsumeGoogleQuery({ db: broken, now: AUG_4_NOON })
    expect(res.allowed).toBe(true)
    expect(res.reason).toBe('pacing_disabled')
  })
})

describe('getGoogleBudgetState — observability', () => {
  it('reports {day, used, budget} and never consumes', async () => {
    process.env.GOOGLE_CSE_DAILY_BUDGET = '10'
    const db = makeDb()
    await tryConsumeGoogleQuery({ db, now: AUG_4_NOON })
    const state = await getGoogleBudgetState({ db, now: AUG_4_NOON })
    expect(state).toMatchObject({ day: '2026-08-04', used: 1, budget: 10 })
    expect(typeof state.used).toBe('number')
    // Observing did not spend anything.
    const after = await getGoogleBudgetState({ db, now: AUG_4_NOON })
    expect(after.used).toBe(1)
    db.close()
  })

  it('reads a fresh (zero-used) state for a new day without writing', async () => {
    const db = makeDb()
    await tryConsumeGoogleQuery({ db, now: AUG_4_LATE })
    const nextDay = await getGoogleBudgetState({ db, now: AUG_5_EARLY })
    expect(nextDay).toMatchObject({ day: '2026-08-05', used: 0 })
    db.close()
  })

  it('returns null (never throws) when the db is unusable', async () => {
    expect(await getGoogleBudgetState({ db: {}, now: AUG_4_NOON })).toBe(null)
    const broken = { prepare: () => { throw new Error('db is on fire') } }
    expect(await getGoogleBudgetState({ db: broken, now: AUG_4_NOON })).toBe(null)
  })
})
