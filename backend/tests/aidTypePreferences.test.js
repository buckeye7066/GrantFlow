/**
 * Per-profile aid-type preference — "which aid would you actually accept?"
 *
 * OWNER RULE (2026-08-01): "give the profile the option of which aid they would
 * like to accept. In the case of Anastasia and Robert, for example, they do not
 * want any loans, only grants, endowments, and scholarships."
 *
 * A loan is debt with the student's name on it. GrantFlow's DISCOVERY path
 * already refuses loans (isLoanLike + the reality gate); portal SYNC did not —
 * upsertSchoolPortalAwardAsOpportunity wrote whatever a portal reported, so a
 * "Direct Subsidized Loan" from studentaid.gov would have entered the pipeline
 * as funding. These tests pin the single decision point both paths now share.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

process.env.RUNTIME_SECRETS_KEY = process.env.RUNTIME_SECRETS_KEY || 'a'.repeat(64)

const {
  classifyAidType, resolveAcceptedAidTypes, evaluateAwardAgainstPreferences,
  DEFAULT_ACCEPTED_AID_TYPES, AID_TYPE_KEYS, STUDENT_AID_TITLE_LIKE_PATTERNS,
} = await import('../config/aidTypePreferences.js')

describe('STUDENT_AID_TITLE_LIKE_PATTERNS (the SQL superset)', () => {
  // A recall sweep pushes this list into SQL, then lets `classifyAidType`
  // adjudicate. An extra pattern only costs a scan; a MISSING one makes a whole
  // class of aid unreachable while the sweep still reads green (#944).
  it('covers every non-debt title the classifier can name', () => {
    const titles = [
      'HOPE Scholarship', 'Federal Pell Grant', 'FSEOG',
      'Buchanan Fellowship', 'Warren E. Angel Endowed Scholarship',
      'TN Promise Scholarship', 'Tuition Assistance Program',
      'Merit Award', 'Federal Work-Study',
    ]
    for (const title of titles) {
      const aidType = classifyAidType({ title })
      expect(aidType, `${title} should classify`).not.toBe('unknown')
      const lower = title.toLowerCase()
      expect(
        STUDENT_AID_TITLE_LIKE_PATTERNS.some((p) => lower.includes(p.replace(/%/g, ''))),
        `"${title}" classifies as ${aidType} but no LIKE pattern would ever fetch it`,
      ).toBe(true)
    }
  })
})

describe('classifyAidType', () => {
  it('names federal aid the way portals actually print it', () => {
    expect(classifyAidType({ title: 'Direct Subsidized Loan' })).toBe('loan')
    expect(classifyAidType({ title: 'Direct Unsubsidized Loan' })).toBe('loan')
    expect(classifyAidType({ title: 'Parent PLUS Loan' })).toBe('loan')
    expect(classifyAidType({ title: 'Federal Pell Grant' })).toBe('grant')
    expect(classifyAidType({ title: 'FSEOG' })).toBe('grant')
    expect(classifyAidType({ title: 'Federal Work-Study' })).toBe('work_study')
    expect(classifyAidType({ title: 'TN Promise Scholarship' })).toBe('scholarship')
    expect(classifyAidType({ title: 'Smith Endowed Fellowship' })).toBe('endowment')
  })

  it('never mistakes loan RELIEF for new debt', () => {
    // Mirrors the discovery policy's LOAN_ASSISTANCE rule: help paying off
    // debt is not debt. Getting this wrong would hide real assistance.
    expect(classifyAidType({ title: 'Public Service Loan Forgiveness' })).not.toBe('loan')
    expect(classifyAidType({ title: 'Nurse Corps Loan Repayment Program' })).not.toBe('loan')
  })

  it('returns unknown rather than guessing', () => {
    expect(classifyAidType({ title: 'Award 2026-27' })).toBe('unknown')
    expect(classifyAidType({})).toBe('unknown')
  })
})

describe('resolveAcceptedAidTypes', () => {
  it('defaults to everything EXCEPT debt when the profile has said nothing', () => {
    expect(resolveAcceptedAidTypes({})).toEqual([...DEFAULT_ACCEPTED_AID_TYPES])
    expect(resolveAcceptedAidTypes({}).includes('loan')).toBe(false)
    // The default is the SAME posture discovery already takes — consistency,
    // not a new opinion.
    expect(resolveAcceptedAidTypes({}).sort()).toEqual(
      AID_TYPE_KEYS.filter((k) => k !== 'loan').sort(),
    )
  })

  it('honors an explicit list, tolerating spacing/case/hyphens and junk', () => {
    expect(resolveAcceptedAidTypes({ aid_types_accepted: ['Grant', 'SCHOLARSHIP', 'Work-Study'] }).sort())
      .toEqual(['grant', 'scholarship', 'work_study'])
    // A comma string is accepted too (how a text field may arrive).
    expect(resolveAcceptedAidTypes({ aid_types_accepted: 'grant, endowment' }).sort()).toEqual(['endowment', 'grant'])
    // Junk-only falls back to the default rather than accepting nothing.
    expect(resolveAcceptedAidTypes({ aid_types_accepted: ['nonsense'] })).toEqual([...DEFAULT_ACCEPTED_AID_TYPES])
  })

  it('a household CAN opt IN to loans explicitly', () => {
    expect(resolveAcceptedAidTypes({ aid_types_accepted: ['grant', 'loan'] })).toContain('loan')
  })
})

describe('evaluateAwardAgainstPreferences', () => {
  // Anastasia & Robert: grants, endowments, scholarships — no loans.
  const NO_LOANS = { aid_types_accepted: ['grant', 'endowment', 'scholarship'] }

  it('declines a loan for a no-loans profile, with a reason that stays honest about the offer', () => {
    const v = evaluateAwardAgainstPreferences({ title: 'Direct Subsidized Loan', amount: 3500 }, NO_LOANS)
    expect(v.accepted).toBe(false)
    expect(v.aidType).toBe('loan')
    // The student may still have a real offer to act on at the portal — the
    // reason must not imply it does not exist.
    expect(v.reason).toMatch(/still shown on the portal/i)
  })

  it('accepts the aid they DO want', () => {
    expect(evaluateAwardAgainstPreferences({ title: 'Federal Pell Grant', amount: 7395 }, NO_LOANS).accepted).toBe(true)
    expect(evaluateAwardAgainstPreferences({ title: 'TN Promise Scholarship' }, NO_LOANS).accepted).toBe(true)
    expect(evaluateAwardAgainstPreferences({ title: 'Smith Endowed Fellowship' }, NO_LOANS).accepted).toBe(true)
  })

  it('NEVER excludes an award it could not classify — unnamed money is still money', () => {
    const v = evaluateAwardAgainstPreferences({ title: 'Award 2026-27', amount: 1200 }, NO_LOANS)
    expect(v.accepted).toBe(true)
    expect(v.aidType).toBe('unknown')
  })

  it('a profile that opted into loans still gets them', () => {
    const v = evaluateAwardAgainstPreferences({ title: 'Direct Unsubsidized Loan' }, { aid_types_accepted: ['grant', 'loan'] })
    expect(v.accepted).toBe(true)
  })
})

describe('portal sync honors the preference (the path that used to bypass it)', () => {
  const upsertAward = vi.fn(async () => true)
  vi.doMock('../services/schoolPortalImportService.js', () => ({
    upsertSchoolPortalAwardAsOpportunity: upsertAward,
  }))

  let db
  let _internal
  beforeEach(async () => {
    vi.clearAllMocks()
    const Database = (await import('better-sqlite3')).default
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE profile_sections (
        profile_id TEXT, section_key TEXT, data TEXT, updated_by TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (profile_id, section_key)
      );
    `)
    db.prepare("INSERT INTO profile_sections (profile_id, section_key, data) VALUES ('pA','education',?)")
      .run(JSON.stringify({ aid_types_accepted: ['grant', 'endowment', 'scholarship'] }))
    ;({ _internal } = await import('../services/hamilton/portalSync/index.js'))
  })

  it('a loan read from the portal is DECLINED and reported, never written to the pipeline', async () => {
    const persisted = await _internal.persistReadResult(db, {
      profileId: 'pA',
      portalHost: 'studentaid.gov',
      actorUserId: 'u1',
      readResult: {
        fields: [],
        awards: [
          { title: 'Direct Subsidized Loan', amount: 3500, status: 'offered' },
          { title: 'Federal Pell Grant', amount: 7395, status: 'offered' },
        ],
      },
    })

    const declined = persisted.awardsDeclinedByPreference
    expect(declined).toHaveLength(1)
    expect(declined[0].title).toBe('Direct Subsidized Loan')
    expect(declined[0].aid_type).toBe('loan')
    // The loan never reached the pipeline writer at all.
    const written = upsertAward.mock.calls.map(([, award]) => award?.title)
    expect(written).not.toContain('Direct Subsidized Loan')
  })
})
