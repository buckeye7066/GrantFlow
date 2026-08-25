import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractListingAwardItems, _internal } from '../services/hamilton/portalSync/llmPageExtract.js'
import { sanitizeListingSnapshotForPersistence } from '../services/hamilton/hamiltonAutopilotEngine.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ngweb = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ngwebScholarshipsCatalog.json'), 'utf8'),
)

// A fake invoker returning a fixed JSON payload — the deterministic fabrication
// guard is what we exercise, not the model.
const fakeInvoke = (json) => async () => ({ ok: true, json, provider: 'test' })

describe('extractListingAwardItems (listing enumeration + fabrication guard)', () => {
  it('persists only a value-free listing summary after in-memory decomposition', () => {
    const safe = sanitizeListingSnapshotForPersistence({
      url: 'https://portal.example.org/awards?session=bearer-secret',
      title: 'Welcome Taylor — account 12345',
      text: 'Private balance $4,200 and applicant Taylor',
      fieldCount: 2,
      links: [{ href: 'https://portal.example.org/apply?token=secret', text: 'Apply' }],
    })
    expect(safe).toMatchObject({
      portal_origin: 'https://portal.example.org',
      field_count: 2,
      link_count: 1,
      content_retained: false,
    })
    expect(JSON.stringify(safe)).not.toMatch(/Taylor|4,200|bearer-secret|token=secret/)
    expect(safe.text_sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('keeps items whose titles are present in the real NGWeb catalog text', async () => {
    // These names are verbatim from the trimmed real fixture.
    const present = ngweb.text.match(/Aaron & Clara Todd[^\n]*/)?.[0]?.trim()
    expect(present).toBeTruthy()
    const r = await extractListingAwardItems(
      { text: ngweb.text, url: ngweb.landed, title: ngweb.title, links: ngweb.links },
      { _invoke: fakeInvoke({ items: [
        { title: present, amount: 1000, sponsor: 'MTSU', deadline: null, applyUrl: null, evidence: present },
      ] }) },
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
      { _invoke: fakeInvoke({ items: [
        { title: 'Totally Invented Moon Colony Scholarship', amount: 999999, applyUrl: null, evidence: 'nope' },
      ] }) },
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
      { _invoke: fakeInvoke({ items: [
        { title, amount: 2000, applyUrl: 'https://evil.example/phish', evidence: `the ${title}` },
      ] }) },
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
      { _invoke: fakeInvoke({ items: [
        { title, amount: null, deadline: 'June 1', applyUrl: href, evidence: `The ${title}` },
      ] }) },
    )
    expect(r.items[0].applyUrl).toBe(href)
    expect(r.items[0].deadline).toBe('June 1')
  })

  it('dedupes repeated titles and enforces maxItems', async () => {
    const r = await extractListingAwardItems(
      { text: 'Alpha Scholarship. Beta Scholarship. Gamma Scholarship.', url: 'https://x.org/list?q=a', links: [] },
      {
        maxItems: 2,
        _invoke: fakeInvoke({ items: [
          { title: 'Alpha Scholarship', applyUrl: null, evidence: 'Alpha Scholarship' },
          { title: 'Alpha Scholarship', applyUrl: null, evidence: 'Alpha Scholarship' },
          { title: 'Beta Scholarship', applyUrl: null, evidence: 'Beta Scholarship' },
          { title: 'Gamma Scholarship', applyUrl: null, evidence: 'Gamma Scholarship' },
        ] }),
      },
    )
    expect(r.items.map((i) => i.title)).toEqual(['Alpha Scholarship', 'Beta Scholarship'])
  })

  it('never throws and reports honestly when the model returns no JSON', async () => {
    const r = await extractListingAwardItems(
      { text: 'some text', url: 'https://x.org/search' },
      { _invoke: async () => ({ ok: false, json: null, error: 'boom' }) },
    )
    expect(r.items).toEqual([])
    expect(r.notFound[0]).toMatch(/no parseable JSON/)
  })

  it('captures an in-SPA Apply BUTTON as a per-award applyMarker (bold.org gap 1)', async () => {
    // A bold.org Apply control is a <button>, not an <a href>, so it can never be
    // an applyUrl. The page supplies its own per-award apply CONTROLS; the
    // enumerator attaches the marker to the matching award (fabrication-guarded:
    // the marker must be one of the page's own controls, matched by title).
    const title = 'STEM Excellence Scholarship'
    const r = await extractListingAwardItems(
      {
        text: `Apply now for the ${title}. Award $5,000.`,
        url: 'https://bold.org/dashboard/scholarships',
        title: 'Your matched scholarships',
        links: [],
        applyControls: [{ marker: 'hamilton-apply-0', title, text: 'Apply Now' }],
      },
      { _invoke: fakeInvoke({ items: [
        { title, amount: 5000, applyUrl: null, evidence: `the ${title}` },
      ] }) },
    )
    expect(r.items).toHaveLength(1)
    expect(r.items[0].applyUrl).toBeNull()
    expect(r.items[0].applyMarker).toBe('hamilton-apply-0')
  })

  it('never invents an applyMarker for a title with no matching page control', async () => {
    const r = await extractListingAwardItems(
      {
        text: 'The Alpha Scholarship supports students. The Beta Scholarship too.',
        url: 'https://bold.org/dashboard/scholarships',
        applyControls: [{ marker: 'hamilton-apply-0', title: 'Alpha Scholarship', text: 'Apply' }],
      },
      { _invoke: fakeInvoke({ items: [
        { title: 'Alpha Scholarship', applyUrl: null, evidence: 'The Alpha Scholarship' },
        { title: 'Beta Scholarship', applyUrl: null, evidence: 'The Beta Scholarship' },
      ] }) },
    )
    const alpha = r.items.find((i) => i.title === 'Alpha Scholarship')
    const beta = r.items.find((i) => i.title === 'Beta Scholarship')
    expect(alpha.applyMarker).toBe('hamilton-apply-0') // control title matches
    expect(beta.applyMarker).toBeNull() // no control for Beta → never fabricated
  })

  it('titlePresentInText tolerates punctuation/truncation', () => {
    const norm = _internal.normForPresence('the aaron  clara todd pre professional scholarship fund')
    expect(_internal.titlePresentInText('Aaron & Clara Todd Pre-Professional', norm)).toBe(true)
    expect(_internal.titlePresentInText('Nonexistent Award', norm)).toBe(false)
  })
})
