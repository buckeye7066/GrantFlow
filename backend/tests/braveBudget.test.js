/**
 * braveBudget — the monthly PACER for the shared Brave Search key. Contract:
 *   1. Daily allowance = max(min-daily, floor(remaining / days-left)); unused
 *      budget rolls forward, an early burn shrinks later days.
 *   2. tryConsumeBraveQuery stops at today's allowance and at the monthly cap,
 *      persists across "deploys" (state lives in system_kv, not memory), and
 *      resets on month rollover.
 *   3. Storage problems FAIL OPEN — pacing must never kill web search outright.
 *   4. The Brave provider skips the network call when the pacer denies, and a
 *      402 (billing) opens the circuit breaker for hours.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  computeDailyAllowance,
  tryConsumeBraveQuery,
  getBraveBudgetState,
  KV_KEY,
} from '../services/yana/braveBudget.js'
import { makeBraveSearchProvider } from '../services/yana/webSearchProvider.js'
import { isBravePaused, braveCircuitState, _resetBraveCircuit } from '../services/yana/braveRateLimit.js'

const JUL_1 = Date.parse('2026-07-01T12:00:00Z')
const JUL_16 = Date.parse('2026-07-16T12:00:00Z') // 16 days left of 31
const AUG_1 = Date.parse('2026-08-01T12:00:00Z')

function makeDb() {
  const raw = new Database(':memory:')
  return raw
}

const envKeys = ['BRAVE_MONTHLY_QUERY_BUDGET', 'BRAVE_BUDGET_MIN_DAILY', 'BRAVE_BUDGET_ENABLED']
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

describe('computeDailyAllowance — pure pacing math', () => {
  it('splits the full budget across the month on day 1', () => {
    // 1900 over 31 days = 61/day.
    expect(computeDailyAllowance({ budget: 1900, used: 0, usedToday: 0, now: JUL_1, floorDaily: 10 })).toBe(61)
  })

  it('rolls unused budget forward (mid-month, underspent)', () => {
    // Only 100 spent by Jul 16 → 1800 over 16 days = 112/day.
    expect(computeDailyAllowance({ budget: 1900, used: 100, usedToday: 0, now: JUL_16, floorDaily: 10 })).toBe(112)
  })

  it('shrinks after an early burn but never below the floor', () => {
    // 1880 already spent → 20 left over 16 days = 1/day → floored to 10.
    expect(computeDailyAllowance({ budget: 1900, used: 1880, usedToday: 0, now: JUL_16, floorDaily: 10 })).toBe(10)
  })

  it("excludes today's own spend from the remaining calculation", () => {
    // used 61 all TODAY: remaining-before-today is still 1900 → allowance 61.
    expect(computeDailyAllowance({ budget: 1900, used: 61, usedToday: 61, now: JUL_1, floorDaily: 10 })).toBe(61)
  })
})

describe('tryConsumeBraveQuery — consume flow', () => {
  it('allows up to the daily allowance, then denies with daily_pace_reached', async () => {
    process.env.BRAVE_MONTHLY_QUERY_BUDGET = '62' // 62/31 days = 2/day on Jul 1
    process.env.BRAVE_BUDGET_MIN_DAILY = '0'
    const db = makeDb()
    expect((await tryConsumeBraveQuery({ db, now: JUL_1 })).allowed).toBe(true)
    expect((await tryConsumeBraveQuery({ db, now: JUL_1 })).allowed).toBe(true)
    const third = await tryConsumeBraveQuery({ db, now: JUL_1 })
    expect(third.allowed).toBe(false)
    expect(third.reason).toBe('daily_pace_reached')
    // Next day: allowance recomputed, spending resumes.
    const nextDay = await tryConsumeBraveQuery({ db, now: JUL_1 + 24 * 3600 * 1000 })
    expect(nextDay.allowed).toBe(true)
    db.close()
  })

  it('stops at the monthly cap and resets on month rollover', async () => {
    process.env.BRAVE_MONTHLY_QUERY_BUDGET = '3'
    process.env.BRAVE_BUDGET_MIN_DAILY = '100' // daily floor above cap — monthly cap must still win
    const db = makeDb()
    for (let i = 0; i < 3; i++) expect((await tryConsumeBraveQuery({ db, now: JUL_16 })).allowed).toBe(true)
    const over = await tryConsumeBraveQuery({ db, now: JUL_16 })
    expect(over.allowed).toBe(false)
    expect(over.reason).toBe('monthly_budget_exhausted')
    // New month → fresh budget.
    expect((await tryConsumeBraveQuery({ db, now: AUG_1 })).allowed).toBe(true)
    db.close()
  })

  it('persists in system_kv (survives a "deploy") and is observable', async () => {
    process.env.BRAVE_MONTHLY_QUERY_BUDGET = '1900'
    const db = makeDb()
    await tryConsumeBraveQuery({ db, now: JUL_1 })
    await tryConsumeBraveQuery({ db, now: JUL_1 })
    const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(KV_KEY)
    expect(JSON.parse(row.value).used).toBe(2)
    const state = await getBraveBudgetState({ db, now: JUL_1 })
    expect(state).toMatchObject({ used: 2, budget: 1900, used_today: 2 })
    expect(state.allowance_today).toBe(61)
    db.close()
  })

  it('fails OPEN when storage is unavailable and when pacing is disabled', async () => {
    expect((await tryConsumeBraveQuery({ db: {}, now: JUL_1 })).allowed).toBe(true)
    process.env.BRAVE_BUDGET_ENABLED = 'false'
    expect((await tryConsumeBraveQuery({ db: makeDb(), now: JUL_1 })).reason).toBe('pacing_disabled')
  })
})

describe('Brave provider integration', () => {
  beforeEach(() => _resetBraveCircuit())
  afterEach(() => _resetBraveCircuit())

  it('skips the network call entirely when the pacer denies', async () => {
    const fetchImpl = vi.fn()
    const search = makeBraveSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
      minIntervalMs: 0,
      consumeBudget: async () => ({ allowed: false, reason: 'daily_pace_reached', state: {} }),
    })
    expect(await search({ query: 'community foundation Bradley County' })).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('a 402 (billing) opens the circuit for hours', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 402, ok: false, headers: { get: () => null } }))
    const search = makeBraveSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
      minIntervalMs: 0,
      consumeBudget: async () => ({ allowed: true }),
    })
    expect(await search({ query: 'q' })).toEqual([])
    expect(isBravePaused()).toBe(true)
    expect(braveCircuitState().reason).toBe('billing_402')
    // Follow-up calls skip the network while paused.
    fetchImpl.mockClear()
    expect(await search({ query: 'q2' })).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
