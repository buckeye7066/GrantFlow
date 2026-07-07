import { describe, it, expect } from 'vitest'
import {
  buildProfileDataPointInventory,
  evaluateDataPointMatches,
} from '../services/profileDataPoints.js'

function signalsFixture(overrides = {}) {
  return {
    needs: new Set(['housing', 'utilities']),
    location: { state: 'TN', county: 'Bradley', city: 'Cleveland', zip: '37311' },
    states: ['TN'],
    applicantType: 'individual',
    applicantTypes: new Set(),
    demographics: new Set(['rural']),
    genders: new Set(),
    assistance: new Set(['snap']),
    military: new Set(['veteran']),
    health: new Set(['disability']),
    family: new Set(),
    occupation: new Set(),
    credentials: new Set(),
    immigration: new Set(),
    geographic: new Set(),
    sports: new Set(),
    interests: new Set(['gardening']),
    academics: {},
    financial: {},
    keywordSet: new Set(['energy assistance']),
    ...overrides,
  }
}

describe('buildProfileDataPointInventory', () => {
  it('produces one deterministic data point per distinct profile fact', () => {
    const inv = buildProfileDataPointInventory({ profile: {}, signals: signalsFixture() })
    const ids = inv.dataPoints.map((d) => d.id)
    // 2 needs + 4 geo + 1 applicant type + rural + snap + veteran + disability
    // + gardening + 1 keyword = 13 (states:['TN'] dedups against geo:state tn)
    expect(inv.total).toBe(13)
    expect(ids).toContain('need:housing')
    expect(ids).toContain('geo:state tn')
    expect(ids).toContain('geo:zip 37311')
    expect(ids).toContain('applicant_type:individual')
    expect(ids).toContain('military:veteran')
    expect(ids).toContain('keyword:energy assistance')
    // Deterministic: same input, same order
    const again = buildProfileDataPointInventory({ profile: {}, signals: signalsFixture() })
    expect(again.dataPoints.map((d) => d.id)).toEqual(ids)
  })

  it('dedups a keyword that mirrors a structured fact (registerKeyword echo)', () => {
    const inv = buildProfileDataPointInventory({
      profile: {},
      signals: signalsFixture({ keywordSet: new Set(['veteran', 'energy assistance']) }),
    })
    const keywordPoints = inv.dataPoints.filter((d) => d.kind === 'keyword')
    expect(keywordPoints.map((d) => d.value)).toEqual(['energy assistance'])
    // veteran appears exactly once, as the structured military point
    expect(inv.dataPoints.filter((d) => /veteran/.test(d.id))).toHaveLength(1)
  })

  it('never caps the denominator — every distinct keyword is a data point (owner directive)', () => {
    const many = new Set(Array.from({ length: 500 }, (_, i) => `docterm${String(i).padStart(4, '0')}`))
    const inv = buildProfileDataPointInventory({
      profile: {},
      signals: signalsFixture({ keywordSet: many }),
    })
    expect(inv.dataPoints.filter((d) => d.kind === 'keyword')).toHaveLength(500)
  })

  it("owner's arithmetic at scale: 10,000 points with 500 matched → 5", () => {
    const dataPoints = Array.from({ length: 10000 }, (_, i) => ({
      id: `keyword:kw${i}`, kind: 'keyword', value: `kw${i}`,
    }))
    const inv = { dataPoints, total: 10000 }
    // Credit 500 of them via the need-credit path (cheap; avoids 10k regex scans).
    const needPoints = dataPoints.slice(0, 500).map((d) => ({ ...d, kind: 'need' }))
    const mixed = { dataPoints: [...needPoints, ...dataPoints.slice(500)], total: 10000 }
    const credits = new Map(needPoints.map((d) => [d.value, 1]))
    const r = evaluateDataPointMatches({ inventory: mixed, oppText: '', needCredits: credits })
    expect(r.credit).toBe(500)
    expect(Math.round((r.credit / mixed.total) * 100)).toBe(5)
  })

  it('honors the engine-resolved coverage needs (org-aware) over raw signals', () => {
    const inv = buildProfileDataPointInventory({
      profile: {},
      signals: signalsFixture(),
      coverageNeeds: ['fire_equipment', 'training'],
    })
    const needValues = inv.dataPoints.filter((d) => d.kind === 'need').map((d) => d.value)
    expect(needValues).toEqual(['fire_equipment', 'training'])
    // An interest promoted into needs never double-counts as an interest
    const inv2 = buildProfileDataPointInventory({
      profile: {},
      signals: signalsFixture({ interests: new Set(['training']) }),
      coverageNeeds: ['training'],
    })
    expect(inv2.dataPoints.filter((d) => /training/.test(d.id))).toHaveLength(1)
  })
})

describe('evaluateDataPointMatches', () => {
  const inventory = buildProfileDataPointInventory({ profile: {}, signals: signalsFixture() })

  it('takes need credit from the graded pass, not its own scan', () => {
    const { credit, matched } = evaluateDataPointMatches({
      inventory,
      oppText: 'totally unrelated text',
      needCredits: new Map([['housing', 1], ['utilities', 0.5]]),
    })
    expect(credit).toBe(1.5)
    expect(matched.map((m) => m.id).sort()).toEqual(['need:housing', 'need:utilities'])
    expect(matched.every((m) => m.via === 'need_scan')).toBe(true)
  })

  it('credits all geo points only when the geo gate matched', () => {
    const miss = evaluateDataPointMatches({ inventory, oppText: 'serves Cleveland Tennessee', geoMatched: false })
    expect(miss.matched.filter((m) => m.kind === 'geo')).toHaveLength(0)
    const hit = evaluateDataPointMatches({ inventory, oppText: '', geoMatched: true })
    expect(hit.matched.filter((m) => m.kind === 'geo')).toHaveLength(4)
    expect(hit.matched.filter((m) => m.kind === 'geo').every((m) => m.via === 'geo_gate')).toBe(true)
  })

  it('credits the primary applicant type from the eligibility gate verdict', () => {
    const r = evaluateDataPointMatches({
      inventory,
      oppText: 'no mention of who applies',
      applicantTypeMatch: true,
      primaryApplicantType: 'individual',
    })
    const at = r.matched.find((m) => m.id === 'applicant_type:individual')
    expect(at?.via).toBe('eligibility_gate')
  })

  it('matches trait points by whole word only — no substring phantoms', () => {
    // 'snap' must not match "snapshot"; 'veteran' must match "veterans"
    const r = evaluateDataPointMatches({
      inventory,
      oppText: 'a snapshot of grants for veterans with a disability',
    })
    const ids = r.matched.map((m) => m.id)
    expect(ids).toContain('military:veteran')
    expect(ids).toContain('health:disability')
    expect(ids).not.toContain('assistance:snap')
  })

  it("owner's arithmetic: matched/total drives the ratio (44/88 → 50%)", () => {
    const dataPoints = Array.from({ length: 88 }, (_, i) => ({
      id: `keyword:term${String(i).padStart(3, '0')}`, kind: 'keyword', value: `term${String(i).padStart(3, '0')}`,
    }))
    const inv = { dataPoints, total: 88, truncatedKeywords: 0 }
    const oppText = dataPoints.slice(0, 44).map((d) => d.value).join(' ')
    const r = evaluateDataPointMatches({ inventory: inv, oppText })
    expect(r.credit).toBe(44)
    expect(Math.round((r.credit / inv.total) * 100)).toBe(50)
  })
})
