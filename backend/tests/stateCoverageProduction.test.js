import { describe, expect, it } from 'vitest'
import { STATE_REGISTRY } from '../services/shared/data/stateRegistry.js'
import { generateStatePrograms, isStateInRegistry } from '../services/shared/data/stateBase.js'

// Production-readiness contract for geographic coverage: every US state + DC must
// be enumerated and must generate a complete set of REAL federal-passthrough
// programs with valid, https-only application URLs (no placeholders, no dead
// patterns). This guards against the regression where a state silently drops
// programs due to a missing registry URL (the voc-rehab gap that previously
// affected all 51 jurisdictions).

const ALL_JURISDICTIONS = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID',
  'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO',
  'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA',
  'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]

// The federal-passthrough programs that exist in EVERY state and so must appear
// in the generated baseline for all of them.
const REQUIRED_PROGRAMS = ['benefits-portal', 'snap', 'medicaid', 'liheap', 'voc-rehab', '211']

const PLACEHOLDER_PATTERNS = [/example\.(com|org)/i, /lorem/i, /placeholder/i, /your-?url/i, /todo/i]

describe('state coverage — production readiness (all 50 states + DC)', () => {
  it('enumerates exactly 51 jurisdictions and all are in the registry', () => {
    expect(ALL_JURISDICTIONS).toHaveLength(51)
    const missing = ALL_JURISDICTIONS.filter((s) => !isStateInRegistry(s))
    expect(missing).toEqual([])
    // Every registry key is a real jurisdiction (no stray/typo keys).
    const unexpected = Object.keys(STATE_REGISTRY).filter((s) => !ALL_JURISDICTIONS.includes(s))
    expect(unexpected).toEqual([])
  })

  it.each(ALL_JURISDICTIONS)('%s generates complete, valid, https-only coverage', (state) => {
    const result = generateStatePrograms(state)
    const benefits = result?.benefits ?? []

    // Non-trivial coverage.
    expect(benefits.length).toBeGreaterThanOrEqual(11)

    // Every program has a real https URL — no http, no placeholders.
    for (const b of benefits) {
      expect(typeof b.url, `${state} ${b.id} url type`).toBe('string')
      expect(b.url, `${state} ${b.id} must be https`).toMatch(/^https:\/\//i)
      for (const pat of PLACEHOLDER_PATTERNS) {
        expect(b.url, `${state} ${b.id} url placeholder`).not.toMatch(pat)
      }
      expect(b.name, `${state} ${b.id} name`).toBeTruthy()
    }

    // All required federal-passthrough programs present (suffix match on the id).
    const suffixes = benefits.map((b) => b.id.replace(`${state.toLowerCase()}-`, ''))
    for (const req of REQUIRED_PROGRAMS) {
      expect(suffixes, `${state} missing required program: ${req}`).toContain(req)
    }

    // No programs were dropped for missing/invalid URLs.
    expect(result.droppedCount ?? 0, `${state} dropped programs`).toBe(0)

    expect(result.meta?.name, `${state} meta.name`).toBeTruthy()
  })

  it('every registry entry has the core fields the generator depends on', () => {
    const offenders = []
    for (const [code, reg] of Object.entries(STATE_REGISTRY)) {
      const missing = []
      for (const f of ['name', 'benefitsPortal', 'benefitsPortalName', 'tanfName', 'medicaidUrl', 'housingUrl', 'vocRehabUrl']) {
        if (!reg[f]) missing.push(f)
      }
      if (!reg.hcbsWaiver?.url || !reg.hcbsWaiver?.agencyUrl || !reg.hcbsWaiver?.name) missing.push('hcbsWaiver')
      if (missing.length) offenders.push(`${code}: ${missing.join(',')}`)
    }
    expect(offenders).toEqual([])
  })
})
