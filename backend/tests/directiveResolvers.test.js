/**
 * Guard tests for the two owner-directive resolvers used to give Yana and
 * Hamilton a REAL (not just displayed) behavior change from a free-text
 * agent-control instruction:
 *   - directiveGeoResolver: "focus on Tennessee" -> ['TN']
 *   - directiveProfileResolver: "focus on the Smith Family Foundation" -> that
 *     profile's row, but ONLY when the match is unambiguous.
 *
 * Both are deliberately conservative — a wrong guess silently mis-scopes a
 * real run, which is worse than running unscoped — so most of these cases
 * assert the resolver correctly returns NOTHING rather than a guess.
 */

import { describe, it, expect } from 'vitest'
import { resolveStatesFromDirective } from '../services/agentControl/directiveGeoResolver.js'
import { resolveProfileFromDirective } from '../services/agentControl/directiveProfileResolver.js'

describe('resolveStatesFromDirective', () => {
  it('matches a full state name case-insensitively', () => {
    expect(resolveStatesFromDirective('Focus on tennessee this run')).toEqual(['TN'])
  })

  it('matches a multi-word state name', () => {
    expect(resolveStatesFromDirective('prioritize North Carolina orgs')).toEqual(['NC'])
  })

  it('matches an unambiguous bare 2-letter code', () => {
    expect(resolveStatesFromDirective('scope to OH only')).toEqual(['OH'])
  })

  it('does not false-positive on ordinary prose containing state-letter substrings', () => {
    // "in" / "or" / "me" / "hi" are common words, not standalone caps tokens here.
    expect(resolveStatesFromDirective('check in on the smith profile or wait')).toEqual([])
  })

  it('dedupes and sorts multiple states', () => {
    expect(resolveStatesFromDirective('Ohio and also OH again, then Texas')).toEqual(['OH', 'TX'])
  })

  it('returns empty for a directive naming no state', () => {
    expect(resolveStatesFromDirective('re-check the web-parity benchmark')).toEqual([])
  })

  it('returns empty for blank input', () => {
    expect(resolveStatesFromDirective('')).toEqual([])
    expect(resolveStatesFromDirective(null)).toEqual([])
  })
})

function makeDb(profiles) {
  return {
    prepare: (sql) => ({
      all: async () => {
        if (/FROM profiles/.test(sql)) return profiles
        return []
      },
    }),
  }
}

describe('resolveProfileFromDirective', () => {
  const profiles = [
    { id: 'p1', display_name: 'Smith Family Foundation' },
    { id: 'p2', display_name: 'Johnson City Area Arts Council' },
    { id: 'p3', display_name: 'Grant' }, // single-token name, never matchable alone
  ]

  it('resolves an unambiguous whole-name match', async () => {
    const db = makeDb(profiles)
    const result = await resolveProfileFromDirective(db, 'Please focus on the Smith Family Foundation profile this run')
    expect(result).toEqual({ id: 'p1', display_name: 'Smith Family Foundation' })
  })

  it('does not match on a single shared word (the one-token gate this codebase already rejects for Yana)', async () => {
    const db = makeDb(profiles)
    // "Family" alone appears in the text but Smith/Foundation do not.
    const result = await resolveProfileFromDirective(db, 'this is a family matter')
    expect(result).toBeNull()
  })

  it('never matches a single-token profile name', async () => {
    const db = makeDb(profiles)
    const result = await resolveProfileFromDirective(db, 'Grant is a common word in this app')
    expect(result).toBeNull()
  })

  it('returns null when a directive matches nothing', async () => {
    const db = makeDb(profiles)
    const result = await resolveProfileFromDirective(db, 'process the queue as normal')
    expect(result).toBeNull()
  })

  it('returns null (not a guess) when two profiles are both plausible', async () => {
    const ambiguous = [
      { id: 'p1', display_name: 'Riverside Community Center' },
      { id: 'p2', display_name: 'Riverside Community Church' },
    ]
    const db = makeDb(ambiguous)
    // Neither name's full token set is satisfied by this text alone, but
    // craft a directive that DOES satisfy both to prove ambiguity wins.
    const result = await resolveProfileFromDirective(db, 'Riverside Community Center Church project')
    expect(result).toBeNull()
  })

  it('returns null for blank input', async () => {
    const db = makeDb(profiles)
    expect(await resolveProfileFromDirective(db, '')).toBeNull()
    expect(await resolveProfileFromDirective(null, 'Smith Family Foundation')).toBeNull()
  })
})
