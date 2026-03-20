/**
 * Shared helper for domain engines: normalize with URL required, apply exclusions, never throw.
 */

import { normalizeOpportunity, looksLikeLoan, looksLikeMatchingFunds } from '../domainCrawlerEngine.js'

const ENGINE_ID = 'engine'

export function normalizeAndFilter(rows, engineId, { strict_no_loans = false, strict_no_matching = false } = {}) {
  const out = []
  for (const raw of rows) {
    const n = normalizeOpportunity({ ...raw, record_origin: 'directory_resource' }, engineId)
    if (!n) continue
    if (strict_no_loans || strict_no_matching) {
      const text = [n.title, n.description, ...(n.eligibility_bullets || []), ...(n.keywords || [])].filter(Boolean).join(' ')
      if (strict_no_loans && looksLikeLoan(text)) continue
      if (strict_no_matching && looksLikeMatchingFunds(text)) continue
    }
    out.push(n)
  }
  return out
}
