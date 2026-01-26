/**
 * Lightweight verification:
 * - runs the local_funding live crawler pipeline with a synthetic profileContext
 * - asserts total_found > 0 and count > 0
 * - asserts we include directory-style resources (record_origin includes "directory" or opportunity_type === "program")
 *
 * Run:
 *   node scripts/verify-discover-grants-local-funding.mjs
 */
import { crawlLocalFunding } from '../backend/services/crawlers/localFundingCrawler.js'
import { calculateMatchScore } from '../backend/services/matchingEngine.js'

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

function mergeReasons(a, b) {
  const out = []
  const seen = new Set()
  for (const src of [a, b]) {
    if (!Array.isArray(src)) continue
    for (const r of src) {
      const s = typeof r === 'string' ? r.trim() : ''
      if (!s) continue
      const key = s.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

function isDirectoryResource(row) {
  const origin = normalizeString(row?.record_origin || '')
  const oppType = normalizeString(row?.opportunity_type || '')
  return oppType === 'program' || origin.includes('directory') || Boolean(row?.is_directory_resource)
}

async function main() {
  const minMatchScore = 50

  const profile = {
    id: 'synthetic-profile',
    display_name: 'Synthetic Profile',
    state: 'OH',
    sections: {
      basic_information: { email: 'synthetic@example.com' },
    },
    // localFundingCrawler requires `profile.signals`
    signals: {
      location: { zip: '43215', city: 'Columbus', state: 'OH' },
      keywordSet: new Set(['disability', 'housing', 'utilities', 'food assistance', 'community']),
      phrases: ['emergency assistance', 'support services'],
      interests: new Set(['housing', 'community', 'health']),
      demographics: new Set(['disabled']),
      coverage: { pct: 1 },
    },
  }

  const raw = await crawlLocalFunding(profile, { min_match_score: minMatchScore })
  const normalized = Array.isArray(raw) ? raw : []

  // mimic realCrawlers live pipeline behavior: preserve existing score, compute score, directory resources always survive
  const rescored = normalized.map((row) => {
    const { score: computedScore, reasons: computedReasons } = calculateMatchScore(
      { profile, sections: profile.sections, signals: profile.signals },
      row,
    )
    const existingScore = typeof row?.match_score === 'number' ? row.match_score : null
    const mergedScore = existingScore === null ? computedScore : Math.max(existingScore, computedScore)
    const mergedReasons = mergeReasons(row?.match_reasons, computedReasons)
    const finalScore = isDirectoryResource(row) ? Math.max(minMatchScore, mergedScore) : mergedScore
    return { ...row, match_score: finalScore, match_reasons: mergedReasons }
  })

  const total_found = rescored.length
  const included = rescored.filter((row) => isDirectoryResource(row) || (typeof row.match_score === 'number' && row.match_score >= minMatchScore))
  const count = included.length
  const directoryCount = included.filter(isDirectoryResource).length

  if (!(total_found > 0)) {
    throw new Error(`Expected total_found > 0, got ${total_found}`)
  }
  if (!(count > 0)) {
    throw new Error(`Expected count > 0, got ${count} (total_found=${total_found})`)
  }
  if (!(directoryCount > 0)) {
    throw new Error(`Expected directory resources included, got directoryCount=${directoryCount}`)
  }

  console.log('[verify] ok', {
    total_found,
    count,
    directoryCount,
    sample: included.slice(0, 3).map((o) => ({
      title: o.title,
      score: o.match_score,
      opportunity_type: o.opportunity_type,
      record_origin: o.record_origin,
    })),
  })
}

main().catch((err) => {
  console.error('[verify] failed', err?.message || err)
  process.exitCode = 1
})

