/**
 * studentaid.gov portal-sync connector — FAFSA read path.
 *
 * WHY IT EXISTS: studentaid.gov previously fell through to the GENERIC
 * connector. A live prod run on 2026-08-01 (Anastasia's captured session)
 * signed in successfully and honestly reported "no structured data connector
 * for this portal yet" — 0 fields, 0 awards. This connector reads the FAFSA
 * lifecycle stage, the Student Aid Index, stated Pell eligibility, and any
 * federal aid actually offered.
 *
 * The load-bearing guarantees under test:
 *   - every derived fact is ANCHORED to a verbatim page quote; a page that
 *     says nothing yields notFound, never a default (in particular, "cannot
 *     read a stage" must never become "not_started");
 *   - the FAFSA stage is MONOTONIC — a stale "Submitted on…" banner can never
 *     regress a profile already at `verification`;
 *   - Pell eligibility is never inferred from the SAI number;
 *   - write() is a HARD REFUSAL (federal filings are never agent-submitted).
 */
import { describe, it, expect, vi } from 'vitest'

const connector = (await import('../services/hamilton/portalSync/connectors/studentaid.js')).default
const {
  deriveFafsaStage, deriveSai, derivePellEligibility, saiBand, stageAdvances, matchesCredential,
} = await import('../services/hamilton/portalSync/connectors/studentaid.js')
const { resolveConnector, getConnectorForHost } = await import('../services/hamilton/portalSync/registry.js')

// The extractor is a network/LLM call; stub it so the read path is deterministic.
vi.mock('../services/hamilton/portalSync/llmPageExtract.js', () => ({
  extractPortalDataWithLLM: vi.fn(async () => ({
    awards: [], fields: [], notFound: [], rejected: [], raw: { stubbed: true },
  })),
}))

/** A fake authenticated page whose innerText is the supplied portal copy. */
function makePage(text, url = 'https://studentaid.gov/aid-summary/') {
  return {
    goto: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    url: () => url,
    evaluate: vi.fn(async () => ({ text, title: 'Federal Student Aid' })),
  }
}

describe('studentaid.gov connector — registry wiring', () => {
  it('claims studentaid.gov instead of falling through to the generic connector', () => {
    expect(getConnectorForHost('studentaid.gov').id).toBe('studentaid')
    expect(getConnectorForHost('www.studentaid.gov').id).toBe('studentaid')
    // Before this connector existed, prod resolved 'generic' here and read 0 fields.
    expect(getConnectorForHost('studentaid.gov').id).not.toBe('generic')
  })

  it('claims an FSA-ID credential stored under a different SSO host, and never steals MTSU', () => {
    expect(matchesCredential({ host: 'login.gov', label: 'FSA ID — federal student aid' })).toBe(true)
    expect(matchesCredential({ host: 'example.com', username: 'someone@example.com' })).toBe(false)
    expect(resolveConnector({ host: 'mtsu.edu' }).id).toBe('mtsu')
  })

  it('requires a captured session (an FSA ID + 2FA can never be driven headlessly)', () => {
    expect(connector.requiresSession).toBe(true)
  })
})

describe('studentaid.gov connector — quote-anchored derivations', () => {
  it('reads the FURTHEST stage a page evidences, not the first phrase on it', () => {
    // A real submission-summary page shows BOTH lines; verification is the truth.
    const hit = deriveFafsaStage('Your FAFSA form was submitted on January 5, 2026. You have been selected for verification.')
    expect(hit.stage).toBe('verification')
    expect(hit.evidence).toMatch(/selected for verification/i)
  })

  it('returns null (never "not_started") when no stage phrase is present', () => {
    expect(deriveFafsaStage('Welcome to Federal Student Aid. Explore loan repayment options.')).toBe(null)
    expect(deriveFafsaStage('')).toBe(null)
  })

  it('parses the SAI including negative values, and bands it as text', () => {
    expect(deriveSai('Student Aid Index (SAI): -1500').value).toBe(-1500)
    expect(deriveSai('Your SAI is 0 for the 2026-2027 award year.').value).toBe(0)
    expect(deriveSai('Expected Family Contribution: $12,345').value).toBe(12345)
    expect(deriveSai('No aid figures published here.')).toBe(null)
    expect(saiBand(-1500)).toMatch(/negative/i)
    expect(saiBand(0)).toMatch(/maximum need/i)
    expect(saiBand(12345)).toMatch(/moderate need/i)
  })

  it('never infers Pell eligibility from the SAI — only from a stated sentence', () => {
    // An SAI of 0 practically implies Pell, but the federal formula also depends
    // on enrollment intensity and cost of attendance: we do not guess.
    expect(derivePellEligibility('Student Aid Index (SAI): 0')).toBe(null)
    expect(derivePellEligibility('You may qualify for a Federal Pell Grant.').eligible).toBe(true)
    expect(derivePellEligibility('You are not eligible for a Federal Pell Grant.').eligible).toBe(false)
  })
})

describe('studentaid.gov connector — read()', () => {
  it('reads stage + SAI + Pell from a realistic submission summary and certifies both domains', async () => {
    const page = makePage([
      'FAFSA Submission Summary',
      'Your FAFSA form was submitted on January 5, 2026.',
      'Student Aid Index (SAI): 0',
      'You may qualify for a Federal Pell Grant.',
      'Your information was sent to your school.',
    ].join('\n'))

    const res = await connector.read(page, { log: () => {} })

    // Furthest evidenced stage wins: "sent to your school" beats "submitted".
    expect(res.fafsaStatus.stage).toBe('school_received')
    expect(res.fafsaStatus.evidence).toBeTruthy()

    const sai = res.fields.find((f) => f.field === 'efc_sai_band')
    expect(sai.value).toMatch(/SAI 0/)
    expect(res.fields.find((f) => f.field === 'pell_grant_eligible').value).toBe(true)

    expect(res.domains.fafsa_status.complete).toBe(true)
    expect(res.domains.aid_summary.complete).toBe(true)
  })

  it('an unreadable/empty page reports notFound honestly and certifies NOTHING', async () => {
    const page = makePage('')
    const res = await connector.read(page, { log: () => {} })

    expect(res.fafsaStatus).toBe(null)
    expect(res.fields).toHaveLength(0)
    expect(res.domains.fafsa_status.complete).toBe(false)
    expect(res.domains.aid_summary.complete).toBe(false)
    expect(res.notFound.length).toBeGreaterThan(0)
  })

  it('a page with no stage phrase leaves the stage unset and SAYS so (never defaults)', async () => {
    const page = makePage('Federal Student Aid. Loan simulator. Repayment plans.')
    const res = await connector.read(page, { log: () => {} })

    expect(res.fafsaStatus).toBe(null)
    expect(res.notFound.some((n) => /never defaulted to not_started/i.test(n.reason))).toBe(true)
    expect(res.domains.fafsa_status.complete).toBe(false)
  })
})

describe('studentaid.gov connector — monotonic stage guard', () => {
  it('advances forward but refuses to regress (a stale "Submitted on…" banner cannot erase verification)', () => {
    expect(stageAdvances('submitted', 'verification')).toBe(true)
    expect(stageAdvances('not_started', 'submitted')).toBe(true)
    expect(stageAdvances('verification', 'submitted')).toBe(false)
    expect(stageAdvances('complete', 'processed')).toBe(false)
    expect(stageAdvances('submitted', 'submitted')).toBe(false)
    expect(stageAdvances('submitted', 'nonsense_stage')).toBe(false)
  })
})

describe('studentaid.gov connector — write() is refused by design', () => {
  it('never writes, never stages, and returns an honest refusal reason', async () => {
    const page = makePage('FAFSA form')
    const res = await connector.write(page, { log: () => {} }, {
      fundingSources: [{ name: 'Some Scholarship', amount: 1000 }],
    })

    expect(res.written).toHaveLength(0)
    expect(res.skipped[0].reason).toMatch(/refused_by_design/)
    // The page must never be typed into or submitted.
    expect(page.evaluate).not.toHaveBeenCalled()
  })
})
