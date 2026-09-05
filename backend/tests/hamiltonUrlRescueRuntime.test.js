import { describe, it, expect } from 'vitest'
import { attemptRuntimeUrlRescue } from '../services/hamilton/hamiltonHardStopResolver.js'

// Runtime application-URL rescue (owner directive 2026-08-03): prod's dominant
// auto-submit stall was "No clear application URL or submission method" — every
// recent AUTHORIZED waiting_for_review task carried it (measured 2026-08-03)
// while the boot-only URL finder sat unused at run time. These tests pin the
// honesty gates: found-not-fabricated, no search pages, no same-page loops,
// and the #1113 tenant-slug funder screen.

const ctxFor = (over = {}) => ({
  opportunity: {
    title: 'Paramedic Continuing Education Scholarship',
    sponsor: 'Tennessee EMS Foundation',
  },
  portalUrl: null,
  ...over,
})

// A SERP hit that passes the finder's token-overlap plausibility for the
// title above (title tokens appear in the hit text).
const plausibleHit = (url) => ({
  url,
  title: 'Paramedic Continuing Education Scholarship — apply',
  snippet: 'Apply for the paramedic continuing education scholarship from the Tennessee EMS Foundation.',
})

const okProbe = async (url) => ({ status: 'ok', finalUrl: url })

describe('attemptRuntimeUrlRescue — a school\'s page about someone else\'s award is not the funder\'s portal', () => {
  const tsacCtx = () => ({
    opportunity: { title: 'Tennessee General Assembly Merit Scholarship', sponsor: 'Tennessee Student Assistance Corporation' },
    portalUrl: 'https://www.collegefortn.org/general-assembly-merit-scholarship/',
  })
  const relisterHit = {
    url: 'https://site.tusculum.edu/financial-aid/',
    title: 'Financial Aid | Tusculum University',
    snippet: 'Tennessee General Assembly Merit Scholarship, Tennessee HOPE Scholarship and other state aid for Tusculum students.',
  }
  it('refuses the live Tusculum re-listing for a TSAC award (institution_relister), never provisioning a stranger school', async () => {
    const result = await attemptRuntimeUrlRescue(tsacCtx(), { url: 'https://www.collegefortn.org/general-assembly-merit-scholarship/' }, {
      searchWebImpl: async () => [relisterHit],
      checkUrlImpl: okProbe,
    })
    expect(result.url).toBeNull()
    expect(result.reason).toBe('institution_relister')
    expect(result.rejected_url).toBe('https://site.tusculum.edu/financial-aid/')
  })
  it('keeps an institution host the FUNDER\'s own name explains (MTSU award on mtsu.edu)', async () => {
    const ctx = { opportunity: { title: 'MTSU Guaranteed Scholarship', sponsor: 'Middle Tennessee State University' }, portalUrl: null }
    const result = await attemptRuntimeUrlRescue(ctx, { url: null }, {
      searchWebImpl: async () => [{ url: 'https://www.mtsu.edu/financial-aid/guaranteed-scholarship/apply', title: 'MTSU Guaranteed Scholarship — Apply', snippet: 'Apply for the MTSU Guaranteed Scholarship at Middle Tennessee State University.' }],
      checkUrlImpl: okProbe,
    })
    expect(result.url).toBe('https://www.mtsu.edu/financial-aid/guaranteed-scholarship/apply')
  })
})

describe('attemptRuntimeUrlRescue', () => {
  it('finds, screens, and returns a live application page', async () => {
    const res = await attemptRuntimeUrlRescue(ctxFor(), {}, {
      searchWebImpl: async () => [plausibleHit('https://tnemsfoundation.org/scholarship/apply')],
      checkUrlImpl: okProbe,
    })
    expect(res.url).toBe('https://tnemsfoundation.org/scholarship/apply')
  })

  it('NEVER fabricates: empty search → search_empty (a transient, NOT a finding about the funder), provider failure → search_failed', async () => {
    // 2026-08-31: zero hits used to be reported as nothing_verifiable and
    // parked the task on a manual packet — but zero hits is the recurring
    // search-provider outage/quota signature, so the resolver now DEFERS it.
    const empty = await attemptRuntimeUrlRescue(ctxFor(), {}, {
      searchWebImpl: async () => [],
      checkUrlImpl: okProbe,
    })
    expect(empty.url).toBeNull()
    expect(empty.reason).toBe('search_empty')

    const failed = await attemptRuntimeUrlRescue(ctxFor(), {}, {
      searchWebImpl: async () => { throw new Error('provider down') },
      checkUrlImpl: okProbe,
    })
    expect(failed.url).toBeNull()
    expect(failed.reason).toBe('search_failed')
  })

  it('a search that RAN with real hits none of which verify is still nothing_verifiable (only that concludes the packet)', async () => {
    const res = await attemptRuntimeUrlRescue(ctxFor(), {}, {
      // A hit that fails the token-overlap plausibility bar for the title.
      searchWebImpl: async () => [{ url: 'https://unrelated.example.com/page', title: 'Totally different subject', snippet: 'nothing shared' }],
      checkUrlImpl: okProbe,
    })
    expect(res.url).toBeNull()
    expect(res.reason).toBe('nothing_verifiable')
    expect(res.hits).toBe(1)
  })

  it('a BOT-WALLED apply page (403 to the datacenter probe) is returned alive with bot_walled:true — never "nothing verifiable"', async () => {
    const res = await attemptRuntimeUrlRescue(ctxFor(), {}, {
      searchWebImpl: async () => [plausibleHit('https://tnemsfoundation.org/scholarship/apply')],
      checkUrlImpl: async (url) => ({ status: 'broken', code: 403, finalUrl: url }),
    })
    expect(res.url).toBe('https://tnemsfoundation.org/scholarship/apply')
    expect(res.bot_walled).toBe(true)
  })

  it('refuses to re-serve the SAME page the engine just dead-ended on (no loop)', async () => {
    const res = await attemptRuntimeUrlRescue(
      ctxFor(),
      { url: 'https://tnemsfoundation.org/scholarship/apply/' },
      {
        searchWebImpl: async () => [plausibleHit('https://tnemsfoundation.org/scholarship/apply')],
        checkUrlImpl: okProbe,
      },
    )
    expect(res.url).toBeNull()
    expect(res.reason).toBe('same_dead_end_page')
  })

  it('refuses a dead page: liveness probe must pass', async () => {
    const res = await attemptRuntimeUrlRescue(ctxFor(), {}, {
      searchWebImpl: async () => [plausibleHit('https://tnemsfoundation.org/gone')],
      checkUrlImpl: async () => ({ status: 'dead' }),
    })
    expect(res.url).toBeNull()
  })

  it('applies the #1113 tenant-slug funder screen: cpcc.academicworks.com is refused for Cleveland State CC', async () => {
    // The live 2026-08-03 walkthrough defect: a Central Piedmont CC (NC)
    // portal minted onto a Cleveland State Community College (TN) opportunity.
    // The slug 'cpcc' is not explainable by the funder's whole name, so the
    // rescue must refuse it even when search + liveness both pass.
    const res = await attemptRuntimeUrlRescue(
      ctxFor({
        opportunity: {
          title: 'Cleveland State Community College Foundation Scholarships',
          sponsor: 'Cleveland State Community College',
        },
      }),
      {},
      {
        searchWebImpl: async () => [{
          url: 'https://cpcc.academicworks.com/',
          title: 'Cleveland State Community College Foundation Scholarships portal',
          snippet: 'cleveland state community college foundation scholarships',
        }],
        checkUrlImpl: okProbe,
      },
    )
    expect(res.url).toBeNull()
    expect(res.reason).toBe('funder_mismatch')
  })

  it('no title to search → honest no_title_to_search, and never throws', async () => {
    const res = await attemptRuntimeUrlRescue({ opportunity: {} }, {}, {
      searchWebImpl: async () => [plausibleHit('https://x.org/apply')],
      checkUrlImpl: okProbe,
    })
    expect(res.url).toBeNull()
    expect(res.reason).toBe('no_title_to_search')
  })
})
