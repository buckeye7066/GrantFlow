/**
 * dedupePipelineGrants.js — collapse duplicate pipeline rows for the SAME
 * opportunity within a scope (re-discovery can insert a second `grants` row for
 * an opportunity already in a profile's pipeline). Duplicate rows double-count
 * in the funnel/stats AND show twice in lists (the HMIT / Distance-Learning
 * duplicates). Applying ONE dedup at the read layer — used by BOTH /api/grants
 * (the lists) and /api/pipeline/stats (the funnel) — keeps every count source
 * agreeing without deleting any data.
 */
import { stageOrder } from './pipelineStages.js'

/** Stable per-opportunity key: canonical funding_opportunity_id, else title+funder. */
export function opportunityKey(g) {
  if (g?.funding_opportunity_id) return `fo:${g.funding_opportunity_id}`
  const title = String(g?.title || '').trim().toLowerCase()
  const funder = String(g?.funder || g?.sponsor || '').trim().toLowerCase()
  if (!title && !funder) return null // un-keyable → never merged
  return `tf:${title}|${funder}`
}

/**
 * Keep one row per opportunity, choosing the MOST-PROGRESSED (and never dropping
 * an awarded row). Rows that can't be keyed (no id/title/funder) pass through
 * untouched so nothing real is lost.
 */
export function dedupePipelineGrants(rows) {
  const best = new Map()
  const passthrough = []
  for (const g of Array.isArray(rows) ? rows : []) {
    const key = opportunityKey(g)
    if (!key) { passthrough.push(g); continue }
    const prev = best.get(key)
    if (!prev) { best.set(key, g); continue }
    const awardedNow = Number(g?.amount_awarded) > 0
    const awardedPrev = Number(prev?.amount_awarded) > 0
    if (awardedNow && !awardedPrev) { best.set(key, g); continue }
    if (!awardedNow && awardedPrev) continue
    if (stageOrder(g?.status) > stageOrder(prev?.status)) best.set(key, g)
  }
  return [...best.values(), ...passthrough]
}

export default { opportunityKey, dedupePipelineGrants }
