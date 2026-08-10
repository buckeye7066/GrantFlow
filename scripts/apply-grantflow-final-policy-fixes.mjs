import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Missing source block for ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected one source block for ${label}`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

{
  const file = 'backend/services/greenHomeNoCostPolicy.js'
  let source = fs.readFileSync(file, 'utf8')

  source = replaceOnce(
    source,
    `function hasCompleteContentReview(result = {}) {
  const review = contentReviewMetadata(result)
  return Boolean(review.reviewed_at && review.reviewed_by && review.review_version)
}

function sourceTrust(result = {}) {`,
    `function hasIndependentContentReview(result = {}) {
  const review = contentReviewMetadata(result)
  // Source identity is independently reviewed when the reviewer and review
  // contract are recorded. The review date is validated separately below so a
  // missing or stale date produces the precise freshness reason and can never
  // be mistaken for a trusted current claim.
  return Boolean(review.reviewed_by && review.review_version)
}

function sourceTrust(result = {}) {`,
    'separate review identity from review freshness',
  )
  source = source.replaceAll('hasCompleteContentReview(result)', 'hasIndependentContentReview(result)')
  fs.writeFileSync(file, source)
  console.log(`updated ${file}`)
}

{
  const file = 'backend/services/greenHomeNoCostSearch.js'
  let source = fs.readFileSync(file, 'utf8')
  source = replaceOnce(
    source,
    `      const enriched = persisted
        ? {
            ...result,
            ...persisted,
            result_source: result.result_source,
            url: persisted.final_url || persisted.application_url || persisted.source_url || result.url,
          }
        : result`,
    `      const enriched = persisted
        ? {
            ...result,
            ...persisted,
            // Persisted rows are the authority for source, cost, review, and
            // link metadata. The live search result is the authority for the
            // current profile/item score, which must not be replaced by a
            // stale catalog score during rehydration or deduplication.
            need_score: result.need_score ?? persisted.need_score,
            item_relevance_score:
              result.item_relevance_score ?? persisted.item_relevance_score,
            result_source: result.result_source,
            url: persisted.final_url || persisted.application_url || persisted.source_url || result.url,
          }
        : result`,
    'preserve current live match score during catalog rehydration',
  )
  fs.writeFileSync(file, source)
  console.log(`updated ${file}`)
}

console.log('Applied final green-home policy and ranking corrections.')
