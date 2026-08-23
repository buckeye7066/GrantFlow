/** Unit tests for the live profile-blind web extractor. */
import { describe, it, expect, vi } from 'vitest'
import {
  htmlToText,
  extractOpportunitiesFromPage,
  decomposeHubApplyTargets,
} from '../services/webGrantExtractor.js'
import { OPPORTUNITY_KIND } from '../crawler-os/contract.js'

const longPage = `
<html><body><main>
  <h1>Nashville Youth Fund Grant</h1>
  <p>The Nashville Youth Fund offers grants to nonprofit organizations serving youth in Tennessee.</p>
  <p>Applications are due September 1, 2026. Awards are up to $10,000.</p>
  <p>Applicants may submit one proposal during the current funding cycle.</p>
  <a href="/apply">Apply now</a>
</main></body></html>`

describe('htmlToText', () => {
  it('strips scripts/styles/nav and collapses whitespace', () => {
    const html = '<html><head><style>.x{}</style><script>bad()</script></head><body><nav>menu</nav><main>  Real   grant   content here. </main><footer>foot</footer></body></html>'
    const text = htmlToText(html)
    expect(text).toContain('Real grant content here.')
    expect(text).not.toContain('bad()')
    expect(text).not.toContain('menu')
  })
  it('bounds length', () => {
    expect(htmlToText('<body>' + 'a'.repeat(10000) + '</body>', 500).length).toBe(500)
  })
  it('returns empty for junk', () => {
    expect(htmlToText(null)).toBe('')
  })
})

describe('extractOpportunitiesFromPage', () => {
  it('extracts page-supported facts without receiving profile or query context', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: {
        opportunities: [{
          title: 'Nashville Youth Fund Grant',
          funder: 'Nashville Youth Fund',
          summary: 'Grants for nonprofit organizations serving youth in Tennessee.',
          eligibility_text: 'nonprofit organizations serving youth in Tennessee',
          eligibility_bullets: ['nonprofit organizations serving youth in Tennessee'],
          need_categories: ['youth'],
          amount_min: null,
          amount_max: 10000,
          deadline: '2026-09-01',
          national: false,
          states: ['TN'],
          is_loan: false,
          requires_cost_share: false,
          apply_link_id: 'L1',
          info_link_id: null,
          evidence: {
            eligibility: 'nonprofit organizations serving youth in Tennessee',
            amount: 'Awards are up to $10,000',
            deadline: 'Applications are due September 1, 2026',
            national: 'serving youth in Tennessee',
            geography: 'serving youth in Tennessee',
            is_loan: '',
            requires_cost_share: '',
          },
        }],
      },
    })

    const out = await extractOpportunitiesFromPage({
      pageUrl: 'https://nyf.org/grant',
      html: longPage,
      // These are deliberately supplied by a legacy-shaped caller. The live
      // extractor ignores them and never includes them in its LLM prompt.
      thesis: { applicant_types: ['student'], location: { state: 'CA' } },
      query: 'California student grants',
    }, { invoke, openai: null })

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      title: 'Nashville Youth Fund Grant',
      sponsor: 'Nashville Youth Fund',
      applicant_types: [],
      need_categories: ['youth'],
      geography: { national: false, states: ['TN'] },
      deadline: '2026-09-01',
      apply_url: 'https://nyf.org/apply',
    })
    expect(out[0].field_provenance).toHaveProperty('eligibility')
    const call = invoke.mock.calls[0][0]
    expect(call.prompt).not.toContain('California')
    expect(call.prompt).not.toContain('student')
    expect(call.prompt).not.toContain('FOUND VIA SEARCH')
  })

  it('rejects a model-invented application URL not present in the page inventory', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: { opportunities: [{
        title: 'Nashville Youth Fund Grant',
        funder: 'Nashville Youth Fund',
        summary: 'Grant.',
        eligibility_text: null,
        eligibility_bullets: [],
        need_categories: ['youth'],
        amount_min: null,
        amount_max: null,
        deadline: null,
        national: null,
        states: [],
        is_loan: null,
        requires_cost_share: null,
        apply_url: 'https://evil.example/apply',
        info_link_id: null,
        evidence: {},
      }] },
    })
    const [out] = await extractOpportunitiesFromPage(
      { pageUrl: 'https://nyf.org/grant', html: longPage },
      { invoke, openai: null },
    )
    expect(out.apply_url).toBeNull()
    expect(out.info_url).toBe('https://nyf.org/grant')
  })

  it('classifies an index page as a directory and strips a selected child apply link', async () => {
    const indexHtml = `<body><main>
      <h1>Community Scholarship Directory</h1>
      <p>Community Scholarship Directory lists many scholarship opportunities. Browse scholarships and view all scholarships below.</p>
      ${Array.from({ length: 12 }, (_, i) => `<a href="/award-${i}">Apply for Scholarship ${i}</a>`).join('')}
    </main></body>`
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: { opportunities: [{
        title: 'Community Scholarship Directory',
        funder: 'Community Scholarship Directory',
        summary: 'A directory of scholarship opportunities.',
        eligibility_text: null,
        eligibility_bullets: [],
        need_categories: ['scholarship'],
        amount_min: null,
        amount_max: null,
        deadline: null,
        national: null,
        states: [],
        is_loan: null,
        requires_cost_share: null,
        // A directory may contain child apply links. Selecting one must not make
        // that child link the application URL of the directory record itself.
        apply_link_id: 'L1',
        info_link_id: null,
        evidence: {},
      }] },
    })
    const [out] = await extractOpportunitiesFromPage(
      { pageUrl: 'https://directory.org/scholarships', html: indexHtml },
      { invoke, openai: null },
    )
    expect(out.kind).toBe(OPPORTUNITY_KIND.DIRECTORY)
    expect(out.is_directory).toBe(true)
    expect(out.apply_url).toBeNull()
    expect(out.info_url).toBe('https://directory.org/scholarships')
    expect(out.raw.directory_child_apply_url).toBe('https://directory.org/award-0')
  })

  it('ignores navigation links while preserving a main-content form action', async () => {
    const pageHtml = `<body>
      <nav>${Array.from({ length: 16 }, (_, i) => `<a href="/nav-${i}">Apply elsewhere ${i}</a>`).join('')}</nav>
      <main>
        <h1>Nashville Youth Fund Grant</h1>
        <p>The Nashville Youth Fund offers grants to nonprofit organizations serving youth in Tennessee. Applications are due September 1, 2026. Awards are up to $10,000. Applicants may submit one proposal during the current funding cycle.</p>
        <form action="/apply" aria-label="Apply for this grant"><button type="submit">Apply now</button></form>
      </main>
    </body>`
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: { opportunities: [{
        title: 'Nashville Youth Fund Grant',
        funder: 'Nashville Youth Fund',
        summary: 'Grant.',
        eligibility_text: null,
        eligibility_bullets: [],
        need_categories: ['youth'],
        amount_min: null,
        amount_max: null,
        deadline: '2026-09-01',
        national: null,
        states: [],
        is_loan: null,
        requires_cost_share: null,
        apply_link_id: 'L1',
        info_link_id: null,
        evidence: { deadline: 'Applications are due September 1, 2026' },
      }] },
    })

    const [out] = await extractOpportunitiesFromPage(
      { pageUrl: 'https://nyf.org/grant', html: pageHtml },
      { invoke, openai: null },
    )

    expect(out.kind).toBe(OPPORTUNITY_KIND.DIRECT_GRANT)
    expect(out.apply_url).toBe('https://nyf.org/apply')
  })

  it('preserves an application link nested inside a form', async () => {
    const pageHtml = `<body><main>
      <h1>Nashville Youth Fund Grant</h1>
      <p>The Nashville Youth Fund offers grants to nonprofit organizations serving youth in Tennessee. Applications are due September 1, 2026. Awards are up to $10,000. Applicants may submit one proposal during the current funding cycle.</p>
      <form><a href="/apply">Open the application</a></form>
    </main></body>`
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: { opportunities: [{
        title: 'Nashville Youth Fund Grant', funder: 'Nashville Youth Fund', summary: 'Grant.',
        eligibility_text: null, eligibility_bullets: [], need_categories: ['youth'],
        amount_min: null, amount_max: null, deadline: '2026-09-01', national: null,
        states: [], is_loan: null, requires_cost_share: null, apply_link_id: 'L1',
        info_link_id: null, evidence: { deadline: 'Applications are due September 1, 2026' },
      }] },
    })

    const [out] = await extractOpportunitiesFromPage(
      { pageUrl: 'https://nyf.org/grant', html: pageHtml },
      { invoke, openai: null },
    )

    expect(out.kind).toBe(OPPORTUNITY_KIND.DIRECT_GRANT)
    expect(out.apply_url).toBe('https://nyf.org/apply')
  })

  it('maps a non-rolling page without a verified application target as a program', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: { opportunities: [{
        title: 'Nashville Youth Fund Grant', funder: 'Nashville Youth Fund', summary: 'Grant.',
        eligibility_text: null, eligibility_bullets: [], need_categories: ['youth'],
        amount_min: null, amount_max: null, deadline: '2026-09-01', national: null,
        states: [], is_loan: null, requires_cost_share: null, apply_link_id: null,
        info_link_id: null, evidence: { deadline: 'Applications are due September 1, 2026' },
      }] },
    })

    const [out] = await extractOpportunitiesFromPage(
      { pageUrl: 'https://nyf.org/grant', html: longPage.replace('<a href="/apply">Apply now</a>', '') },
      { invoke, openai: null },
    )

    expect(out.kind).toBe(OPPORTUNITY_KIND.PROGRAM)
    expect(out.apply_url).toBeNull()
    expect(out.info_url).toBe('https://nyf.org/grant')
  })

  it('returns [] for a too-short page without an LLM call', async () => {
    const invoke = vi.fn()
    const out = await extractOpportunitiesFromPage(
      { pageUrl: 'https://x.com', html: '<body>hi</body>' },
      { invoke, openai: null },
    )
    expect(out).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns [] when the LLM fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, json: null })
    const out = await extractOpportunitiesFromPage(
      { pageUrl: 'https://x.com', html: longPage },
      { invoke, openai: null },
    )
    expect(out).toEqual([])
  })
})

describe('decomposeHubApplyTargets — crawl-time hub decomposition (Coolidge/Live Más class, 2026-08-23)', () => {
  const HUB = 'https://oregongoestocollege.example/pay/scholarships'
  const inventory = [
    { url: HUB, text: 'Scholarships' }, // the hub's own self-link
    { url: 'https://coolidgescholars.example/apply', text: 'The Coolidge Scholarship — apply' },
    { url: 'https://taco-bell-foundation.example/live-mas', text: 'Live Más Scholarship application' },
  ]
  const award = (title, apply_url) => ({ title, apply_url, is_directory: false, info_url: null, raw: {} })

  it('a single-award page is untouched (applying ON the page is legitimate — the U.S. Bank form)', () => {
    const one = [award('The Whole Application', HUB)]
    expect(decomposeHubApplyTargets(one, { pageUrl: HUB, linkInventory: inventory })).toEqual(one)
  })

  it('on a multi-award hub, an award whose apply target is the HUB URL is DECOMPOSED to its own outbound link', () => {
    const cands = [
      award('The Coolidge Scholarship', HUB),
      award('Live Más Scholarship', HUB),
    ]
    const out = decomposeHubApplyTargets(cands, { pageUrl: HUB, linkInventory: inventory })
    expect(out[0].apply_url).toBe('https://coolidgescholars.example/apply')
    expect(out[0].raw.hub_decomposed).toBe(true)
    expect(out[1].apply_url).toBe('https://taco-bell-foundation.example/live-mas')
    expect(out[1].raw.hub_decomposed).toBe(true)
  })

  it('an award with NO matching outbound link is stripped to info-only (never a false "apply here" to the hub)', () => {
    const cands = [
      award('The Coolidge Scholarship', HUB),
      award('General Manager', HUB), // a job posting scraped off the listing — no award link
    ]
    const out = decomposeHubApplyTargets(cands, { pageUrl: HUB, linkInventory: inventory })
    // Coolidge decomposes; the job posting has no own-link → apply nulled, info = hub.
    expect(out[0].apply_url).toBe('https://coolidgescholars.example/apply')
    expect(out[1].apply_url).toBeNull()
    expect(out[1].info_url).toBe(HUB)
    expect(out[1].raw.hub_apply_url_stripped).toBe(true)
  })

  it('a real per-award outbound link (not the hub) is kept as-is', () => {
    const cands = [
      award('The Coolidge Scholarship', 'https://coolidgescholars.example/apply'),
      award('Live Más Scholarship', HUB),
    ]
    const out = decomposeHubApplyTargets(cands, { pageUrl: HUB, linkInventory: inventory })
    expect(out[0].apply_url).toBe('https://coolidgescholars.example/apply')
    expect(out[0].raw.hub_decomposed).toBeUndefined() // untouched — already a real link
  })

  it('directory rows are never touched', () => {
    const cands = [
      { ...award('A', HUB), is_directory: true },
      { ...award('B', HUB), is_directory: true },
    ]
    const out = decomposeHubApplyTargets(cands, { pageUrl: HUB, linkInventory: inventory })
    expect(out).toEqual(cands)
  })
})
