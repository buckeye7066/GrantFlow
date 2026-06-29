/**
 * Unit tests for backend/services/webGrantExtractor.js
 */
import { describe, it, expect, vi } from 'vitest'
import { htmlToText, extractOpportunitiesFromPage } from '../services/webGrantExtractor.js'

const thesis = { applicant_types: ['nonprofit'], needs: ['youth'], location: { state: 'TN' }, is_org: true, loan_allowed: false }

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
  const longPage = '<body>' + 'The Nashville Youth Fund offers grants to nonprofits serving youth in Tennessee. '.repeat(20) + '</body>'

  it('returns relevant extracted opportunities', async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      json: { opportunities: [
        { title: 'Nashville Youth Fund Grant', funder: 'Nashville Youth Fund', summary: 'Grants for youth nonprofits', deadline: '2026-09-01', apply_url: 'https://nyf.org/apply', relevant: true, state: 'TN' },
        { title: 'Closed Program', funder: 'X', relevant: false },
        { title: '', funder: 'NoTitle', relevant: true },
      ] },
    })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://nyf.org', html: longPage, thesis, query: 'youth grants TN' }, { invoke, openai: null })
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Nashville Youth Fund Grant')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('returns [] for a too-short page (no LLM call)', async () => {
    const invoke = vi.fn()
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://x.com', html: '<body>hi</body>', thesis }, { invoke, openai: null })
    expect(out).toEqual([])
    expect(invoke).not.toHaveBeenCalled()
  })

  it('returns [] when the LLM fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: false, json: null })
    const out = await extractOpportunitiesFromPage({ pageUrl: 'https://x.com', html: longPage, thesis }, { invoke, openai: null })
    expect(out).toEqual([])
  })
})
