/**
 * robertIngestionBridge.js
 *
 * Sends verified, normalized opportunities through the existing
 * canonical ingestion path. Robert never writes directly to
 * `funding_opportunities`. The bridge only delegates.
 *
 * The canonical inserter (`upsertFundingOpportunity`) re-runs the
 * full policy/validator/reviewer/reality chain itself, so a
 * Robert-side failure here means the same kind of rejection a real
 * crawler would produce.
 *
 * To keep unit tests deterministic, the inserter callable is INJECTED
 * (default = the real `upsertFundingOpportunity` lazy-imported only
 * when the bridge is actually used).
 */

let _cachedUpsert = null
async function getDefaultUpsert() {
  if (_cachedUpsert) return _cachedUpsert
  const mod = await import('../opportunityInserter.js')
  _cachedUpsert = mod.upsertFundingOpportunity
  return _cachedUpsert
}

/**
 * Ingest a single normalized opportunity through the canonical path.
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.opportunity         output of normalizeForCanonicalInsert
 * @param {Function} [args.upsertFundingOpportunity] override for tests
 * @returns {Promise<{ id, inserted, updated, skipped, reason }>}
 */
export async function ingestOpportunity({
  db,
  opportunity,
  upsertFundingOpportunity = null,
  upsertOptions = {},
} = {}) {
  if (!db) throw new Error('ingestOpportunity: db required')
  if (!opportunity) throw new Error('ingestOpportunity: opportunity required')
  const upsert = typeof upsertFundingOpportunity === 'function'
    ? upsertFundingOpportunity
    : await getDefaultUpsert()
  const result = await upsert(db, opportunity, {
    // Robert delegates: never bypass real gates. autoIngestVerified just
    // controls whether the agent calls the bridge — not whether the bridge
    // skips canonical guards.
    skipVerification: false,
    allowLoans: false,
    allowDirectories: false,
    allowExpired: false,
    allowMatchingFunds: false,
    verifyUrl: false,
    ...upsertOptions,
  })
  return {
    id: result?.id ?? null,
    inserted: Boolean(result?.inserted),
    updated: Boolean(result?.updated),
    skipped: Boolean(result?.skipped),
    reason: result?.reason || null,
  }
}

/**
 * Convenience: ingest a list and return a tally.
 */
export async function ingestOpportunities({ db, opportunities = [], upsertFundingOpportunity = null, upsertOptions = {} } = {}) {
  const tally = { inserted: 0, updated: 0, skipped: 0, errors: 0, results: [] }
  for (const opp of opportunities) {
    try {
      const r = await ingestOpportunity({ db, opportunity: opp, upsertFundingOpportunity, upsertOptions })
      tally.results.push(r)
      if (r.inserted) tally.inserted += 1
      else if (r.updated) tally.updated += 1
      else if (r.skipped) tally.skipped += 1
    } catch (err) {
      tally.errors += 1
      tally.results.push({ id: null, inserted: false, updated: false, skipped: true, reason: `error:${String(err?.message || err).slice(0, 200)}` })
    }
  }
  return tally
}
