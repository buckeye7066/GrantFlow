/**
 * freeWeek — the global "give the app away for a week" promotional window.
 *
 * Pure, env-driven, self-expiring. These tests pin the activation logic: it is
 * OFF unless explicitly enabled, honors an explicit start/end, and defaults to
 * a 7-day window when no end is given. `now` is injected so the suite is
 * deterministic and never touches the wall clock.
 */
import { describe, it, expect } from 'vitest'
import { computeFreeWeekStatus, isFreeWeekActive, freeWeekSignupGrant, signupTrialGrant } from '../../shared/freeWeek.js'

const T0 = Date.parse('2026-06-24T12:00:00Z')

describe('freeWeek', () => {
  it('is off by default (no env)', () => {
    expect(isFreeWeekActive({}, T0)).toBe(false)
    expect(computeFreeWeekStatus({}, T0)).toMatchObject({ active: false, enabled: false })
  })

  it('is off when FREE_WEEK_ENABLED is not truthy', () => {
    expect(isFreeWeekActive({ FREE_WEEK_ENABLED: 'false' }, T0)).toBe(false)
    expect(isFreeWeekActive({ FREE_WEEK_ENABLED: '0' }, T0)).toBe(false)
  })

  it('is active immediately when enabled with no dates', () => {
    expect(isFreeWeekActive({ FREE_WEEK_ENABLED: 'true' }, T0)).toBe(true)
  })

  it('defaults to a 7-day window from start', () => {
    const env = { FREE_WEEK_ENABLED: 'true', FREE_WEEK_START: '2026-06-24T00:00:00Z' }
    const DAY = 24 * 60 * 60 * 1000
    expect(isFreeWeekActive(env, Date.parse('2026-06-27T00:00:00Z'))).toBe(true) // day 3
    expect(isFreeWeekActive(env, Date.parse('2026-06-30T23:00:00Z'))).toBe(true) // day ~7
    expect(isFreeWeekActive(env, Date.parse('2026-06-24T00:00:00Z') + 7 * DAY + 1)).toBe(false)
  })

  it('honors an explicit end and is inactive before start / after end', () => {
    const env = {
      FREE_WEEK_ENABLED: 'true',
      FREE_WEEK_START: '2026-06-25T00:00:00Z',
      FREE_WEEK_END: '2026-07-02T00:00:00Z',
    }
    expect(isFreeWeekActive(env, Date.parse('2026-06-24T12:00:00Z'))).toBe(false) // before
    expect(isFreeWeekActive(env, Date.parse('2026-06-28T12:00:00Z'))).toBe(true)  // during
    expect(isFreeWeekActive(env, Date.parse('2026-07-02T00:00:01Z'))).toBe(false) // after
  })

  it('surfaces a banner label only while active', () => {
    const env = { FREE_WEEK_ENABLED: 'true', FREE_WEEK_LABEL: 'Birthday week — free!' }
    expect(computeFreeWeekStatus(env, T0).label).toBe('Birthday week — free!')
    expect(computeFreeWeekStatus({ ...env, FREE_WEEK_END: '2026-06-01T00:00:00Z' }, T0).label).toBe(null)
  })
})

describe('freeWeekSignupGrant (per-signup full period)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('returns null when the promo is off', () => {
    expect(freeWeekSignupGrant({}, T0)).toBe(null)
  })

  it('grants a full week from now by default while active', () => {
    const g = freeWeekSignupGrant({ FREE_WEEK_ENABLED: 'true' }, T0)
    expect(g).toMatchObject({ period: 'week', days: 7 })
    expect(Date.parse(g.until)).toBe(T0 + 7 * DAY)
  })

  it('honors FREE_WEEK_SIGNUP_PERIOD=month', () => {
    const g = freeWeekSignupGrant({ FREE_WEEK_ENABLED: 'true', FREE_WEEK_SIGNUP_PERIOD: 'month' }, T0)
    expect(g).toMatchObject({ period: 'month', days: 30 })
    expect(Date.parse(g.until)).toBe(T0 + 30 * DAY)
  })

  it('can be disabled while the window stays open (FREE_WEEK_SIGNUP_PERIOD=none)', () => {
    expect(freeWeekSignupGrant({ FREE_WEEK_ENABLED: 'true', FREE_WEEK_SIGNUP_PERIOD: 'none' }, T0)).toBe(null)
  })

  it('falls back to a week for an unrecognized value', () => {
    expect(freeWeekSignupGrant({ FREE_WEEK_ENABLED: 'true', FREE_WEEK_SIGNUP_PERIOD: 'decade' }, T0)).toMatchObject({ period: 'week' })
  })

  it('is null once the window has closed', () => {
    const env = { FREE_WEEK_ENABLED: 'true', FREE_WEEK_END: '2026-06-01T00:00:00Z' }
    expect(freeWeekSignupGrant(env, T0)).toBe(null)
  })
})

describe('signupTrialGrant (always-on new-user trial)', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('grants a 7-day week BY DEFAULT, with no env at all (promo off)', () => {
    const g = signupTrialGrant({}, T0)
    expect(g).toMatchObject({ period: 'week', days: 7 })
    expect(Date.parse(g.until)).toBe(T0 + 7 * DAY)
  })

  it('is independent of the Free Week promo (still grants when FREE_WEEK is off)', () => {
    expect(isFreeWeekActive({}, T0)).toBe(false)
    expect(signupTrialGrant({}, T0)).toMatchObject({ period: 'week', days: 7 })
  })

  it('can be disabled with SIGNUP_TRIAL_ENABLED=false', () => {
    expect(signupTrialGrant({ SIGNUP_TRIAL_ENABLED: 'false' }, T0)).toBe(null)
    expect(signupTrialGrant({ SIGNUP_TRIAL_ENABLED: 'off' }, T0)).toBe(null)
    expect(signupTrialGrant({ SIGNUP_TRIAL_ENABLED: '0' }, T0)).toBe(null)
  })

  it('honors SIGNUP_TRIAL_PERIOD=month and =none', () => {
    expect(signupTrialGrant({ SIGNUP_TRIAL_PERIOD: 'month' }, T0)).toMatchObject({ period: 'month', days: 30 })
    expect(signupTrialGrant({ SIGNUP_TRIAL_PERIOD: 'none' }, T0)).toBe(null)
  })

  it('falls back to a week for an unrecognized period', () => {
    expect(signupTrialGrant({ SIGNUP_TRIAL_PERIOD: 'decade' }, T0)).toMatchObject({ period: 'week', days: 7 })
  })
})
