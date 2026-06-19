/**
 * ecf-benefits-crawler-live.test.mjs
 *
 * Regression for: ECF crawler returning ONLY a hand-coded curated
 * catalog with `import axios from 'axios'` and `import * as cheerio
 * from 'cheerio'` lying unused at the top of the file. The TODO
 * comments said "supplement with live scraping" — this test pins down
 * that the live-scraping layer is now real, additive, and never
 * removes a curated entry.
 *
 * Mission rules tested:
 *   - "Real funding only" (Goal #1): live-discovered candidates are
 *     extracted from the actual source HTML, not fabricated.
 *   - "Avoid zero results" (Goal #8): curated catalog is the
 *     guaranteed floor — a network failure must NOT zero out output.
 *   - "Profile attributes should: Increase score, not eliminate
 *     results": live discovery does not filter on profile fields.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  crawlECFBenefits,
  discoverLiveBenefits,
} from '../../backend/services/crawlers/ecfBenefitsCrawler.js'

const TN_PARTICIPANT_PROFILE = {
  state: 'TN',
  ecf_participant: true,
  sections: {
    government_assistance: {
      ecf_choices_role: 'participant',
      medicaid_enrolled: true,
    },
    health_medical: {
      disability_type: ['intellectual'],
    },
  },
  signals: {
    location: { state: 'TN' },
    keywordSet: new Set(['ecf']),
  },
}

const TN_PROVIDER_PROFILE = {
  state: 'TN',
  is_provider: true,
  organization_type: 'cls_fm',
  sections: {
    government_assistance: { ecf_choices_role: 'provider' },
    organization_details: { organization_type: 'cls_fm' },
  },
  signals: {
    location: { state: 'TN' },
    keywordSet: new Set(['ecf', 'cls-fm']),
  },
}

function htmlWithLinks(...links) {
  const anchors = links
    .map(([href, text]) => `<a href="${href}">${text}</a>`)
    .join('\n')
  return `<!doctype html><html><body><nav><a href="/about">About</a></nav>${anchors}</body></html>`
}

test('discoverLiveBenefits extracts program-keyword anchors and resolves relative URLs', async () => {
  const fetchImpl = async () =>
    htmlWithLinks(
      ['/programs/family-respite-support', 'Family Respite Support Program'],
      ['/grants/community-living-grant', 'Community Living Grant Application'],
      ['/about', 'About TennCare'],
      ['/contact', 'Contact Us'],
      ['https://example.com/external/scholarship', 'Disability Scholarship'],
    )

  const out = await discoverLiveBenefits(
    { name: 'Test', baseUrl: 'https://www.tn.gov/test', type: 'state_program' },
    null,
    { fetchImpl },
  )

  // Expect 3 program-keyword matches, /about and /contact are blocklisted.
  assert.equal(out.length, 3)
  const titles = out.map((c) => c.title)
  assert.ok(titles.includes('Family Respite Support Program'))
  assert.ok(titles.includes('Community Living Grant Application'))
  assert.ok(titles.includes('Disability Scholarship'))
  // Relative URL resolved to absolute.
  const respite = out.find((c) => c.title === 'Family Respite Support Program')
  assert.equal(respite.url, 'https://www.tn.gov/programs/family-respite-support')
  // No fabricated amounts.
  assert.equal(respite.amount_min, null)
  assert.equal(respite.amount_max, null)
})

test('discoverLiveBenefits returns [] on fetch failure (does not throw)', async () => {
  const fetchImpl = async () => null
  const out = await discoverLiveBenefits(
    { name: 'Test', baseUrl: 'https://www.tn.gov/test', type: 'state_program' },
    null,
    { fetchImpl },
  )
  assert.deepEqual(out, [])
})

test('discoverLiveBenefits dedupes by absolute URL + anchor text', async () => {
  const fetchImpl = async () =>
    htmlWithLinks(
      ['/programs/x', 'Scholarship Program'],
      ['/programs/x', 'Scholarship Program'], // exact duplicate
      ['/programs/x?utm=foo', 'Scholarship Program'], // same title, diff URL — drops as title dupe
    )
  const out = await discoverLiveBenefits(
    { name: 'Test', baseUrl: 'https://www.tn.gov/x', type: 'state_program' },
    null,
    { fetchImpl },
  )
  assert.equal(out.length, 1)
})

test('crawlECFBenefits: curated catalog is the FLOOR even when live fetch fails', async () => {
  // Network unreachable — every live fetch returns null.
  const fetchImpl = async () => null
  const results = await crawlECFBenefits(TN_PARTICIPANT_PROFILE, { fetchImpl })

  // Mission rule: "Zero results is a failure state, not an acceptable outcome."
  assert.ok(results.length > 0, 'curated floor must produce results when live fails')

  // Every result here came from the curated catalog.
  const origins = new Set(results.map((r) => r.record_origin))
  assert.ok(origins.has('curated_static'))
  assert.ok(!origins.has('live_scraped'))

  // Sanity: includes ECF CHOICES Essential Supports.
  const titles = results.map((r) => r.title)
  assert.ok(titles.some((t) => /ECF CHOICES/i.test(t)))
})

test('crawlECFBenefits: live-discovered candidates are merged additively when fetch succeeds', async () => {
  let fetchedUrls = []
  const fetchImpl = async (url) => {
    fetchedUrls.push(url)
    return htmlWithLinks(
      ['/programs/special-respite-grant', 'Special Respite Grant'],
      ['/programs/job-training-program', 'Job Training Program'],
    )
  }

  const results = await crawlECFBenefits(TN_PARTICIPANT_PROFILE, { fetchImpl })

  const liveResults = results.filter((r) => r.record_origin === 'live_scraped')
  const curatedResults = results.filter((r) => r.record_origin === 'curated_static')

  assert.ok(curatedResults.length > 0, 'curated entries must always survive')
  assert.ok(liveResults.length > 0, 'live-scraped entries must be added')
  assert.ok(fetchedUrls.length > 0, 'fetchImpl must be called for at least one source')
})

test('crawlECFBenefits: live discovery does NOT remove curated entries even when titles collide', async () => {
  // Live source returns a title that EXACTLY collides with a curated entry.
  // The curated entry must win (it has richer metadata: amount, eligibility).
  const fetchImpl = async () =>
    htmlWithLinks(
      ['/duplicate', 'ECF CHOICES Essential Supports'],
      ['/new-program', 'New Program Grant'],
    )

  const results = await crawlECFBenefits(TN_PARTICIPANT_PROFILE, { fetchImpl })

  const collidingTitle = results.filter(
    (r) => r.title === 'ECF CHOICES Essential Supports',
  )
  assert.equal(collidingTitle.length, 1)
  assert.equal(collidingTitle[0].record_origin, 'curated_static')
  assert.equal(collidingTitle[0].amount_max, 50000) // curated metadata preserved
})

test('crawlECFBenefits: provider profile receives family_support stream live-merged', async () => {
  const fetchImpl = async () =>
    htmlWithLinks(['/programs/provider-startup-grant', 'Provider Startup Grant'])

  const results = await crawlECFBenefits(TN_PROVIDER_PROFILE, { fetchImpl })
  const familyResults = results.filter((r) => r.benefit_type === 'family_support')
  assert.ok(familyResults.length > 0, 'provider profile must get family_support stream')
})

test('crawlECFBenefits: enableLiveDiscovery=false returns curated only', async () => {
  let fetchCalled = false
  const fetchImpl = async () => {
    fetchCalled = true
    return htmlWithLinks(['/x', 'Some Grant'])
  }
  const results = await crawlECFBenefits(TN_PARTICIPANT_PROFILE, {
    fetchImpl,
    enableLiveDiscovery: false,
  })
  assert.equal(fetchCalled, false)
  assert.ok(results.every((r) => r.record_origin === 'curated_static'))
})
