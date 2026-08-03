import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import triageModule, {
  triagePage,
  awardShapedLinks,
  countAwardPhrases,
  PAGE_SURFACES,
  MIN_AWARD_PHRASES_WITH_URL,
} from '../services/hamilton/listingPageTriage.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Real (trimmed) MTSU NGWeb /Scholarships/Search snapshot: title "Scholarships
// Search", 5 nav-only anchors, hundreds of award TEXT rows (no per-item links).
const ngweb = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'ngwebScholarshipsCatalog.json'), 'utf8'),
)

describe('listingPageTriage', () => {
  describe('awardShapedLinks', () => {
    it('keeps award-named and dollar-value links, drops nav chrome', () => {
      const links = [
        { href: 'https://bold.org/', text: 'Home' },
        { href: 'https://bold.org/scholarships/housing-scholarship', text: 'Housing Security Scholarship' },
        { href: 'https://bold.org/scholarships/first-gen-fellowship', text: 'First-Generation Fellowship' },
        { href: 'https://bold.org/browse', text: 'Browse' },
        { href: 'https://bold.org/scholarships/be-bold', text: '$25,000 Be Bold Award' },
        { href: 'not-a-url', text: 'Broken Scholarship Link' },
        { href: 'https://bold.org/x', text: 'Grants' }, // too-short category nav
      ]
      const kept = awardShapedLinks(links)
      expect(kept.map((l) => l.text)).toEqual([
        'Housing Security Scholarship',
        'First-Generation Fellowship',
        '$25,000 Be Bold Award',
      ])
    })

    it('dedupes by href and tolerates junk input', () => {
      expect(awardShapedLinks(null)).toEqual([])
      const dup = [
        { href: 'https://x.org/a-scholarship', text: 'A Nursing Scholarship' },
        { href: 'https://x.org/a-scholarship', text: 'A Nursing Scholarship' },
      ]
      expect(awardShapedLinks(dup)).toHaveLength(1)
    })
  })

  describe('countAwardPhrases', () => {
    it('counts award nouns in the real NGWeb catalog slice above threshold', () => {
      expect(countAwardPhrases(ngweb.text)).toBeGreaterThanOrEqual(MIN_AWARD_PHRASES_WITH_URL)
    })
    it('is near-zero on an ordinary info page', () => {
      expect(countAwardPhrases('Find your local Community Action Agency by ZIP code.')).toBe(0)
    })
  })

  describe('triagePage — FORM (never reclassify a real form)', () => {
    it('classifies FORM when the engine actually saw fillable fields', () => {
      const r = triagePage({
        url: 'https://apply.example.org/step-2',
        title: 'Application — Step 2 of 4',
        fieldCount: 5,
        links: [],
        text: 'Personal statement',
      })
      expect(r.surface).toBe(PAGE_SURFACES.FORM)
    })
  })

  describe('triagePage — LISTING (real award pages)', () => {
    it('classifies a bold.org-style category page by award-link density', () => {
      const links = Array.from({ length: 6 }, (_, i) => ({
        href: `https://bold.org/scholarships/housing-award-${i}`,
        text: `Housing Security Scholarship ${i}`,
      }))
      const r = triagePage({
        url: 'https://bold.org/scholarships/category/housing',
        title: 'Housing Scholarships',
        fieldCount: 1,
        links,
        text: '',
      })
      expect(r.surface).toBe(PAGE_SURFACES.LISTING)
      expect(r.award_links.length).toBeGreaterThanOrEqual(5)
    })

    it('classifies the real NGWeb catalog by award-TEXT density despite only 5 nav links', () => {
      const r = triagePage({
        url: ngweb.landed,
        title: ngweb.title,
        fieldCount: 2, // a keyword search box + a category filter
        links: ngweb.links,
        text: ngweb.text,
      })
      expect(r.surface).toBe(PAGE_SURFACES.LISTING)
      // The catalog's anchors are all nav chrome → no per-item award links.
      expect(r.award_links).toEqual([])
      expect(r.signals.some((s) => s.startsWith('award_phrases:'))).toBe(true)
    })

    it('classifies a listing-shaped URL with only 2 award links (corroborated)', () => {
      const r = triagePage({
        url: 'https://www.fastweb.com/college-scholarships/search?keyword=nursing',
        title: 'Scholarship Search Results',
        fieldCount: 0,
        links: [
          { href: 'https://www.scholarships.com/a', text: 'AACN Nursing Scholarship' },
          { href: 'https://www.scholarships.com/b', text: 'Tylenol Future Care Scholarship' },
        ],
        text: '',
      })
      expect(r.surface).toBe(PAGE_SURFACES.LISTING)
    })
  })

  describe('triagePage — NO_APPLICATION_SURFACE (honest dead-end)', () => {
    it('classifies a finder page with no awards and no listing shape', () => {
      const r = triagePage({
        url: 'https://communityactionpartnership.com/find-a-cap/',
        title: 'Find a Community Action Agency',
        fieldCount: 1, // a ZIP lookup box
        links: [
          { href: 'https://communityactionpartnership.com/about', text: 'About Us' },
          { href: 'https://communityactionpartnership.com/contact', text: 'Contact' },
        ],
        text: 'Enter your ZIP code to find your local Community Action Agency.',
      })
      expect(r.surface).toBe(PAGE_SURFACES.NO_APPLICATION_SURFACE)
    })

    it('does NOT let text density alone (no listing URL/title) force LISTING', () => {
      // A long blog post that merely discusses scholarships is not a listing.
      const proseWithManyMentions = 'scholarship '.repeat(60)
      const r = triagePage({
        url: 'https://blog.example.org/how-to-win-a-scholarship',
        title: 'How To Win A Scholarship: A Guide',
        fieldCount: 0,
        links: [],
        text: proseWithManyMentions,
      })
      expect(r.surface).toBe(PAGE_SURFACES.NO_APPLICATION_SURFACE)
    })
  })

  it('default export carries the public surface API', () => {
    expect(triageModule.PAGE_SURFACES).toBe(PAGE_SURFACES)
    expect(typeof triageModule.triagePage).toBe('function')
  })
})
