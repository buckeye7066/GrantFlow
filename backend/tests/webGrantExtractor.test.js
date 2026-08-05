/** Unit tests for the live profile-blind web extractor. */
import { describe, it, expect, vi } from 'vitest'
import {
  htmlToText,
  extractOpportunitiesFromPage,
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

  it('classifies an index page as a directory rather than direct funding', async () => {
    const indexHtml = `<body><main>
      <h1>Community Scholarship Directory</h1>
      <p>Community Scholarship Directory lists many scholarship opportunities. Browse scholarships and view all scholarships below.</p>
      ${Array.from({ length: 12 }, (_, i) => `<a href="/award-${i}">Scholarship ${i}</a>`).join('')}
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
        apply_link_id: null,
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
