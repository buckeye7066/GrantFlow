/**
 * Extract grant/funding opportunity-like entries from document text (e.g. URL import from daily digest).
 * Finds URLs and builds minimal opportunity records so they appear in Discover app-wide.
 */
import { upsertFundingOpportunity } from './opportunityInserter.js'

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi

/**
   * Extract URLs from text and derive a short title from the URL or surrounding line.
   */
function extractUrlsWithContext(text) {
    if (!text || typeof text !== 'string') return []
        const results = []
            const seen = new Set()
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          const matches = line.match(URL_REGEX)
          if (!matches) continue
          for (const rawUrl of matches) {
                  let url = rawUrl.replace(/[.,;:)]+$/, '').trim()
                  if (!url) continue
                  let parsedUrl
                  try {
                            parsedUrl = new URL(url)
                            url = parsedUrl.href
                  } catch {
                            continue
                  }
                  if (seen.has(url)) continue
                  seen.add(url)
                  const titleFromLine = line.replace(URL_REGEX, '').replace(/^[-*\u2022\s]+|\s*[-*\u2022]\s*$/g, '').trim().slice(0, 300)
                  const titleFromUrl = parsedUrl?.pathname ? decodeURIComponent(parsedUrl.pathname.split('/').filter(Boolean).pop() || parsedUrl.hostname) : parsedUrl?.hostname
                  const title = titleFromLine || titleFromUrl || `Grant link (${parsedUrl?.hostname || 'unknown'})`
                  results.push({ url, title, line })
          }
    }
    return results
}

/**
 * Upsert opportunities from document text into funding_opportunities so they appear globally in Discover.
 */
export async function extractAndUpsertOpportunitiesFromText(db, text, profile = null) {
    const entries = extractUrlsWithContext(text)
    const results = { inserted: 0, skipped: 0, errors: [] }
    // Provenance: `profile` was accepted and never read. `funding_opportunities.profile_id`
    // is the one key `enforceProfileDiscoveredCatalogLinkage` uses to re-offer a
    // discovered row to the profile it was discovered FOR, so dropping it made an
    // imported row permanently unreachable by that recall net.
    const profileId = (typeof profile === 'string' ? profile : profile?.id ?? profile?.profile_id) ?? null
    for (const { url, title } of entries) {
          try {
                  const opportunity = {
  title: title.slice(0, 500),
  source_url: url,
  application_url: url,  // Stored as candidate; must be verified before decision engine sets ACCEPT
  description: `Imported from URL. Source: ${url}`,
  source: 'url_import',
  record_origin: 'url_import',
  opportunity_type: 'grant',
  profile_id: profileId,
  // NO `is_national` claim. This used to assert `is_national: true` for EVERY
  // URL found in ANY uploaded document, and `deriveIsNational` honors an
  // explicit `true` verbatim — so a link pasted into a digest was persisted as a
  // fully-eligible NATIONWIDE US program with no state, and every state-keyed
  // geo gate fell open for it (the documented "a row with no geography scored
  // as nationwide" class). We do not know this link's scope; silence is the
  // honest answer and `deriveIsNational` resolves it from the row's own state.
  eligibility_status: 'pending',
  match_decision: 'PENDING',
  match_explanation: 'Imported from URL; pending full evaluation by matchEngine.',
  matched_needs: JSON.stringify([]),
  ineligibility_reasons: JSON.stringify([]),
  matcher_version: 'pending',
  evaluated_at: null,
}
                  const out = await upsertFundingOpportunity(db, opportunity)
                  if (out.inserted) results.inserted += 1
                  else results.skipped += 1
          } catch (err) {
                  results.errors.push(err instanceof Error ? err.message : String(err))
          }
    }
    return results
}
