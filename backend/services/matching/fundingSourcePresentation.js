import { classifyFundingResult, RESULT_BUCKETS } from '../../config/fundingResultFilters.js'
import { canonicalOpportunityKey } from '../../crawler-os/contract.js'
import { sameProgram, programTokens, programIdentityKey, sponsorsAgree } from '../../config/programIdentity.js'

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

/** Does `candidate` carry more stated facts than the row currently kept? */
function beatsKept(candidate, kept) {
  const a = completenessOf(candidate)
  const b = completenessOf(kept)
  if (a !== b) return a > b
  return Number(candidate?.match_score ?? -1) > Number(kept?.match_score ?? -1)
}

/**
 * Collapse SUBSET duplicates the canonical key cannot see.
 *
 * `dedupeByCanonicalIdentity` is a Map keyed on a hash, so it can only collapse
 * rows whose identity is EQUAL. The duplicates that actually reach the owner's
 * screen are SUBSET pairs — "Family Support Program" vs "TN Family Support
 * Program", "1915(c) HCBS Waivers" vs "TennCare 1915(c) HCBS Waivers" — and a
 * set-equality key reports those as different programs. Measured on one real
 * profile 2026-08-25: the canonical pass collapsed 0 of 10 rows and left SEVEN
 * duplicate pairs visible.
 *
 * The predicate is the SHARED `sameProgram` (config/programIdentity.js), the
 * same one Robert's pipeline audit uses — no second identity rule is invented
 * here. Display-level only: nothing is deleted, and the most complete record
 * survives, exactly as in the canonical pass.
 *
 * The token buckets are an EXACT prefilter, not a heuristic: `sameProgram`'s
 * containment branch requires the smaller token set to be a subset of the
 * larger, so two rows sharing NO distinctive token can never match it. Rows
 * that match on IDENTITY KEY instead (a stored `canonical_opportunity_key`,
 * where token sets may be empty) are caught by the key map. Every pair the
 * predicate would call equal is therefore still compared.
 */
export function collapseSameProgramDuplicates(sources = []) {
  const list = Array.isArray(sources) ? sources : []
  const kept = []
  const byToken = new Map()
  const byIdentity = new Map()
  let removed = 0

  const index = (slot, source) => {
    for (const token of programTokens(source)) {
      if (!byToken.has(token)) byToken.set(token, new Set())
      byToken.get(token).add(slot)
    }
  }

  for (const source of list) {
    const tokens = programTokens(source)
    const candidates = new Set()
    for (const token of tokens) {
      for (const slot of byToken.get(token) || []) candidates.add(slot)
    }
    let rawKey = null
    try {
      rawKey = programIdentityKey(source)
    } catch {
      rawKey = null
    }
    // Only a STORED canonical key (`c:`) or real title tokens (`t:`) identify a
    // program. The `k:`/`g:` fallbacks do not: for a row with no title, no
    // sponsor and no url, `programIdentityKey` returns the literal `g:undefined`
    // — so keying on it made every identity-less row look like the same program
    // and collapsed three distinct resources into one (caught by
    // remainingAuditCorrections). Absence of a title is SILENCE, and silence is
    // not evidence of sameness: such a row is kept as its own entry, always.
    const identityKey = rawKey && (rawKey.startsWith('c:') || rawKey.startsWith('t:')) ? rawKey : null
    // A row with neither tokens nor an identifying key therefore reaches the
    // matcher with an EMPTY candidate set and is kept as its own entry — no
    // separate early-return is needed, and adding one would be a branch no test
    // could ever fail on.
    if (identityKey && byIdentity.has(identityKey)) candidates.add(byIdentity.get(identityKey))

    let match = -1
    for (const slot of candidates) {
      // canonicalKeyIsFinal:false — on the read path every row carries a
      // canonical key, and two DIFFERENT keys are routinely the SAME program
      // spelled two ways ("Katie Beckett Waiver" / "Katie Beckett Program").
      // Removing that veto means we owe corroboration, so the sponsors must
      // also agree: it is what keeps a City of Chattanooga program from
      // merging into a state one that shares its generic title.
      if (sameProgram(kept[slot], source, { canonicalKeyIsFinal: false })
        && sponsorsAgree(kept[slot], source)) { match = slot; break }
    }

    if (match < 0) {
      const slot = kept.push(source) - 1
      index(slot, source)
      if (identityKey && !byIdentity.has(identityKey)) byIdentity.set(identityKey, slot)
      continue
    }

    removed += 1
    // The slot is the PROGRAM, not the row: index the loser's tokens too, so a
    // later spelling that only overlaps the discarded variant still lands here.
    index(match, source)
    if (identityKey && !byIdentity.has(identityKey)) byIdentity.set(identityKey, match)
    if (beatsKept(source, kept[match])) kept[match] = source
  }

  return { deduped: kept, removed }
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
  const canonical = dedupeByCanonicalIdentity(list)
  // Two passes, in this order: the canonical key collapses EQUAL identities
  // cheaply, then the pairwise predicate collapses the SUBSET spellings a
  // hash key structurally cannot see.
  const { deduped, removed: subsetRemoved } = collapseSameProgramDuplicates(canonical.deduped)
  const removed = canonical.removed + subsetRemoved

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

export default { isFundingResource, partitionFundingSources, dedupeByCanonicalIdentity, collapseSameProgramDuplicates }
