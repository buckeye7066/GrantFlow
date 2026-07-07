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
    // total is the COVERAGE denominator = needs + identity/traits only.
    // dataPoints holds 13 (2 need + 4 geo + 1 applicant_type + rural + snap +
    // veteran + disability + gardening + 1 keyword); the denominator EXCLUDES
    // the 4 geo + 1 applicant_type (eligibility gates) + 1 keyword (mined) =
    // 7 coverage points (2 need + rural + snap + veteran + disability + gardening).
    expect(inv.total).toBe(7)
    expect(inv.keywordCount).toBe(1)
    expect(inv.dataPoints).toHaveLength(13)
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

  it('mined keywords are matchable but EXCLUDED from the denominator (owner directive 2026-07-07)', () => {
    const many = new Set(Array.from({ length: 500 }, (_, i) => `docterm${String(i).padStart(4, '0')}`))
    const inv = buildProfileDataPointInventory({
      profile: {},
      signals: signalsFixture({ keywordSet: many }),
    })
    // All 500 keyword points are still present (a source can still match them
    // for credit)...
    expect(inv.dataPoints.filter((d) => d.kind === 'keyword')).toHaveLength(500)
    expect(inv.keywordCount).toBe(500)
    // ...but they do NOT bloat the denominator: total is the coverage count
    // only (7, same as the base fixture), so 500 narrative words can't crush
    // every match to single digits (the Gilbert class).
    expect(inv.total).toBe(7)
  })

  it("a matched keyword still adds credit — coverage = credit ÷ SALIENT denominator", () => {
    // 4 salient needs + 6 narrative keywords. A source that matches 2 needs
    // and 3 keywords earns credit 5, over the salient denominator 4 → clamped
    // to 100 (keywords add credit; they never dilute).
    const salient = ['housing', 'food', 'medical', 'employment'].map((v) => ({ id: `need:${v}`, kind: 'need', value: v }))
    const keywords = Array.from({ length: 6 }, (_, i) => ({ id: `keyword:kw${i}`, kind: 'keyword', value: `kw${i}` }))
    const inv = { dataPoints: [...salient, ...keywords], total: salient.length, keywordCount: keywords.length }
    const r = evaluateDataPointMatches({
      inventory: inv,
      oppText: 'kw0 kw1 kw2',
      needCredits: new Map([['housing', 1], ['food', 1]]),
    })
    // 2 need credits + 3 keyword text matches = 5
    expect(r.credit).toBe(5)
    expect(Math.min(100, Math.round((r.credit / inv.total) * 100))).toBe(100)
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

  // ── Declared-program affinity (FIX 2) ──────────────────────────────────────
  describe('declared-program affinity', () => {
    // A medicaid_waiver / ecf_choices member's assistance points that the ECF
    // page text never literally states.
    const waiverInv = {
      dataPoints: [
        { id: 'assistance:medicaid_waiver', kind: 'assistance', value: 'medicaid_waiver' },
        { id: 'assistance:ecf_choices', kind: 'assistance', value: 'ecf_choices' },
      ],
      total: 2,
    }

    it('credits a declared program point when the opp IS that program source lane, even with keyword-thin text', () => {
      const r = evaluateDataPointMatches({
        inventory: waiverInv,
        oppText: 'employment and community first choices', // never says "medicaid waiver"
        oppSourceId: 'tn_ecf_choices',
      })
      const mw = r.matched.find((m) => m.id === 'assistance:medicaid_waiver')
      expect(mw, 'medicaid_waiver must be credited via declared-program affinity').toBeTruthy()
      expect(mw.via).toBe('declared_program')
    })

    it('does NOT credit the affinity for an unrelated source lane (evidence-based)', () => {
      const r = evaluateDataPointMatches({
        inventory: waiverInv,
        oppText: 'a generic small business grant',
        oppSourceId: 'sba_microloan',
      })
      expect(r.matched.find((m) => m.id === 'assistance:medicaid_waiver')).toBeUndefined()
    })

    it('prefers a direct text match (via:text) over affinity when the text does state it', () => {
      const r = evaluateDataPointMatches({
        inventory: waiverInv,
        oppText: 'this is a medicaid waiver program (ecf choices)',
        oppSourceId: 'tn_ecf_choices',
      })
      const mw = r.matched.find((m) => m.id === 'assistance:medicaid_waiver')
      expect(mw.via).toBe('text')
    })
  })
})
