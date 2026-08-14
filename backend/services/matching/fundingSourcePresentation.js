import { classifyFundingResult, RESULT_BUCKETS } from '../../config/fundingResultFilters.js'
import { canonicalOpportunityKey } from '../../crawler-os/contract.js'

const RESOURCE_OPPORTUNITY_KINDS = new Set([
  'DIRECTORY',
  'PAST_AWARD_INTEL',
  'SCHOOL_PORTAL',
  'REFERRAL',
])

/**
 * Return true when a surfaced row is a locator, directory, referral, or other
 * resource rather than a direct funding opportunity.
 *
 * The explicit flags remain supported for normalized callers, while the kind
 * check protects presentation paths that receive raw catalog rows. Keeping the
 * classification here prevents the match engine and the owner-facing totals
 * from developing different definitions again.
 */
export function isFundingResource(source = {}) {
  if (source?.is_directory === true || source?.is_resource === true) return true

  const kind = String(
    source?.opportunity_kind ??
    source?.opportunity_type ??
    source?.type ??
    '',
  ).trim().toUpperCase()

  return RESOURCE_OPPORTUNITY_KINDS.has(kind)
}

/**
 * How complete a row is, for the keep-the-most-complete dedup rule below.
 * More stated facts (amount, url, deadline, sponsor, longer summary) win;
 * ties go to the higher stored match score.
 */
function completenessOf(row = {}) {
  let score = 0
  // `||` throughout: an empty-string column is as absent as NULL for the
  // purpose of "how complete is this record", and `??` would stop the fallback
  // field from ever being read — making the LESS complete duplicate win.
  if (Number(row.amount_min) > 0 || Number(row.amount_max) > 0) score += 4
  if (String(row.url || row.application_url || row.apply_url || '').trim()) score += 3
  if (row.deadline) score += 2
  if (String(row.sponsor || row.funder || '').trim()) score += 2
  if (String(row.summary || row.description || '').trim().length > 80) score += 1
  return score
}

/**
 * Collapse multi-feed duplicates of the SAME real-world opportunity on the
 * owner-facing list (LIHEAP ingested by both the ACF feed and a state feed;
 * near-identical MTSU/WCCCD rows). The identity is the CANONICAL
 * `canonicalOpportunityKey` — the single durable dedup authority (external_id
 * → token-sorted title+sponsor → URL). Do NOT invent a second identity rule
 * here; this only EXTENDS the existing key's consultation to the read path.
 *
 * The most complete record is kept; the duplicate is dropped from display only
 * (nothing is deleted — the catalog rows and match rows are untouched).
 */
export function dedupeByCanonicalIdentity(sources = []) {
  const list = Array.isArray(sources) ? sources : []
  const byKey = new Map()
  const order = []
  let removed = 0
  for (const source of list) {
    let key = null
    try {
      key = canonicalOpportunityKey({
        title: source?.title,
        sponsor: source?.sponsor,
        apply_url: source?.url ?? source?.application_url ?? null,
        info_url: source?.source_url ?? null,
        external_id: source?.external_id ?? null,
        id: source?.id,
      })
    } catch {
      key = null
    }
    if (!key) key = `id:${source?.id ?? order.length}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, source)
      order.push(key)
      continue
    }
    removed += 1
    const keepNew =
      completenessOf(source) > completenessOf(existing) ||
      (completenessOf(source) === completenessOf(existing) &&
        Number(source?.match_score ?? -1) > Number(existing?.match_score ?? -1))
    if (keepNew) byKey.set(key, source)
  }
  return { deduped: order.map((k) => byKey.get(k)), removed }
}

/**
 * Partition a profile's surfaced results into direct funding, resources, and
 * the hidden "Not a grant" bucket (owner QA pass 2026-08-03).
 *
 * Order of operations:
 *   1. Canonical-identity dedup (display-level only — nothing deleted).
 *   2. The SHARED FILTER CHAIN (`classifyFundingResult`) routes regulatory/
 *      administrative notices, lead-gen "scholarships", clearly-expired
 *      programs, and anonymized-funder records into `not_a_grant` — they NEVER
 *      reach Best matches / Worth reviewing, whatever stored decision they
 *      carry (stored ACCEPTs predate the engine gates; the store is a rolling
 *      snapshot).
 *   3. Resources (pointer kinds + records with no fundable signal) fill the
 *      existing `directories` bucket — kept visible, never direct matches
 *      (the locator rule: never dropped from lists, never promoted).
 *
 * Response contract is ADDITIVE: `total`/`sources`/`best_matches`/
 * `worth_reviewing`/`directories`/`resource_count` keep their meaning;
 * `not_a_grant` + `not_a_grant_count` + `duplicates_collapsed` are new.
 */
export function partitionFundingSources(sources = []) {
  const list = Array.isArray(sources) ? sources : []
  const { deduped, removed } = dedupeByCanonicalIdentity(list)

  const notAGrant = []
  const directories = []
  const directSources = []
  for (const source of deduped) {
    const verdict = classifyFundingResult(source)
    if (verdict.bucket === RESULT_BUCKETS.NOT_A_GRANT) {
      notAGrant.push({ ...source, not_a_grant_reasons: verdict.reasons })
      continue
    }
    // A stored engine ACCEPT is a strong certification (matchSurfacing: hiding
    // the engine's own accepts is incoherence) — absence of a stated signal is
    // SILENCE, and silence is not a denial, so the no-fundable-signal routing
    // applies only to rows the engine did NOT certify. Positive junk evidence
    // (the not_a_grant classes above) still overrides a stored ACCEPT.
    const isStoredAccept = String(source?.match_decision || '').toLowerCase() === 'accept'
    if (isFundingResource(source) || (verdict.bucket === RESULT_BUCKETS.RESOURCE && !isStoredAccept)) {
      directories.push(
        verdict.bucket === RESULT_BUCKETS.RESOURCE && !isFundingResource(source)
          ? { ...source, resource_reasons: verdict.reasons }
          : source,
      )
      continue
    }
    directSources.push(verdict.stale ? { ...source, stale: true } : source)
  }

  return {
    total: directSources.length,
    sources: directSources,
    best_matches: directSources.filter(
      (source) => String(source?.match_decision || '').toLowerCase() === 'accept',
    ),
    worth_reviewing: directSources.filter(
      (source) => String(source?.match_decision || '').toLowerCase() === 'review',
    ),
    directories,
    resource_count: directories.length,
    not_a_grant: notAGrant,
    not_a_grant_count: notAGrant.length,
    duplicates_collapsed: removed,
  }
}

export default { isFundingResource, partitionFundingSources, dedupeByCanonicalIdentity }
