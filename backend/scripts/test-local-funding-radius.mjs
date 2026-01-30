import { crawlLocalFunding } from '../services/crawlers/localFundingCrawler.js'

// Minimal smoke-test for:
// - 50-mile anchor radius logic (profile ZIP + interested-school ZIPs)
// - Directory resources are emitted per anchor (bounded)
//
// Run:
//   node backend/scripts/test-local-funding-radius.mjs

const profile = {
  zip_code: '37209',
  state: 'TN',
  city: 'Nashville',
  // Signals are required by the crawler (must exist).
  signals: {
    location: { zip: '37209', state: 'TN', city: 'Nashville' },
    keywordSet: new Set(['student', 'scholarship', 'local', 'community']),
    interests: new Set(['nursing', 'healthcare']),
    demographics: new Set(['first_generation']),
    applicantTypes: new Set(['student']),
  },
  // Interested school ZIP is stored in university_applications (schema allows arbitrary object fields).
  sections: {
    university_applications: {
      applications: [
        {
          name: 'Example University',
          school_zip: '37916', // Knoxville
        },
      ],
    },
  },
}

const results = await crawlLocalFunding(profile, { min_match_score: 50 })

console.log('[test-local-funding-radius] results:', results.length)
console.log(
  '[test-local-funding-radius] anchors in results:',
  Array.from(
    new Set(
      results
        .map((r) => r?.distance_anchor_zip || r?.local_anchor_zip || null)
        .filter(Boolean),
    ),
  ),
)
console.log(
  '[test-local-funding-radius] sample:',
  results.slice(0, 8).map((r) => ({
    title: r.title,
    local_anchor_zip: r.local_anchor_zip ?? null,
    local_anchor_kind: r.local_anchor_kind ?? null,
    distance_anchor_zip: r.distance_anchor_zip ?? null,
    distance_miles: r.distance_miles ?? null,
  })),
)

