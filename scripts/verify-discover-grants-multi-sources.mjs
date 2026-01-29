/**
 * Verification script:
 * - Runs multiple Discover Grants crawlers with a synthetic (but realistic) profileContext
 * - Asserts we return multiple funding sources (multiple crawler_type values)
 * - Asserts total_found > 0 and included count > 0
 * - Asserts directory-style resources survive filtering
 *
 * Run:
 *   node scripts/verify-discover-grants-multi-sources.mjs
 */
import { crawlLocalFunding } from '../backend/services/crawlers/localFundingCrawler.js'
import { crawlHealthResources } from '../backend/services/crawlers/healthResourcesCrawler.js'

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function isDirectoryResource(row) {
  const origin = normalizeString(row?.record_origin || '')
  const oppType = normalizeString(row?.opportunity_type || '')
  const type = normalizeString(row?.type || '')
  return (
    type === 'directory' ||
    oppType === 'program' ||
    oppType === 'directory' ||
    origin.includes('directory') ||
    Boolean(row?.is_directory_resource)
  )
}

function summarize(items) {
  const byCrawler = new Map()
  for (const it of items) {
    const k = String(it?.crawler_type || 'unknown')
    byCrawler.set(k, (byCrawler.get(k) || 0) + 1)
  }
  return Object.fromEntries([...byCrawler.entries()].sort((a, b) => b[1] - a[1]))
}

async function main() {
  const minMatchScore = 50

  // Synthetic profileContext with real-ish signals and sections.
  const profile = {
    id: 'synthetic-profile',
    display_name: 'Synthetic Profile',
    state: 'OH',
    sections: {
      basic_information: { email: 'synthetic@example.com' },
      health_medical: {
        conditions: ['epilepsy', 'brain injury'],
        consent_for_studies: false,
      },
    },
    signals: {
      location: { zip: '43215', city: 'Columbus', state: 'OH' },
      keywordSet: new Set(['disability', 'housing', 'utilities', 'food assistance', 'community']),
      phrases: ['emergency assistance', 'support services'],
      interests: new Set(['housing', 'community', 'health']),
      demographics: new Set(['disabled']),
      health: new Set(['epilepsy', 'brain injury']),
      assistance: new Set(['medicaid']),
      coverage: { pct: 1 },
    },
  }

  const [localFunding, healthResources] = await Promise.all([
    crawlLocalFunding(profile, { min_match_score: minMatchScore }),
    crawlHealthResources(profile, { min_match_score: minMatchScore }),
  ])

  const raw = [...(Array.isArray(localFunding) ? localFunding : []), ...(Array.isArray(healthResources) ? healthResources : [])]
  const total_found = raw.length
  const included = raw.filter((row) => isDirectoryResource(row) || (typeof row?.match_score === 'number' && row.match_score >= minMatchScore))
  const count = included.length
  const directoryCount = included.filter(isDirectoryResource).length

  const uniqueCrawlerTypes = new Set(
    included
      .map((r) => String(r?.crawler_type || '').trim())
      .filter((v) => v && v !== 'unknown'),
  )

  if (!(total_found > 0)) {
    throw new Error(`Expected total_found > 0, got ${total_found}`)
  }
  if (!(count > 0)) {
    throw new Error(`Expected included count > 0, got ${count} (total_found=${total_found})`)
  }
  if (!(directoryCount > 0)) {
    throw new Error(`Expected directory resources included, got directoryCount=${directoryCount}`)
  }
  if (!(uniqueCrawlerTypes.size >= 2)) {
    throw new Error(`Expected >=2 crawler_type values, got ${[...uniqueCrawlerTypes].join(', ') || '(none)'}`)
  }

  console.log('[verify] ok', {
    total_found,
    count,
    directoryCount,
    byCrawlerType: summarize(included),
    sample: included.slice(0, 6).map((o) => ({
      title: o.title,
      crawler_type: o.crawler_type,
      source: o.source,
      opportunity_type: o.opportunity_type,
      type: o.type,
      record_origin: o.record_origin,
      score: o.match_score,
      url: o.url,
    })),
  })
}

main().catch((err) => {
  console.error('[verify] failed', err?.message || err)
  process.exitCode = 1
})

