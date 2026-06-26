import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { getAppAndDb, resetDb } from './testServer.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { scoreOpportunity } from '../services/matchEngine.js'
import { SCORE_FLOOR } from '../config/matchThresholds.js'
import { GOLDEN_SCORING_PROFILES, OPP } from './fixtures/goldenProfileScoring.js'

/**
 * ============================================================================
 * GOLDEN PROFILE — scoring & explainability regression contract
 * ============================================================================
 *
 * WHAT THIS PROTECTS
 * ------------------
 * These tests are an architecture-level safety net. They lock in the BEHAVIOR
 * (not the exact numbers) of the canonical matching engine
 * (backend/services/matchEngine.js → `scoreOpportunity`) for the five core
 * profile TYPES the product serves:
 *
 *   1. Student            (synthetic paramedic-track HS student,
 *                          Cleveland TN / Bradley County, financial need,
 *                          STEM / EMS interests)
 *   2. Individual/family  (low-income, housing/food/medical/utility needs)
 *   3. Church / faith org  (501(c)(3), faith-based outreach)
 *   4. Volunteer fire/EMS  (first-responder org, equipment + training)
 *   5. Nonprofit (501c3)   (youth education / community org)
 *
 * Each profile is seeded into the test DB as a REAL profile (profiles row +
 * profile_sections) and loaded through the REAL builder chain
 * (loadProfileContext → buildProfileSignals → normalizeProfile →
 * buildProfileFacets). We then score it against a small, fixed set of inline,
 * fully-OFFLINE opportunity fixtures. No network, no live crawlers.
 *
 * THE CONTRACT (what must keep holding)
 * -------------------------------------
 *  - A clearly-relevant opportunity scores in a sensible BAND and MEANINGFULLY
 *    higher than a clearly-irrelevant one (e.g. an EMS/education grant beats a
 *    commercial fishery grant for the student).
 *  - A 501(c)(3)-only grant is NOT a strong match for an individual/family.
 *  - Match REASONS / explanations are present and reference the right signals
 *    (geo / need / eligibility / keywords).
 *  - Missing high-value fields DOWNGRADE, never hard-REJECT (canonical rule
 *    G4): a relevant opportunity still produces a meaningful, non-zero score
 *    even when the profile lacks geo or a full education section, and never
 *    drops below the engine floor.
 *
 * HOW TO READ A FAILURE
 * ---------------------
 * Assertions are intentionally TOLERANT — bands, orderings, inequalities, and
 * presence checks — NOT brittle exact scores. They are designed to survive
 * legitimate recalibration of the engine while still catching real breakage:
 *   - a relevant grant dropping below a sane floor,
 *   - the relevant/irrelevant ordering inverting,
 *   - reasons or matched-signal explanations disappearing,
 *   - missing data turning into a hard reject (score collapsing to ~0).
 *
 * If you intentionally changed scoring and a band edge moved a little, widen
 * the band. If an ORDERING or a PRESENCE check fails, that is almost certainly
 * a real regression — investigate before relaxing it.
 *
 * The reference scores observed at authoring time (sonnet/opus calibration,
 * matcher v4.1.2) are noted inline next to each band so a future reader can see
 * how much headroom each assertion has.
 * ============================================================================
 */

let db

// Bands are deliberately wide. They bracket the observed reference score with
// generous headroom on both sides so calibration moves don't flake the suite,
// while still pinning "relevant grants stay strong / irrelevant grants stay weak".
const BAND = {
  STRONG_MIN: 60, // a clearly-relevant, geo+need-aligned match should clear this
  WEAK_MAX: 50,   // a clearly-irrelevant or wrong-type opportunity should stay under this
  // Meaningful separation: relevant must beat irrelevant by at least this much.
  MIN_SEPARATION: 15,
}

const seededCtx = {}

function seedGoldenProfile(p) {
  const userId = 'u-gold-' + Math.random().toString(36).slice(2, 10)
  db.prepare(
    `INSERT INTO users (id, primary_email, created_at, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(userId, `${userId}@test.local`)

  const profileId = 'p-gold-' + Math.random().toString(36).slice(2, 10)
  db.prepare(
    `INSERT INTO profiles (id, user_id, display_name, primary_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run(profileId, userId, p.display_name, p.primary_type)

  for (const [key, data] of Object.entries(p.sections)) {
    db.prepare(
      `INSERT INTO profile_sections (id, profile_id, section_key, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run('ps-' + Math.random().toString(36).slice(2, 10), profileId, key, JSON.stringify(data))
  }
  return profileId
}

// A lightweight ad-hoc seeder for the "missing field" invariant cases.
function seedAdHoc(display, type, sections) {
  return seedGoldenProfile({ display_name: display, primary_type: type, sections })
}

function reasonsText(result) {
  return (result.reasons || []).join(' | ').toLowerCase()
}

beforeAll(async () => {
  ;({ db } = await getAppAndDb())
}, 60_000)

beforeEach(async () => {
  resetDb(db)
  // Re-seed all five golden profiles into the freshly-reset DB and load each
  // through the real builder chain so every test sees populated facets +
  // profileNorm exactly as production does.
  for (const p of GOLDEN_SCORING_PROFILES) {
    const id = seedGoldenProfile(p)
    seededCtx[p.key] = await loadProfileContext(db, id)
  }
})

// ---------------------------------------------------------------------------
// Builder sanity — the golden contexts must be fully populated (real builders).
// If this breaks, the rest of the suite is meaningless, so assert it loudly.
// ---------------------------------------------------------------------------

describe('golden profiles load through the real builder chain', () => {
  it('populates signals, facets, and profileNorm for every golden profile', () => {
    for (const p of GOLDEN_SCORING_PROFILES) {
      const ctx = seededCtx[p.key]
      expect(ctx, `ctx missing for ${p.key}`).toBeTruthy()
      // signals.location must resolve from sections (no profiles.state column).
      expect(ctx.signals?.location, `signals.location missing for ${p.key}`).toBeTruthy()
      // facets must be a populated object with the canonical groups the matcher reads.
      expect(Object.keys(ctx.facets || {}), `facets empty for ${p.key}`).toEqual(
        expect.arrayContaining(['profile', 'geo', 'intent']),
      )
      // profileNorm must be built (the recent loadProfileContext fix).
      expect(ctx.profileNorm, `profileNorm null for ${p.key}`).toBeTruthy()
      expect(ctx.profileNorm.entityType, `entityType missing for ${p.key}`).toBeTruthy()
    }
  })

  it('derives the expected core entity/identity flags per type', () => {
    expect(seededCtx.student_paramedic_tn.profileNorm.isStudent).toBe(true)
    expect(seededCtx.student_paramedic_tn.profileNorm.state).toBe('TN')

    expect(seededCtx.individual_family_lowincome.profileNorm.entityType).toBe('individual')
    expect(seededCtx.individual_family_lowincome.profileNorm.state).toBe('OH')

    expect(seededCtx.church_faith_org.profileNorm.isNonprofit).toBe(true)
    expect(seededCtx.volunteer_fire_ems.profileNorm.isNonprofit).toBe(true)
    expect(seededCtx.nonprofit_501c3.profileNorm.isNonprofit).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 1) STUDENT — EMS/education grant must beat an unrelated fishery grant.
// ---------------------------------------------------------------------------

describe('golden profile: STUDENT (paramedic-track, TN, financial need)', () => {
  it('scores an EMS/education scholarship as a STRONG match', () => {
    // Reference: ~100. Floor band 60 leaves huge headroom.
    const r = scoreOpportunity(seededCtx.student_paramedic_tn, OPP.emsEducationScholarshipTN)
    expect(r.score).toBeGreaterThanOrEqual(BAND.STRONG_MIN)
  })

  it('scores a national Pell-style student aid grant as a meaningful match', () => {
    // Reference: ~82. National geo + student aid.
    const r = scoreOpportunity(seededCtx.student_paramedic_tn, OPP.pellGrantNational)
    expect(r.score).toBeGreaterThanOrEqual(BAND.STRONG_MIN)
  })

  it('ranks the relevant EMS grant MEANINGFULLY above an unrelated fishery grant', () => {
    // Reference: ems ~100 vs fishery ~39.
    const rel = scoreOpportunity(seededCtx.student_paramedic_tn, OPP.emsEducationScholarshipTN)
    const irrel = scoreOpportunity(seededCtx.student_paramedic_tn, OPP.fisheryGrantAK)
    expect(irrel.score).toBeLessThanOrEqual(BAND.WEAK_MAX)
    expect(rel.score - irrel.score).toBeGreaterThanOrEqual(BAND.MIN_SEPARATION)
  })

  it('explains the EMS match with geo + need/keyword + applicant-type reasons', () => {
    const r = scoreOpportunity(seededCtx.student_paramedic_tn, OPP.emsEducationScholarshipTN)
    expect(Array.isArray(r.reasons)).toBe(true)
    expect(r.reasons.length).toBeGreaterThan(0)
    const text = reasonsText(r)
    // Geographic signal (TN state match) must be cited.
    expect(text).toMatch(/geograph|state|tennessee/)
    // Need / keyword / category signal must be cited.
    expect(text).toMatch(/need|keyword|category|scholar|ems|education/)
    // Matched-signal explainability surface must be populated.
    const signals = r.match_explain?.matchedSignals || []
    expect(signals.length).toBeGreaterThan(0)
    expect(signals).toEqual(expect.arrayContaining(['applicant_type']))
  })
})

// ---------------------------------------------------------------------------
// 2) INDIVIDUAL / FAMILY — relevant assistance beats 501c3-only + fishery.
// ---------------------------------------------------------------------------

describe('golden profile: INDIVIDUAL/FAMILY (low-income, multi-need)', () => {
  it('scores local emergency rent/utility/food assistance as a STRONG match', () => {
    // Reference: ~93.
    const r = scoreOpportunity(seededCtx.individual_family_lowincome, OPP.familyEmergencyAssistanceOH)
    expect(r.score).toBeGreaterThanOrEqual(BAND.STRONG_MIN)
  })

  it('does NOT treat a 501(c)(3)-only grant as a strong match for a family', () => {
    // Reference: ~26. Must stay clearly below the strong band.
    const r = scoreOpportunity(seededCtx.individual_family_lowincome, OPP.nonprofitOnlyCapacityGrant)
    expect(r.score).toBeLessThanOrEqual(BAND.WEAK_MAX)
  })

  it('ranks relevant assistance meaningfully above the 501c3-only grant', () => {
    const rel = scoreOpportunity(seededCtx.individual_family_lowincome, OPP.familyEmergencyAssistanceOH)
    const irrel = scoreOpportunity(seededCtx.individual_family_lowincome, OPP.nonprofitOnlyCapacityGrant)
    expect(rel.score - irrel.score).toBeGreaterThanOrEqual(BAND.MIN_SEPARATION)
  })

  it('explains the assistance match with need + geo reasons', () => {
    const r = scoreOpportunity(seededCtx.individual_family_lowincome, OPP.familyEmergencyAssistanceOH)
    const text = reasonsText(r)
    expect(text).toMatch(/need|keyword|rent|util|food|housing/)
    expect(text).toMatch(/geograph|state|ohio/)
    expect((r.match_explain?.matchedSignals || [])).toEqual(expect.arrayContaining(['needs']))
  })
})

// ---------------------------------------------------------------------------
// 3) CHURCH / FAITH-BASED ORG — faith grant beats unrelated fishery grant.
// ---------------------------------------------------------------------------

describe('golden profile: CHURCH / FAITH-BASED ORG', () => {
  it('scores a faith-based community/food grant as a STRONG match', () => {
    // Reference: ~100.
    const r = scoreOpportunity(seededCtx.church_faith_org, OPP.faithBasedCommunityGrantTX)
    expect(r.score).toBeGreaterThanOrEqual(BAND.STRONG_MIN)
  })

  it('ranks the faith grant meaningfully above an unrelated fishery grant', () => {
    const rel = scoreOpportunity(seededCtx.church_faith_org, OPP.faithBasedCommunityGrantTX)
    const irrel = scoreOpportunity(seededCtx.church_faith_org, OPP.fisheryGrantAK)
    expect(irrel.score).toBeLessThanOrEqual(BAND.WEAK_MAX)
    expect(rel.score - irrel.score).toBeGreaterThanOrEqual(BAND.MIN_SEPARATION)
  })

  it('explains the faith match (faith/affiliation signal cited)', () => {
    const r = scoreOpportunity(seededCtx.church_faith_org, OPP.faithBasedCommunityGrantTX)
    const text = reasonsText(r)
    expect(text).toMatch(/faith|church|ministry|congregation|religio/)
    expect(r.reasons.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4) VOLUNTEER FIRE / EMS ORG — FEMA AFG equipment grant beats fishery + Pell.
// ---------------------------------------------------------------------------

describe('golden profile: VOLUNTEER FIRE / EMS ORG', () => {
  it('scores a FEMA AFG fire/EMS equipment grant as a meaningful match', () => {
    // Reference: ~64.
    const r = scoreOpportunity(seededCtx.volunteer_fire_ems, OPP.femaAfgFireEquipment)
    expect(r.score).toBeGreaterThanOrEqual(BAND.STRONG_MIN)
  })

  it('ranks the fire/EMS grant meaningfully above unrelated grants', () => {
    const rel = scoreOpportunity(seededCtx.volunteer_fire_ems, OPP.femaAfgFireEquipment)
    const fishery = scoreOpportunity(seededCtx.volunteer_fire_ems, OPP.fisheryGrantAK)
    const pell = scoreOpportunity(seededCtx.volunteer_fire_ems, OPP.pellGrantNational)
    expect(fishery.score).toBeLessThanOrEqual(BAND.WEAK_MAX)
    expect(pell.score).toBeLessThanOrEqual(BAND.WEAK_MAX)
    expect(rel.score - fishery.score).toBeGreaterThanOrEqual(BAND.MIN_SEPARATION)
    expect(rel.score - pell.score).toBeGreaterThanOrEqual(BAND.MIN_SEPARATION)
  })

  it('explains the fire/EMS match (fire/ems/equipment signal cited)', () => {
    const r = scoreOpportunity(seededCtx.volunteer_fire_ems, OPP.femaAfgFireEquipment)
    const text = reasonsText(r)
    expect(text).toMatch(/keyword|category|fire|ems|equipment|first responder/)
    expect((r.match_explain?.matchedSignals || []).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 5) NONPROFIT (501c3) — youth-education program grant beats fishery grant.
// ---------------------------------------------------------------------------

describe('golden profile: NONPROFIT (501c3)', () => {
  it('scores a youth-education nonprofit program grant above the irrelevant fishery grant', () => {
    // Reference: youth-edu ~48 vs fishery ~26. Both are below the strong band
    // (the seeded nonprofit profile is sparse on declared needs), so we pin the
    // ORDERING + separation rather than an absolute strong-band floor.
    const rel = scoreOpportunity(seededCtx.nonprofit_501c3, OPP.youthEducationNonprofitGrant)
    const irrel = scoreOpportunity(seededCtx.nonprofit_501c3, OPP.fisheryGrantAK)
    expect(rel.score).toBeGreaterThan(irrel.score)
    expect(rel.score - irrel.score).toBeGreaterThanOrEqual(BAND.MIN_SEPARATION)
  })

  it('matches the nonprofit on applicant-type / keyword signals for nonprofit-targeted grants', () => {
    const r = scoreOpportunity(seededCtx.nonprofit_501c3, OPP.youthEducationNonprofitGrant)
    const signals = r.match_explain?.matchedSignals || []
    expect(signals.length).toBeGreaterThan(0)
    // A nonprofit-targeted, keyword-rich grant should light up applicant-type or keyword/category.
    expect(signals.some((s) => ['applicant_type', 'keywords', 'category'].includes(s))).toBe(true)
    expect(r.reasons.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// CROSS-CUTTING INVARIANT — "missing data DOWNGRADES, never hard-REJECTS" (G4).
// Pinned independently of any single profile so a future change that turns a
// missing field into a hard zero/reject fails loudly here.
// ---------------------------------------------------------------------------

describe('invariant: missing high-value fields downgrade, never hard-reject (G4)', () => {
  it('a student missing the ENTIRE education section still strongly matches an EMS scholarship', async () => {
    // Only location + student primary_type — no major/gpa/stem signals at all.
    const ctx = await loadProfileContext(
      db,
      seedAdHoc('Sparse Student', 'high_school_student', {
        basic_information: { state: 'TN', city: 'Cleveland', zip: '37311', profile_category: 'student' },
      }),
    )
    const r = scoreOpportunity(ctx, OPP.emsEducationScholarshipTN)
    // Reference ~100. The point is it is NOT rejected/zeroed despite the missing
    // education section — it must remain a meaningful, non-trivial match.
    expect(r.score).toBeGreaterThan(SCORE_FLOOR)
    expect(r.score).toBeGreaterThanOrEqual(BAND.STRONG_MIN)
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('a student missing LOCATION still produces a meaningful (non-zero) score, not a reject', async () => {
    // No basic_information section at all → signals.location.state is null.
    // Geo missing must fall to a NEUTRAL baseline, never a hard reject.
    const ctx = await loadProfileContext(
      db,
      seedAdHoc('No-Location Student', 'high_school_student', {
        education: { intended_major: 'EMS / Paramedic', gpa: 3.5, stem_student: true },
      }),
    )
    expect(ctx.profileNorm.state === null || ctx.profileNorm.state === undefined).toBe(true)
    const r = scoreOpportunity(ctx, OPP.emsEducationScholarshipTN)
    // Missing geo downgrades from ~100 to a still-strong score (~75 reference),
    // and absolutely must stay well above the engine floor (never ~0).
    expect(r.score).toBeGreaterThan(SCORE_FLOOR)
    expect(r.score).toBeGreaterThanOrEqual(40)
    // Reasons should note the location is unknown rather than vanish.
    expect(r.reasons.length).toBeGreaterThan(0)
  })

  it('a generic opportunity with NO need/category signals still scores above the floor for every golden profile', () => {
    // Sparse OPPORTUNITY data must not zero out a validated opportunity either.
    for (const p of GOLDEN_SCORING_PROFILES) {
      const r = scoreOpportunity(seededCtx[p.key], OPP.genericNoSignalGrant)
      expect(r.score, `generic grant scored below floor for ${p.key}`).toBeGreaterThanOrEqual(SCORE_FLOOR)
      expect(r.reasons.length).toBeGreaterThan(0)
    }
  })
})
