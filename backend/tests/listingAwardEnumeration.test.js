import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractListingAwardItems, _internal } from '../services/hamilton/portalSync/llmPageExtract.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ngweb = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ngwebScholarshipsCatalog.json'), 'utf8'),
)

// A fake invoker returning a fixed JSON payload — the deterministic fabrication
// guard is what we exercise, not the model.
const fakeInvoke = (json) => async () => ({ ok: true, json, provider: 'test' })
const fixture = (invoke, extra = {}) => ({ _syntheticFixture: true, _invoke: invoke, ...extra })

describe('extractListingAwardItems (listing enumeration + fabrication guard)', () => {
  it('keeps items whose titles are present in the real NGWeb catalog text', async () => {
    // These names are verbatim from the trimmed real fixture.
    const present = ngweb.text.match(/Aaron & Clara Todd[^\n]*/)?.[0]?.trim()
    expect(present).toBeTruthy()
    const r = await extractListingAwardItems(
      { text: ngweb.text, url: ngweb.landed, title: ngweb.title, links: ngweb.links },
      fixture(fakeInvoke({ items: [
        { title: present, amount: 1000, sponsor: 'MTSU', deadline: null, applyUrl: null, evidence: present },
      ] })),
    )
    expect(r.items).toHaveLength(1)
    expect(r.items[0].title).toContain('Aaron')
    // NGWeb rows carry no per-item link → catalog-only (applyUrl null).
    expect(r.items[0].applyUrl).toBeNull()
    expect(r.rejected).toHaveLength(0)
  })

  it('REJECTS an enumerated award whose title is not on the page (fabrication)', async () => {
    const r = await extractListingAwardItems(
      { text: ngweb.text, url: ngweb.landed, title: ngweb.title, links: ngweb.links },
      fixture(fakeInvoke({ items: [
        { title: 'Totally Invented Moon Colony Scholarship', amount: 999999, applyUrl: null, evidence: 'nope' },
      ] })),
    )
    expect(r.items).toHaveLength(0)
    expect(r.rejected[0].reason).toMatch(/title_not_on_page/)
  })

  it('drops a fabricated applyUrl but keeps the item as catalog-only', async () => {
    const title = 'Housing Security Scholarship'
    const r = await extractListingAwardItems(
      {
        text: `Apply for the ${title} today. Award: $2,000.`,
        url: 'https://bold.org/scholarships/category/housing',
        title: 'Housing Scholarships',
        links: [{ href: 'https://bold.org/scholarships/housing', text: 'Housing Security Scholarship' }],
      },
      fixture(fakeInvoke({ items: [
        { title, amount: 2000, applyUrl: 'https://evil.example/phish', evidence: `the ${title}` },
      ] })),
    )
    expect(r.items).toHaveLength(1)
    expect(r.items[0].applyUrl).toBeNull()
    expect(r.rejected[0].reason).toMatch(/apply_url_not_on_page/)
  })

  it('keeps a real applyUrl that is one of the page links', async () => {
    const title = 'First-Generation Fellowship'
    const href = 'https://bold.org/scholarships/first-gen'
    const r = await extractListingAwardItems(
      {
        text: `The ${title} supports first-gen students. Deadline June 1.`,
        url: 'https://bold.org/scholarships/category/first-gen',
        title: 'First-Gen Scholarships',
        links: [{ href, text: 'First-Generation Fellowship' }],
      },
      fixture(fakeInvoke({ items: [
        { title, amount: null, deadline: 'June 1', applyUrl: href, evidence: `The ${title}` },
      ] })),
    )
    expect(r.items[0].applyUrl).toBe(href)
    expect(r.items[0].deadline).toBe('June 1')
  })

  it('dedupes repeated titles and enforces maxItems', async () => {
    const r = await extractListingAwardItems(
      { text: 'Alpha Scholarship. Beta Scholarship. Gamma Scholarship.', url: 'https://x.org/list?q=a', links: [] },
      fixture(fakeInvoke({ items: [
        { title: 'Alpha Scholarship', applyUrl: null, evidence: 'Alpha Scholarship' },
        { title: 'Alpha Scholarship', applyUrl: null, evidence: 'Alpha Scholarship' },
        { title: 'Beta Scholarship', applyUrl: null, evidence: 'Beta Scholarship' },
        { title: 'Gamma Scholarship', applyUrl: null, evidence: 'Gamma Scholarship' },
      ] }), {
        maxItems: 2,
      }),
    )
    expect(r.items.map((i) => i.title)).toEqual(['Alpha Scholarship', 'Beta Scholarship'])
  })

  it('never throws and reports honestly when the model returns no JSON', async () => {
    const r = await extractListingAwardItems(
      { text: 'some text', url: 'https://x.org/search' },
      fixture(async () => ({ ok: false, json: null, error: 'boom' })),
    )
    expect(r.items).toEqual([])
    expect(r.notFound[0]).toMatch(/no parseable JSON/)
  })

  it('titlePresentInText tolerates punctuation/truncation', () => {
    const norm = _internal.normForPresence('the aaron  clara todd pre professional scholarship fund')
    expect(_internal.titlePresentInText('Aaron & Clara Todd Pre-Professional', norm)).toBe(true)
    expect(_internal.titlePresentInText('Nonexistent Award', norm)).toBe(false)
  })
})
