/**
 * enforceInvariants.js — CANONICAL PRODUCT-INVARIANT ENFORCEMENT (boot sweep).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 * ─────────────────────────────────────────────────────────────────────────
 * GrantFlow kept shipping the same class of bug: a canonical product RULE
 * (docs/canonical_rules.md) was enforced only by *convention* — "remember to
 * check the DISMISSED tombstone in every insert path", "remember to scope by
 * profile_id everywhere". Every new code path that forgot the check
 * re-introduced the violation:
 *
 *   - User-deleted pipeline grants reappeared (sticky-delete rule violated by
 *     insert paths that didn't consult pipeline_dismissals).
 *   - Cross-profile grants ("things that have nothing to do with her")
 *     appeared because a write set the wrong organization_id / profile_id.
 *   - Junk-but-present grants below the relevance floor lingered in pipelines.
 *
 * The fix is RULE-BY-CONSTRUCTION: instead of trusting per-call discipline in
 * 30+ route/service files, we RE-ASSERT each machine-checkable invariant in
 * ONE place against the live DB on every boot — detect violations, repair or
 * quarantine them, and log a structured summary. This is the same pattern as
 * reconcileDismissedGrants() in services/pipelineDismissals.js, generalized to
 * every automatable invariant.
 *
 * This module is the NET. The per-call gates are the first line of defense;
 * this sweep guarantees the invariant holds regardless of which path (a legacy
 * insert, a seed re-upsert, a future feature an agent writes next month) put
 * the bad row there.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CONTRACT (mirror ensureSchemaInvariants.js)
 * ─────────────────────────────────────────────────────────────────────────
 *   - Each invariant is its own exported function with its own try/catch so a
 *     single failure can never cascade and abort boot (recall-over-crash).
 *   - Each is idempotent and safe to re-run on a clean DB (a clean DB yields
 *     zero repairs).
 *   - Each is dialect-agnostic (the SQL below is valid on both SQLite and
 *     Postgres; per-dialect branches live inside the function when needed).
 *   - Each returns { name, scanned?, repaired, quarantined?, ok } so the
 *     summary is structured and greppable.
 *   - DATA repairs only. Schema-shape DDL belongs in ensureSchemaInvariants.js.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SAFETY POSTURE
 * ─────────────────────────────────────────────────────────────────────────
 * Per canonical_rules.md G2/G4/G5 ("zero results is a failure", "reduce score,
 * don't discard", "unverified ≠ dead") and the pipeline-prune playbook, this
 * sweep NEVER deletes a grant a user has progressed past discovery, and NEVER
 * treats "link not yet verified" as "dead". Destructive repairs are scoped as
 * narrowly as the rule allows; ambiguous cases are re-aligned (quarantined),
 * not deleted.
 */

import { createLogger } from '../utils/logger.js'
import { reconcileDismissedGrants, reconcileDismissedMatches } from '../services/pipelineDismissals.js'
import { resolveProfileForId } from '../utils/profileResolver.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { isTrustedRecordOrigin } from '../config/relevanceFloor.js'
import { CANONICAL_PROGRAMS, canonicalProgramTargetRepair } from '../config/canonicalProgramRegistry.js'
import { PIPELINE_ACTIVE_STATUSES, WIDE_AWARD_RANGE_RATIO, pipelineValueSql } from '../config/pipelineValue.js'
import { dedupeProfileDisplayName } from '../../shared/nameParsing.js'
import { resolveProfileType, getParentChain } from '../services/profileTypeRegistry.js'
import { grantFamilyKey, grantUrlKey, likelySameGrantOpportunity } from '../utils/grantFingerprint.js'
import { isSearchEngineUrl } from '../config/urlRules.js'
import { resolveOpportunityAmounts, isOfficialAmountSource, AMOUNT_MAX_PLAUSIBLE, AMOUNT_STATUS_NONE_PUBLISHED } from '../services/awardAmountExtractor.js'
import { DEMOTED_MATCH_SCORE } from '../config/matchThresholds.js'
import { reconcileConvertedApplications } from '../services/serviceApplicationConversion.js'
import { findOfficialUrlForOpportunity, significantTitleTokens } from '../services/urlEnrichment.js'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { classifyLocatorKindFromRow, LOCATOR_URL_LIKE_PREFILTERS, GENERIC_OVERRIDABLE_KINDS } from '../services/sources/locatorUrlKind.js'
import { AMOUNT_ENRICH_ENV_MAX_ATTEMPTS, AMOUNT_ENRICH_ENV_REPROBE_LIMIT } from '../config/amountEnrichEnv.js'
import { normalizePersistedMatchDecisionIntegrity } from '../services/matching/matchDecisionIntegrity.js'
import { hasFarmIdentity } from '../services/eligibility/farmIdentity.js'

const log = createLogger('startup:enforceInvariants')

/**
 * Canonical relevance floor for the per-profile pipeline.
 *
 * Source of truth: docs/canonical_rules.md + the pipeline-prune playbook —
 * `grants.match_score < RELEVANCE_FLOOR` (excluding NULL) is the ONLY clean
 * "this is junk for this profile" signal. NULL match_score is NEVER junk
 * (it predates scoring / was added manually), and is left untouched.
 *
 * NOTE: the AUTHORITATIVE floor used by both the per-insert gate and this purge
 * is `RELEVANCE_FLOOR` exported from backend/config/relevanceFloor.js (owned by
 * another agent). We resolve it lazily at run time (see getRelevanceFloor) so a
 * floor change in ONE place re-tunes both the insert gate and this sweep. This
 * legacy constant remains a back-compat fallback only.
 */
export const RELEVANCE_FLOOR = Number.parseInt(
  process.env.PIPELINE_RELEVANCE_FLOOR || '6',
  10,
) || 6

/**
 * Hard fallback if neither the shared config nor an env override is available.
 * Matches the insert-gate default (data-point scale, 2026-07-06 evening).
 */
const RELEVANCE_FLOOR_FALLBACK = 7

/**
 * LENIENT purge floor. The boot sweep is the destructive NET, so it must be at
 * least as lenient as the insert gate — INSERT floor >= PURGE floor — or it
 * would turn around and delete rows the insert gate just (correctly) admitted
 * (e.g. trusted rows admitted at the 5 trusted floor).
 *
 * The audit caught a "floor collapse": both the insert gate and this purge
 * resolved to the SAME config value, so the purge could delete rows that
 * should survive. We keep the documented split — the purge uses
 * min(resolvedFloor, 5) so it can never exceed the TRUSTED insert floor
 * (data-point scale). Override the cap via env PIPELINE_PURGE_RELEVANCE_FLOOR.
 */
const PURGE_FLOOR_CAP = (() => {
  const v = Number.parseInt(process.env.PIPELINE_PURGE_RELEVANCE_FLOOR || '5', 10)
  return Number.isFinite(v) && v > 0 ? v : 5
})()

let _floorCache // memoized { value, source }

/**
 * Resolve the canonical relevance floor used by the insert gate, so the purge
 * uses the SAME number. Resolution order:
 *   1. backend/config/relevanceFloor.js export `RELEVANCE_FLOOR` (source of truth).
 *   2. PIPELINE_RELEVANCE_FLOOR env (legacy override).
 *   3. RELEVANCE_FLOOR_FALLBACK (55).
 *
 * The config import is LAZY + guarded: the file may not exist yet (another
 * agent is creating it), so a missing module must never crash boot — we just
 * fall back and record the source so the log is honest about which path won.
 */
export async function getRelevanceFloor() {
  if (_floorCache) return _floorCache
  let value
  let source
  try {
    const mod = await import('../config/relevanceFloor.js')
    const fromConfig = Number(mod?.RELEVANCE_FLOOR)
    if (Number.isFinite(fromConfig)) {
      value = fromConfig
      source = 'config/relevanceFloor.js'
    }
  } catch {
    // module not resolvable yet — fall through to env / fallback
  }
  if (value === undefined) {
    const fromEnv = Number.parseInt(process.env.PIPELINE_RELEVANCE_FLOOR || '', 10)
    if (Number.isFinite(fromEnv)) {
      value = fromEnv
      source = 'env:PIPELINE_RELEVANCE_FLOOR'
    }
  }
  if (value === undefined) {
    value = RELEVANCE_FLOOR_FALLBACK
    source = `fallback(${RELEVANCE_FLOOR_FALLBACK}):config-not-resolvable`
  }
  _floorCache = { value, source }
  return _floorCache
}

/** Test-only: clear the memoized floor so env/config changes re-resolve. */
export function __resetFloorCache() {
  _floorCache = undefined
}

/**
 * Pipeline statuses that mean the USER has invested work in this grant. A
 * grant in one of these states is NEVER auto-purged by the relevance-floor
 * sweep even if it scores below the floor — deleting it would destroy user
 * work and violate Mission Goal #10 ("help users move from discovery to
 * action: tracking applications, deadlines, progress, documents").
 *
 * Includes canonical (shared/pipelineStages.js) + legacy stage names so a
 * pre-RC-13 row in `pending_review` is still protected.
 */
export const PROTECTED_PIPELINE_STATUSES = Object.freeze([
  // canonical post-discovery work
  'saved',
  'interested',
  'gathering_documents',
  'drafting',
  'ready_to_submit',
  'submitted',
  'follow_up',
  'awarded',
  'declined',
  'archived',
  // legacy equivalents still present in production rows
  'auto_applied',
  'application_prep',
  'app_prep',
  'revision',
  'portal',
  'pending_review',
  'under_review',
  'report',
  'closed',
])

/**
 * Names that mark protected MTSU / portal work. The relevance-floor purge must
 * NEVER delete a row whose title or funder matches this, even if it is in an
 * early status and scores below the floor — these rows back the Hamilton portal
 * automation + MTSU credential work and are hand-curated, not crawler junk.
 */
export const PROTECTED_NAME_PATTERN = /mtsu|middle tennessee state|portal/i

/**
 * Wraps a single invariant in a try/catch that logs but never throws.
 * Returns a structured result so runEnforceInvariants can summarize.
 */
async function runInvariant(name, fn) {
  try {
    const result = await fn()
    return { name, ok: true, ...result }
  } catch (err) {
    log.warn(`invariant "${name}" enforcement failed (non-fatal)`, {
      error: String(err?.message || err),
    })
    return { name, ok: false, error: String(err?.message || err) }
  }
}

function changesOf(result) {
  const n = Number(result?.changes ?? result?.rowCount ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Return the set of column names on the `grants` table for the active dialect.
 * Dialect-agnostic (PRAGMA on SQLite, information_schema on Postgres) and
 * defensive: any probe failure yields an empty set so callers degrade to the
 * minimal required columns rather than crashing the boot sweep.
 */
async function listGrantColumns(db) {
  try {
    if ((db?.dialect || 'sqlite') === 'postgres') {
      const rows = await db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'grants'`,
        )
        .all()
      return new Set((rows || []).map((r) => String(r.column_name)))
    }
    const cols = await db.prepare('PRAGMA table_info(grants)').all()
    return new Set((cols || []).map((c) => String(c.name)))
  } catch {
    return new Set()
  }
}

/**
 * INVARIANT: STICKY DELETES (canonical_rules.md — sticky-delete rule).
 *
 * "A funding source a user deleted from a profile pipeline stays gone." We
 * re-run the canonical reconcileDismissedGrants() sweep so any grant matching
 * a recorded tombstone for its own profile is purged, regardless of which path
 * re-inserted it. selfHeal.js already calls this once; running it again here is
 * idempotent (a no-op when selfHeal already cleaned up) and keeps ALL invariant
 * enforcement discoverable in one module.
 */
export async function enforceStickyDeletes(db) {
  return runInvariant('sticky_deletes', async () => {
    const removed = await reconcileDismissedGrants(db)
    // Match-list side of the same rule: the crawler-os pipeline upserts
    // profile_opportunity_matches on every discovery run with no knowledge of
    // dismissals, so a source deleted from the Funding Sources list would
    // resurrect on the next crawl without this sweep.
    const matchRowsRemoved = await reconcileDismissedMatches(db)
    return { repaired: removed + matchRowsRemoved, matchRowsRemoved }
  })
}

/**
 * INVARIANT: NO CROSS-PROFILE / CROSS-TENANT BLEED
 * (canonical_rules.md G4 + G8 — profile-scoped data, no leaking across
 * accounts).
 *
 * A grant carries both organization_id (its tenant) and profile_id (the
 * specific profile whose pipeline it belongs to). The UI filters pipelines by
 * profile_id, and a profile belongs to exactly one organization. Therefore a
 * grant whose organization_id disagrees with its profile's organization_id is
 * a tenancy violation — the grant would surface in the wrong org's data.
 *
 * REPAIR (quarantine, not delete): re-align the grant's organization_id to its
 * profile's organization_id. profile_id is the stronger tenancy signal (it is
 * what the UI scopes on), so trusting it is safe and non-destructive. We only
 * touch rows where the profile's org is known and actually differs.
 */
export async function enforceNoCrossProfileBleed(db) {
  return runInvariant('no_cross_profile_bleed', async () => {
    // Set-based UPDATE valid on both SQLite and Postgres. Scope to grants
    // whose profile resolves to a DIFFERENT, non-null organization than the
    // grant currently claims.
    const sql = `
      UPDATE grants
      SET organization_id = (
        SELECT p.organization_id FROM profiles p WHERE p.id = grants.profile_id
      )
      WHERE profile_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.id = grants.profile_id
            AND p.organization_id IS NOT NULL
            AND (grants.organization_id IS NULL
                 OR p.organization_id <> grants.organization_id)
        )
    `
    const result = await db.prepare(sql).run()
    const quarantined = changesOf(result)
    if (quarantined > 0) {
      log.info('re-aligned cross-profile grants to their profile org', { quarantined })
    }
    return { quarantined, repaired: quarantined }
  })
}

/**
 * INVARIANT: NO DUPLICATE GRANTS WITHIN A PROFILE
 * (canonical_rules.md G4 + pipeline-prune playbook — one row per opportunity per
 * profile).
 *
 * Many ingest paths (crawler re-runs, seed re-upserts, email/laptop ingestion,
 * legacy direct inserts) can land the SAME opportunity in a profile's pipeline
 * more than once. Duplicates inflate the pipeline, confuse the user, and make
 * "deleted stays gone" harder to reason about. Two grants are duplicates iff
 * they share a profile_id AND any one of:
 *   - the same funding_opportunity_id, OR
 *   - the same fingerprint, OR
 *   - the same lower(title) + lower(funder).
 *
 * STRICTLY PROFILE-SCOPED: we NEVER merge across profiles (that would be the
 * cross-profile bleed we separately forbid) — every comparison is partitioned
 * by profile_id.
 *
 * KEEP-BEST RULE (collapse each duplicate cluster to ONE survivor):
 *   1. Prefer the MOST-PROGRESSED status (a row the user has worked on wins over
 *      a raw discovered dupe) — Mission Goal #10, never destroy user work.
 *   2. Tie-break: keep the OLDEST row (created first) — it is the canonical
 *      original; later inserts are the re-adds.
 *   3. Tie-break: prefer a row whose match_score IS NOT NULL (scored > unscored).
 *   4. Final deterministic tie-break: lowest id, so the sweep is idempotent.
 * All non-survivors in the cluster are deleted.
 *
 * Idempotent: after one pass each cluster has a single row, so a re-run is a
 * no-op (clusters of size 1 are skipped).
 */
export async function enforceNoDuplicateGrants(db) {
  return runInvariant('no_duplicate_grants', async () => {
    // Pull the columns the keep-best decision + the strengthened title+funder
    // dedup key need. Profile-scoped rows only (a NULL profile_id has no
    // "within-profile" peers to dedupe against). deadline/url/amount corroborate
    // the weak title+funder key; they may be absent on older/test schemas, so we
    // select only the OPTIONAL columns that actually exist (a missing corroborator
    // simply means the weak key won't fire for lack of agreement).
    const grantCols = await listGrantColumns(db)
    const optional = ['deadline', 'url', 'application_url', 'amount_requested'].filter((c) => grantCols.has(c))
    const selectCols = [
      'id', 'profile_id', 'funding_opportunity_id', 'fingerprint',
      'title', 'funder', 'status', 'match_score', 'created_at',
      ...optional,
    ].join(', ')
    const rows = await db
      .prepare(`SELECT ${selectCols} FROM grants WHERE profile_id IS NOT NULL`)
      .all()

    // Build duplicate clusters keyed within each profile. A single grant can
    // belong to multiple keys (opp-id AND title+funder); we use union-find so
    // transitively-linked rows collapse into ONE cluster.
    const parent = new Map()
    const find = (x) => {
      let r = x
      while (parent.get(r) !== r) r = parent.get(r)
      let c = x
      while (parent.get(c) !== r) {
        const next = parent.get(c)
        parent.set(c, r)
        c = next
      }
      return r
    }
    const union = (a, b) => {
      const ra = find(a)
      const rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (const row of rows) parent.set(row.id, row.id)

    // keyBuckets: dedupe-key -> first row id seen with that key. Each key is
    // namespaced by profile so we never cross profiles.
    const norm = (v) => String(v ?? '').trim().toLowerCase()
    const urlHost = (v) => {
      const s = norm(v)
      if (!s) return ''
      try {
        return new URL(s.includes('://') ? s : `https://${s}`).host
      } catch {
        return ''
      }
    }
    const keyBuckets = new Map()
    const familyBuckets = new Map()
    const linkByKey = (key, id) => {
      if (!key) return
      if (keyBuckets.has(key)) union(keyBuckets.get(key), id)
      else keyBuckets.set(key, id)
    }
    for (const row of rows) {
      const p = norm(row.profile_id)
      if (row.funding_opportunity_id !== null && row.funding_opportunity_id !== undefined && norm(row.funding_opportunity_id) !== '') {
        linkByKey(`p:${p}|opp:${norm(row.funding_opportunity_id)}`, row.id)
      }
      if (row.fingerprint !== null && row.fingerprint !== undefined && norm(row.fingerprint) !== '') {
        linkByKey(`p:${p}|fp:${norm(row.fingerprint)}`, row.id)
      }
      const stableUrl = grantUrlKey(row)
      if (stableUrl) {
        linkByKey(`p:${p}|url:${stableUrl}`, row.id)
      }
      const familyKey = grantFamilyKey(row)
      if (familyKey) {
        const bucketKey = `p:${p}|family:${familyKey}`
        if (!familyBuckets.has(bucketKey)) familyBuckets.set(bucketKey, [])
        familyBuckets.get(bucketKey).push(row)
      }
      const title = norm(row.title)
      if (title !== '') {
        // STRENGTHENED title+funder key (recall guard against false-duplicate
        // collapse): the weak title-based key is only valid when there is a
        // NON-EMPTY funder AND at least one MORE agreeing field (amount,
        // deadline, or url-host). An empty/shared funder, or title+funder with
        // no corroborating field, is NOT enough to merge — distinct programs
        // that happen to share a title (or have a blank funder) stay separate.
        const funder = norm(row.funder)
        const host = urlHost(row.url ?? row.application_url)
        const deadline = norm(row.deadline)
        const amount = norm(row.amount_requested)
        if (funder !== '') {
          const corroborator =
            (amount !== '' && `amt:${amount}`) ||
            (deadline !== '' && `dl:${deadline}`) ||
            (host !== '' && `host:${host}`) ||
            ''
          if (corroborator) {
            linkByKey(`p:${p}|tf:${title}|${funder}|${corroborator}`, row.id)
          }
        }
      }
    }

    for (const bucket of familyBuckets.values()) {
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          if (likelySameGrantOpportunity(bucket[i], bucket[j])) {
            union(bucket[i].id, bucket[j].id)
          }
        }
      }
    }

    // Group rows by cluster root.
    const byId = new Map(rows.map((r) => [r.id, r]))
    const clusters = new Map()
    for (const row of rows) {
      const root = find(row.id)
      if (!clusters.has(root)) clusters.set(root, [])
      clusters.get(root).push(row)
    }

    // Most-progressed first: index into PROTECTED order = how far along. A
    // protected/working status outranks a discovery status; among discovery
    // statuses they're equal (rank -1) and fall to the next tie-break.
    const progressRank = (status) => {
      const idx = PROTECTED_PIPELINE_STATUSES.indexOf(String(status ?? ''))
      return idx // -1 (not protected/discovery) sorts last
    }
    const createdMs = (v) => {
      const t = Date.parse(String(v ?? ''))
      return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY // unknown = "newest"
    }

    const toDelete = []
    const affectedProfiles = new Set()
    for (const cluster of clusters.values()) {
      if (cluster.length < 2) continue
      const sorted = [...cluster].sort((a, b) => {
        // 1. most-progressed status wins (higher rank first)
        const pr = progressRank(b.status) - progressRank(a.status)
        if (pr !== 0) return pr
        // 2. oldest first
        const ca = createdMs(a.created_at)
        const cb = createdMs(b.created_at)
        if (ca !== cb) return ca - cb
        // 3. non-null match_score preferred
        const sa = (a.match_score === null || a.match_score === undefined) ? 1 : 0
        const sb = (b.match_score === null || b.match_score === undefined) ? 1 : 0
        if (sa !== sb) return sa - sb
        // 4. deterministic: lowest id
        return String(a.id).localeCompare(String(b.id))
      })
      const survivor = sorted[0]
      affectedProfiles.add(survivor.profile_id)
      for (let i = 1; i < sorted.length; i += 1) toDelete.push(sorted[i].id)
    }

    if (toDelete.length === 0) {
      return { scanned: rows.length, repaired: 0, profilesAffected: 0, duplicatesRemoved: 0 }
    }

    // Delete in chunks to stay well under any parameter limit on either dialect.
    const CHUNK = 200
    let removed = 0
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const slice = toDelete.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const result = await db
        .prepare(`DELETE FROM grants WHERE id IN (${ph})`)
        .run(...slice)
      removed += changesOf(result) || slice.length
    }

    const summary = {
      profilesAffected: affectedProfiles.size,
      duplicatesRemoved: removed,
    }
    log.info('collapsed duplicate grants within profiles (kept best per cluster)', summary)
    return { scanned: rows.length, repaired: removed, ...summary }
  })
}

/**
 * INVARIANT: RELEVANCE / MATCH-SCORE FLOOR
 * (canonical_rules.md G4 + pipeline-prune playbook).
 *
 * The per-profile pipeline must not silently accumulate junk: a grant with a
 * non-null match_score strictly below the canonical floor is irrelevant to that
 * profile and should not occupy pipeline space. This sweep now DELETES that junk
 * BY DEFAULT (it used to only count) so the pipeline stays clean without an
 * operator opt-in — the per-insert gate is the first line, this is the net.
 *
 * The floor value is resolved from the SAME source as the insert gate
 * (backend/config/relevanceFloor.js via getRelevanceFloor), so the two can
 * never drift; it falls back to 55 if that config is not yet resolvable.
 *
 * GUARDRAILS (so we never destroy user work or violate G2/G4/G5) — a row is
 * deleted ONLY when ALL of these hold:
 *   - match_score IS NOT NULL  (NULL score ≠ junk; G4 "missing fields neutral").
 *   - match_score < floor.
 *   - status is an EARLY / discovered stage (discovered / discovery / interested
 *     / NULL) — anything in PROTECTED_PIPELINE_STATUSES (gathering_documents and
 *     beyond, submitted, awarded, …) is user work and is NEVER deleted.
 *   - title/funder does NOT match PROTECTED_NAME_PATTERN (protect MTSU/portal
 *     work even if it looks like low-score discovery junk).
 *
 * OVERRIDE: enforcement is ON by default. Set ENFORCE_RELEVANCE_FLOOR=0 to
 * DISABLE the delete (revert to count-only) without a code change.
 */
// Early/discovery statuses we are willing to purge below the floor. Everything
// not in this set is treated as "do not auto-delete" (and PROTECTED statuses are
// excluded outright), so the purge can only ever reach raw discovery junk.
const PURGEABLE_DISCOVERY_STATUSES = Object.freeze([
  'discovered',
  'discovery',
  'interested',
  'new',
  'matched',
])

export async function enforceRelevanceFloor(db) {
  return runInvariant('relevance_floor', async () => {
    const { value: insertFloor, source: insertFloorSource } = await getRelevanceFloor()
    // Purge with the LENIENT floor (never above PURGE_FLOOR_CAP, and never above
    // the insert floor) so the net can't delete rows the insert gate admitted.
    const floor = Math.min(insertFloor, PURGE_FLOOR_CAP)
    const floorSource = `${insertFloorSource}→purge(min ${PURGE_FLOOR_CAP})`

    const protectedPh = PROTECTED_PIPELINE_STATUSES.map(() => '?').join(', ')

    // Candidate predicate (count + delete share it): below floor, non-null
    // score, NOT a protected/working status. Name-pattern + trusted-origin
    // protection are applied in JS so they work identically on SQLite + Postgres.
    //
    // Trusted-origin resolution: grants has no record_origin column, so we LEFT
    // JOIN funding_opportunities (the row's source of vetting). The join is
    // defensive — if funding_opportunities or its record_origin column is
    // absent, we fall back to a no-origin query and simply skip the exemption.
    const baseWhere = `
      g.match_score IS NOT NULL
      AND g.match_score < ?
      AND (g.status IS NULL OR g.status NOT IN (${protectedPh}))
    `

    let candidates
    try {
      candidates = await db
        .prepare(
          `SELECT g.id, g.title, g.funder, g.status, fo.record_origin AS record_origin
           FROM grants g
           LEFT JOIN funding_opportunities fo ON fo.id = g.funding_opportunity_id
           WHERE ${baseWhere}`,
        )
        .all(floor, ...PROTECTED_PIPELINE_STATUSES)
    } catch {
      // funding_opportunities / record_origin not available — degrade to a
      // plain grants query with no origin (no trusted exemption possible).
      const rows = await db
        .prepare(
          `SELECT id, title, funder, status FROM grants
           WHERE match_score IS NOT NULL AND match_score < ?
             AND (status IS NULL OR status NOT IN (${protectedPh}))`,
        )
        .all(floor, ...PROTECTED_PIPELINE_STATUSES)
      candidates = (rows || []).map((r) => ({ ...r, record_origin: null }))
    }

    // Apply the MTSU/portal name guard, trusted-origin exemption, and the
    // early-status allowlist in JS. We only ever delete rows in an explicitly-
    // purgeable discovery status (or NULL status), never an unrecognized status
    // we don't understand, and NEVER a vetted/trusted-origin row.
    let trustedExempt = 0
    const purgeable = candidates.filter((r) => {
      const status = (r.status === null || r.status === undefined) ? null : String(r.status)
      const isEarly =
        status === null || PURGEABLE_DISCOVERY_STATUSES.includes(status)
      if (!isEarly) return false
      if (PROTECTED_NAME_PATTERN.test(`${r.title ?? ''} ${r.funder ?? ''}`)) return false
      if (isTrustedRecordOrigin(r.record_origin)) {
        trustedExempt += 1
        return false
      }
      return true
    })

    const violators = purgeable.length

    const disabled = _parseBoolEnv(process.env.ENFORCE_RELEVANCE_FLOOR) === false
    if (disabled) {
      if (violators > 0) {
        log.warn('below-floor grants present (purge DISABLED via ENFORCE_RELEVANCE_FLOOR=0)', {
          violators,
          floor,
          floorSource,
        })
      }
      return { scanned: violators, repaired: 0, enforced: false, floor, floorSource, trustedExempt }
    }

    if (violators === 0) {
      return { scanned: 0, repaired: 0, enforced: true, floor, floorSource, trustedExempt }
    }

    const ids = purgeable.map((r) => r.id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const result = await db.prepare(`DELETE FROM grants WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(result) || slice.length
    }
    if (repaired > 0) {
      log.info('purged below-floor pipeline grants', { repaired, floor, floorSource, trustedExempt })
    }
    return { scanned: violators, repaired, enforced: true, floor, floorSource, trustedExempt }
  })
}

/**
 * INVARIANT: INDIVIDUAL-PROFILE AMOUNT SANITY CEILING
 * (canonical_rules.md G4 + eligibility realism — a person's pipeline must not be
 * inflated by institutional-scale money they cannot receive).
 *
 * THE BUG THIS CLOSES
 * -------------------
 * A funding feed (record_origin `funding_api`, i.e. the federal Grants.gov / NSF
 * catalog) matched large INSTITUTIONAL research awards — NSF S-STEM, RUI, REU
 * Site, HBCU targeted-infusion, etc., each $300k–$650k — into an individual
 * STUDENT's pipeline. Summed by the Pipeline Potential card
 * (SUM(grants.amount_requested) over active statuses, see
 * routes/profiles.js `/:id/pipeline-potential`), a single student showed
 * >$3,000,000 of "potential funding" that is not obtainable by a person: these
 * are grants awarded to universities / faculty PIs, not to individuals.
 *
 * WHY THE EXISTING NETS MISS IT
 * -----------------------------
 *   - enforceRelevanceFloor only deletes rows with a NON-NULL match_score below
 *     the floor. These institutional grants carry `match_score IS NULL`
 *     (ingested by the funding_api path without a score), and NULL is doctrine-
 *     protected ("no score is not junk"). So the relevance sweep never touches
 *     them.
 *   - There was NO amount-sanity bound anywhere: nothing said "a $650k research
 *     grant is impossible for an individual applicant".
 *
 * THE RULE (amount sanity, profile-type aware)
 * --------------------------------------------
 * For an INDIVIDUAL / student / family / veteran profile ONLY (orgs, businesses,
 * nonprofits, agencies, schools legitimately pursue six- and seven-figure grants
 * and are NEVER touched), a pipeline grant whose `amount_requested` exceeds a
 * realistic individual ceiling is institutional money mis-matched into a person's
 * pipeline and is purged. Same guardrails as the relevance-floor sweep so we can
 * never destroy real work or real money — a row is deleted ONLY when ALL hold:
 *   - amount_requested IS NOT NULL and > ceiling.
 *   - The profile resolves to an INDIVIDUAL type (isIndividualProfileType).
 *   - status is an early/discovery stage (PURGEABLE_DISCOVERY_STATUSES or NULL);
 *     anything in PROTECTED_PIPELINE_STATUSES (submitted, awarded, …) is user
 *     work and is NEVER deleted.
 *   - title/funder does NOT match PROTECTED_NAME_PATTERN (MTSU/portal).
 *   - amount_awarded is NULL / <= 0 (a real recorded award is money in hand and
 *     is preserved even if large).
 *
 * The ceiling defaults to $100,000 (well above any realistic individual grant /
 * scholarship, so the false-positive risk on legitimate aid is ~zero) and is
 * overridable via env INDIVIDUAL_PIPELINE_AMOUNT_CEILING for ops tuning.
 *
 * OVERRIDE: enforcement is ON by default. Set ENFORCE_INDIVIDUAL_AMOUNT_CEILING=0
 * to DISABLE the delete (count-only) without a code change — same posture as
 * ENFORCE_RELEVANCE_FLOOR. Idempotent: once the over-ceiling rows are gone a
 * re-run is a no-op.
 */
const INDIVIDUAL_AMOUNT_CEILING_DEFAULT = 100000

/** Resolve the individual amount ceiling at call time so tests/ops can tune env. */
export function resolveIndividualAmountCeiling() {
  const v = Number.parseInt(process.env.INDIVIDUAL_PIPELINE_AMOUNT_CEILING || '', 10)
  return Number.isFinite(v) && v > 0 ? v : INDIVIDUAL_AMOUNT_CEILING_DEFAULT
}

export async function enforceIndividualAmountCeiling(db) {
  return runInvariant('individual_amount_ceiling', async () => {
    const ceiling = resolveIndividualAmountCeiling()

    // Requires amount_requested + profile_id; degrade silently on legacy schemas.
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('amount_requested') || !grantCols.has('profile_id')) {
      return { scanned: 0, repaired: 0, enforced: true, ceiling, skipped: 'schema' }
    }
    const hasAwarded = grantCols.has('amount_awarded')

    // Profile type columns vary by deployment (prod `profiles` has only
    // primary_type; the matcher prefers applicant_type when present). Probe which
    // exist and build the SELECT dynamically so a missing column can never throw.
    const profileCols = await listProfileColumns(db)
    const typeCols = ['applicant_type', 'primary_type'].filter((c) => profileCols.has(c))
    const typeSelect = typeCols.length
      ? typeCols.map((c) => `p.${c} AS ${c}`).join(', ')
      : 'NULL AS primary_type'

    const awardedGuard = hasAwarded ? 'AND (g.amount_awarded IS NULL OR g.amount_awarded <= 0)' : ''

    // NOTE: unlike the relevance-floor sweep we do NOT pre-exclude by
    // PROTECTED_PIPELINE_STATUSES here, because 'interested' is BOTH a protected
    // name and an early auto-match stage — and the ">$3M" junk is auto-matched
    // 'interested' rows (funding_api auto-set the stage, not a human). Protection
    // is applied in JS via the PURGEABLE_DISCOVERY_STATUSES allowlist, so only
    // early/discovery stages (discovered/discovery/interested/new/matched) can be
    // purged; genuinely-worked stages (gathering_documents, drafting, submitted,
    // awarded, …) are never in the allowlist and always survive.
    let candidates
    try {
      candidates = await db
        .prepare(
          `SELECT g.id, g.title, g.funder, g.status, g.amount_requested, ${typeSelect}
             FROM grants g JOIN profiles p ON p.id = g.profile_id
            WHERE g.amount_requested IS NOT NULL
              AND g.amount_requested > ?
              ${awardedGuard}`,
        )
        .all(ceiling)
    } catch (err) {
      // profiles table absent or unjoinable on a minimal/test schema — nothing to do.
      log.warn('individual_amount_ceiling: candidate query failed (non-fatal)', {
        error: String(err?.message || err),
      })
      return { scanned: 0, repaired: 0, enforced: true, ceiling, skipped: 'query' }
    }

    // Apply the individual-type gate, early-status allowlist, and name guard in
    // JS so they behave identically on SQLite + Postgres. Orgs/businesses (high
    // grant asks are legitimate) and unknown types (conservative: NOT individual)
    // are never touched.
    const purgeable = (candidates || []).filter((r) => {
      const status = (r.status === null || r.status === undefined) ? null : String(r.status)
      const isEarly = status === null || PURGEABLE_DISCOVERY_STATUSES.includes(status)
      if (!isEarly) return false
      if (PROTECTED_NAME_PATTERN.test(`${r.title ?? ''} ${r.funder ?? ''}`)) return false
      const rawType = r.applicant_type || r.primary_type
      return isIndividualProfileType(rawType)
    })

    const violators = purgeable.length
    const disabled = _parseBoolEnv(process.env.ENFORCE_INDIVIDUAL_AMOUNT_CEILING) === false
    if (disabled) {
      if (violators > 0) {
        log.warn('above-ceiling individual pipeline grants present (purge DISABLED via ENFORCE_INDIVIDUAL_AMOUNT_CEILING=0)', {
          violators,
          ceiling,
        })
      }
      return { scanned: violators, repaired: 0, enforced: false, ceiling }
    }

    if (violators === 0) {
      return { scanned: 0, repaired: 0, enforced: true, ceiling }
    }

    const idsToPurge = purgeable.map((r) => r.id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < idsToPurge.length; i += CHUNK) {
      const slice = idsToPurge.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const result = await db.prepare(`DELETE FROM grants WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(result) || slice.length
    }
    if (repaired > 0) {
      log.info('purged above-ceiling grants from individual pipelines (institutional money in a person pipeline)', {
        repaired,
        ceiling,
      })
    }
    return { scanned: violators, repaired, enforced: true, ceiling }
  })
}

/**
 * INVARIANT: EVERY PIPELINE GRANT BELONGS TO A PROFILE
 * (canonical_rules.md G4/G8 — the pipeline is profile-scoped end to end).
 *
 * The whole pipeline is keyed on profile_id: the on-screen board fetches by
 * profile_id, the live matcher ALWAYS stamps profile_id on the grants it
 * creates (opportunityMatcher.js), and every sticky-delete / saved / dismissed
 * tombstone is profile-keyed. A grant with `profile_id IS NULL` is therefore an
 * ORPHAN with three bad properties:
 *
 *   1. It is unreachable from the profile pipeline UI — the user cannot select
 *      or delete it, so it can never be cleaned up by hand ("I deleted them
 *      again and they came back" — they were never reachable to begin with).
 *   2. It is ungovernable by the sticky-delete system — recordDismissal() and
 *      reconcileDismissedGrants() both no-op when profile_id IS NULL, so even a
 *      delete that DID reach it could not make it stay gone.
 *   3. It LEAKS into organization-scoped reads — the org-scoped print/PDF
 *      (PrintPipeline) and org grant lists pull `WHERE organization_id = ?`
 *      with no profile filter, surfacing these orphans the curated board hides.
 *
 * In production these are legacy crawler/import leftovers (raw `discovered`
 * rows, expired `deadline_passed`, automation-advanced rows that never got a
 * profile). The live matcher does not produce them.
 *
 * REPAIR: delete orphan (profile_id IS NULL) grants. GUARDRAIL (mirror the
 * relevance-floor sweep's "never destroy a real outcome"): a row that records
 * an actual AWARD (amount_awarded > 0) is real money and is preserved even
 * without a profile, so an org-level awarded grant is never collateral damage.
 *
 * OVERRIDE: enforcement is ON by default. Set ENFORCE_PROFILE_SCOPED_PIPELINE=0
 * to DISABLE the delete (count-only) without a code change — same posture as
 * ENFORCE_RELEVANCE_FLOOR.
 */
export async function enforceProfileScopedPipeline(db) {
  return runInvariant('profile_scoped_pipeline', async () => {
    // Orphan = no profile AND no recorded award. amount_awarded may be absent
    // on very old schemas; tolerate that by treating a missing column as "no
    // award" via a guarded probe so this can never abort boot.
    const safeOrphanWhereClause = `profile_id IS NULL AND (amount_awarded IS NULL OR amount_awarded <= 0)`

    let violators = 0
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM grants WHERE ${safeOrphanWhereClause}`).get()
      violators = Number(row?.n ?? 0)
    } catch (err) {
      // amount_awarded column missing on a legacy DB — fall back to the
      // profile-only predicate so the invariant still holds.
      const msg = String(err?.message || '')
      if (/amount_awarded|no such column|does not exist/i.test(msg)) {
        const row = await db.prepare('SELECT COUNT(*) AS n FROM grants WHERE profile_id IS NULL').get()
        violators = Number(row?.n ?? 0)
        const disabledLegacy = _parseBoolEnv(process.env.ENFORCE_PROFILE_SCOPED_PIPELINE) === false
        if (disabledLegacy) {
          if (violators > 0) log.warn('orphan profile-less grants present (purge DISABLED)', { violators })
          return { scanned: violators, repaired: 0, enforced: false }
        }
        if (violators === 0) return { scanned: 0, repaired: 0, enforced: true }
        const res = await db.prepare('DELETE FROM grants WHERE profile_id IS NULL').run()
        const removed = changesOf(res)
        if (removed > 0) log.info('purged orphan profile-less pipeline grants (legacy schema)', { removed })
        return { scanned: violators, repaired: removed, enforced: true }
      }
      throw err
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_PROFILE_SCOPED_PIPELINE) === false
    if (disabled) {
      if (violators > 0) {
        log.warn('orphan profile-less grants present (purge DISABLED via ENFORCE_PROFILE_SCOPED_PIPELINE=0)', {
          violators,
        })
      }
      return { scanned: violators, repaired: 0, enforced: false }
    }

    if (violators === 0) {
      return { scanned: 0, repaired: 0, enforced: true }
    }

    const result = await db.prepare(`DELETE FROM grants WHERE ${safeOrphanWhereClause}`).run()
    const repaired = changesOf(result)
    if (repaired > 0) {
      log.info('purged orphan profile-less pipeline grants', { repaired })
    }
    return { scanned: violators, repaired, enforced: true }
  })
}

/**
 * INVARIANT: PROFILE display_name IS NEVER A DOUBLED NAME
 * (data-integrity — a person's name appears ONCE).
 *
 * The profile-merge path (services/profileDedupeService.js) historically JOINED
 * two overlapping forms of the same name when it merged two profiles'
 * basic_information.full_name — e.g. "Jordan Lane" + "Jordan Michael Lane"
 * became "Jordan Lane\nJordan Michael Lane", which synced into
 * profiles.display_name and rendered as "Jordan Lane Jordan Michael Lane" in
 * the profile header AND the generated Pipeline Potential Breakdown PDF title.
 *
 * The producer is now fixed (mergeValues collapses person-name fields), but this
 * sweep is the NET: it repairs EVERY already-doubled name on boot, regardless of
 * which path created it, so no row needs a hand-edit. It uses the SAME shared
 * collapser the producer uses (dedupeProfileDisplayName), so the two can never
 * drift, and that collapser is deliberately conservative — it only touches a
 * value when it is provably a doubled personal name (exact whole-string repeat,
 * or two halves sharing first+last where one is a fuller form). Org names and
 * legitimately-repeated/compound names are left untouched, so this can never
 * mangle a real name. It also strips any stray internal newline so a display
 * name never contains a literal "\n".
 *
 * BOTH fields are repaired in lockstep: profiles.display_name AND the
 * basic_information section's full_name (profile_sections.section_key =
 * 'basic_information', JSON field full_name) — production doubled them together,
 * so fixing only one would leave the pair inconsistent (and a later display-name
 * ↔ full_name sync could re-double).
 *
 * Idempotent: a collapsed name is not doubled, so a re-run is a no-op.
 */
export async function enforceProfileDisplayNameNotDoubled(db) {
  return runInvariant('profile_display_name_not_doubled', async () => {
    let scanned = 0
    let repairedDisplayName = 0
    let repairedFullName = 0

    // ── 1. profiles.display_name ──────────────────────────────────────────────
    let rows
    try {
      rows = await db
        .prepare("SELECT id, display_name FROM profiles WHERE display_name IS NOT NULL AND TRIM(display_name) <> ''")
        .all()
    } catch (err) {
      // profiles table / display_name column absent on a very old/test schema —
      // nothing to repair; degrade silently like the other sweeps.
      const msg = String(err?.message || '')
      if (/no such (table|column)|does not exist|relation .* does not exist/i.test(msg)) {
        return { scanned: 0, repaired: 0 }
      }
      throw err
    }
    scanned += (rows || []).length
    for (const row of rows || []) {
      const current = String(row.display_name)
      const collapsed = dedupeProfileDisplayName(current)
      // Compare against the RAW stored value: only repair when the collapser
      // actually changed it (removed a double or a stray newline) — both are safe.
      if (collapsed !== current) {
        const result = await db
          .prepare('UPDATE profiles SET display_name = ? WHERE id = ?')
          .run(collapsed, row.id)
        repairedDisplayName += changesOf(result) || 1
      }
    }

    // ── 2. basic_information.full_name (doubled in lockstep with display_name) ──
    // Best-effort: profile_sections may be absent on a minimal/test schema.
    let sectionRows = []
    try {
      sectionRows = await db
        .prepare("SELECT profile_id, data FROM profile_sections WHERE section_key = 'basic_information'")
        .all()
    } catch {
      sectionRows = []
    }
    scanned += (sectionRows || []).length
    for (const row of sectionRows || []) {
      let data
      try {
        data = typeof row.data === 'object' && row.data ? row.data : JSON.parse(row.data || '{}')
      } catch {
        continue // unparseable section — leave it untouched
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const current = data.full_name
      if (typeof current !== 'string' || current.trim() === '') continue
      const collapsed = dedupeProfileDisplayName(current)
      if (collapsed === current) continue
      const nextData = { ...data, full_name: collapsed }
      const result = await db
        .prepare("UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = 'basic_information'")
        .run(JSON.stringify(nextData), row.profile_id)
      repairedFullName += changesOf(result) || 1
    }

    const repaired = repairedDisplayName + repairedFullName
    if (repaired > 0) {
      log.info('collapsed doubled profile names', {
        repaired,
        display_name: repairedDisplayName,
        full_name: repairedFullName,
        scanned,
      })
    }
    return { scanned, repaired, repairedDisplayName, repairedFullName }
  })
}

/**
 * ─────────────────────────────────────────────────────────────────────────
 * INVARIANT: ONE CANONICAL INCOME PER INDIVIDUAL PROFILE
 * (income data-integrity — need-based eligibility matching).
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE BUG THIS CLOSES
 * -------------------
 * A profile's data lives in `profile_sections` rows keyed by `section_key`.
 * The SAME logical field (household_income) is, in legacy/AI-written data,
 * present in TWO different sections that disagree:
 *   - section_key 'financial'             → household_income "$310,000"
 *   - section_key 'financial_information' → household_income 28000, low_income true
 * The high figure is typically a PARENT's / whole-household income that got
 * captured onto a dependent student's own profile (e.g. extracted from a FAFSA
 * or university award letter), while the low figure is the STUDENT APPLICANT'S
 * own income that is consistent with the need flags.
 *
 * WHY IT MATTERS
 * --------------
 * Need-based eligibility is decided from income. The canonical matcher signal
 * builder (buildProfileSignals in services/profileHelpers.js) reads ONLY
 * `sections.financial_information.household_income`, but MANY other readers fall
 * back to the legacy `sections.financial` (e.g. needsBasedQueryExpander.js:925,
 * benefitEligibilityService.js:83, medicalNecessity.js:77, applyEngine.js:1613,
 * profileNormalizer.js:889 — all `financial_information || financial`). So WHICH
 * income a code path sees depends on which section happens to be populated. An
 * inflated parent figure silently makes a needy student look wealthy and stops
 * them matching need-based aid. The canonical section is `financial_information`
 * (config/profileSchema.js); `financial` is a legacy alias.
 *
 * THE RECONCILIATION RULE (conservative; owner directive:
 * "count the individual's own income, not a parent's; the lower one is the
 * student's")
 * -------------------------------------------------------------------------
 * For INDIVIDUAL / student / family / veteran profiles ONLY (orgs/businesses
 * are never touched — high revenue there is legitimate), when the two sections
 * carry CONFLICTING incomes we collapse to ONE canonical value and write it to
 * `financial_information` (the section the matcher trusts), keeping the legacy
 * `financial` section in agreement so no future reader can pick the wrong one:
 *
 *   - If the profile carries a NEED SIGNAL (low_income true, a High/Critical/
 *     Extreme financial_need_level, below_poverty_line, OR a sub-$50k income in
 *     either section), the canonical income is the LOWER of the two figures —
 *     the applicant's own income, consistent with the need flags. The need
 *     flags are preserved.
 *   - If there is NO need signal either way (both figures look comfortable and
 *     nothing marks need), the conflict is genuinely AMBIGUOUS — we do NOT guess
 *     which is the applicant's own. We LOG it for human review and leave the
 *     data untouched (prefer human review over corrupting data).
 *
 * We never invent income, never raise an income, never touch a profile with no
 * contradiction, and never touch org/business/nonprofit profiles. Idempotent:
 * once the two sections agree there is no conflict, so a re-run is a no-op.
 *
 * Best-effort about schema: profile_sections may be absent on a minimal/test
 * DB; we degrade silently (zero repairs) like the other sweeps.
 */

/** Canonical financial section the matcher trusts; `financial` is the legacy alias. */
const INCOME_CANONICAL_SECTION = 'financial_information'
const INCOME_LEGACY_SECTION = 'financial'

/**
 * Parent categories that mean "this profile is a PERSON / household", not an
 * organization. A profile is treated as INDIVIDUAL iff its resolved type (or any
 * ancestor in its parent chain) is one of these AND it never rolls up to an
 * org category. Resolved via profileTypeRegistry so it tracks new person types.
 */
const INDIVIDUAL_ROOT_TYPES = Object.freeze(['individual', 'family', 'student', 'veteran'])
const ORG_ROOT_TYPES = Object.freeze([
  'business', 'nonprofit', 'public_agency', 'local_government', 'school',
  'school_district', 'church', 'library',
])

/**
 * Decide whether a raw profile type string denotes an individual/household.
 * Conservative: an UNKNOWN type returns false (we'd rather skip than risk
 * touching an org). A type that rolls up to BOTH an individual and an org root
 * (shouldn't happen in the registry) is treated as NOT individual.
 */
function isIndividualProfileType(rawType) {
  const id = resolveProfileType(rawType)
  if (!id) return false
  const chain = [id, ...getParentChain(id)]
  if (chain.some((t) => ORG_ROOT_TYPES.includes(t))) return false
  return chain.some((t) => INDIVIDUAL_ROOT_TYPES.includes(t))
}

/**
 * Robustly parse a stored income value into a finite number, or null.
 * Handles plain numbers (28000), numeric strings ("28000"), and currency-
 * formatted strings ("$310,000", "$28,000.00"). Returns null for empty/
 * non-numeric/negative values. NOTE: the matcher's own parseNumber() does NOT
 * strip "$"/"," so a value like "$310,000" reads as null there — another reason
 * to normalize to a clean number here.
 */
function parseIncomeValue(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null
  const cleaned = String(value).replace(/[$,\s]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Pull the income figure a section advertises: household_income first, then
 * annual_income (the matcher's documented fallback order).
 */
function sectionIncome(section) {
  if (!section || typeof section !== 'object') return null
  return parseIncomeValue(section.household_income) ?? parseIncomeValue(section.annual_income)
}

/** True if EITHER section carries an explicit/derivable financial-need signal. */
function hasNeedSignal(sections, incomes) {
  const NEED_LEVELS = new Set(['high', 'critical', 'extreme'])
  for (const s of sections) {
    if (!s || typeof s !== 'object') continue
    if (s.low_income === true || s.low_income === 'yes') return true
    if (s.below_poverty_line === true || s.below_poverty_line === 'yes') return true
    const level = String(s.financial_need_level ?? '').trim().toLowerCase()
    if (NEED_LEVELS.has(level)) return true
  }
  // A sub-$50k figure (the matcher's own low-income threshold) is itself a need
  // signal: it means at least one of the recorded incomes belongs to someone of
  // modest means, so the LOWER value is the safe, need-consistent choice.
  return incomes.some((n) => n !== null && n < 50000)
}

/**
 * Return the set of column names on the `profiles` table for the active
 * dialect. Same dialect-agnostic / defensive contract as listGrantColumns:
 * any probe failure yields an empty set so callers degrade gracefully.
 */
async function listProfileColumns(db) {
  try {
    if ((db?.dialect || 'sqlite') === 'postgres') {
      const rows = await db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'profiles'`,
        )
        .all()
      return new Set((rows || []).map((r) => String(r.column_name)))
    }
    const cols = await db.prepare('PRAGMA table_info(profiles)').all()
    return new Set((cols || []).map((c) => String(c.name)))
  } catch {
    return new Set()
  }
}

export async function enforceProfileIncomeReconciliation(db) {
  return runInvariant('profile_income_reconciliation', async () => {
    // Load every profile's type plus both financial sections in one pass.
    // The type columns vary by deployment: prod `profiles` has only
    // `primary_type` (no `applicant_type`), while the matcher prefers
    // applicant_type when present. We probe which type columns exist and build
    // the SELECT dynamically so a MISSING column can never throw — selecting a
    // hard-coded missing column would otherwise trip the catch below and
    // SILENTLY DISABLE the whole invariant in prod. profile_sections may be
    // absent on a very old/test schema → degrade to 0.
    const profileCols = await listProfileColumns(db)
    const typeCols = ['applicant_type', 'primary_type'].filter((c) => profileCols.has(c))
    const selectCols = ['id', ...typeCols].join(', ')
    let profileRows
    try {
      profileRows = await db.prepare(`SELECT ${selectCols} FROM profiles`).all()
    } catch (err) {
      const msg = String(err?.message || '')
      if (/no such (table|column)|does not exist|relation .* does not exist/i.test(msg)) {
        return { scanned: 0, repaired: 0, flagged: 0 }
      }
      throw err
    }

    let sectionRows = []
    try {
      sectionRows = await db
        .prepare(
          `SELECT profile_id, section_key, data FROM profile_sections
           WHERE section_key IN (?, ?)`,
        )
        .all(INCOME_CANONICAL_SECTION, INCOME_LEGACY_SECTION)
    } catch {
      return { scanned: 0, repaired: 0, flagged: 0 }
    }

    // Index the two financial sections per profile.
    const byProfile = new Map()
    const parseData = (raw) => {
      try {
        return typeof raw === 'object' && raw ? raw : JSON.parse(raw || '{}')
      } catch {
        return null
      }
    }
    for (const row of sectionRows) {
      const data = parseData(row.data)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      if (!byProfile.has(row.profile_id)) byProfile.set(row.profile_id, {})
      byProfile.get(row.profile_id)[row.section_key] = data
    }

    let scanned = 0
    let repaired = 0
    let flagged = 0
    for (const profile of profileRows) {
      const pair = byProfile.get(profile.id)
      if (!pair) continue // no financial sections at all
      const canonical = pair[INCOME_CANONICAL_SECTION]
      const legacy = pair[INCOME_LEGACY_SECTION]
      // A conflict needs BOTH sections present with a parseable income each.
      if (!canonical || !legacy) continue
      const canonicalIncome = sectionIncome(canonical)
      const legacyIncome = sectionIncome(legacy)
      if (canonicalIncome === null || legacyIncome === null) continue
      if (canonicalIncome === legacyIncome) continue // no contradiction
      scanned += 1

      // ORGS ARE OFF-LIMITS: high revenue is legitimate for a business/nonprofit.
      const rawType = profile.applicant_type || profile.primary_type
      if (!isIndividualProfileType(rawType)) continue

      const incomes = [canonicalIncome, legacyIncome]
      if (!hasNeedSignal([canonical, legacy], incomes)) {
        // Genuinely ambiguous: two comfortable incomes, no need flag to say which
        // is the applicant's own. Do NOT guess — flag for human review.
        flagged += 1
        log.warn('ambiguous income conflict left for human review (no need signal)', {
          profileId: profile.id,
          canonicalIncome,
          legacyIncome,
        })
        continue
      }

      // Need-consistent reconciliation: the applicant's OWN income is the LOWER
      // of the two (a parent/household figure is the inflated one). Write it to
      // the canonical section the matcher trusts, and bring the legacy section
      // into agreement so no fallback reader can resurface the inflated value.
      const ownIncome = Math.min(canonicalIncome, legacyIncome)
      const before = { canonicalIncome, legacyIncome }

      const nextCanonical = { ...canonical, household_income: ownIncome }
      // Keep the low-income flag truthful when the reconciled income is low.
      if (ownIncome < 50000) nextCanonical.low_income = true
      const nextLegacy = { ...legacy, household_income: ownIncome }
      if (ownIncome < 50000) nextLegacy.low_income = true

      await db
        .prepare(
          'UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?',
        )
        .run(JSON.stringify(nextCanonical), profile.id, INCOME_CANONICAL_SECTION)
      await db
        .prepare(
          'UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?',
        )
        .run(JSON.stringify(nextLegacy), profile.id, INCOME_LEGACY_SECTION)
      repaired += 1
      log.info('reconciled conflicting profile income (kept applicant own/lower)', {
        profileId: profile.id,
        before,
        after: { household_income: ownIncome },
      })
    }

    if (repaired > 0 || flagged > 0) {
      log.info('[income-reconciliation] summary', { scanned, repaired, flagged })
    }
    return { scanned, repaired, flagged }
  })
}

/**
 * INVARIANT: INDIVIDUAL/ORG SECTION CONFLICT (the Kimberly Botts class, found
 * 2026-07-06). A bad Base44/AI-enrichment import can hallucinate an
 * organization identity (organization_details.organization_type: "nonprofit",
 * a small_business_details.business_name) onto a person-type profile
 * (individual/family/student/veteran). resolveEffectiveProfileType()
 * (profileHelpers.js) treats organization_details.organization_type as MORE
 * specific than a generic 'individual'/'family' primary_type and promotes the
 * whole profile — and its buildThesis() applicant_types — to an org, which
 * then surfaces institutional federal RFPs instead of individual-benefit
 * programs and can hard-reject genuinely eligible individual opportunities
 * via the applicant-type gate.
 *
 * A later correction pass sometimes fixes the free-text `occupation.notes`
 * ("Not a business owner, not a nonprofit employee...") and the STRUCTURED
 * `occupation.nonprofit_employee` / `occupation.small_business_owner` flags,
 * but never clears the org_details/small_business_details fields those flags
 * directly contradict. That structured contradiction (occupation says
 * nonprofit_employee=false AND small_business_owner=false, while
 * organization_details still declares an organization_type) is the ONLY
 * trigger here — deliberately conservative, text-free, and structured-signal-
 * only, matching enforceProfileIncomeReconciliation's posture. A person-type
 * profile that genuinely ALSO runs a nonprofit/business (no such flags, or
 * flags left true/absent) is never touched — ambiguous cases are left alone,
 * same as the income conflict's "no need signal" case.
 */
export async function enforceIndividualOrgSectionConflict(db) {
  return runInvariant('individual_org_section_conflict', async () => {
    const profileCols = await listProfileColumns(db)
    const typeCols = ['applicant_type', 'primary_type'].filter((c) => profileCols.has(c))
    if (typeCols.length === 0) return { scanned: 0, repaired: 0, flagged: 0 }
    const selectCols = ['id', ...typeCols].join(', ')

    let profileRows
    try {
      profileRows = await db.prepare(`SELECT ${selectCols} FROM profiles`).all()
    } catch (err) {
      const msg = String(err?.message || '')
      if (/no such (table|column)|does not exist|relation .* does not exist/i.test(msg)) {
        return { scanned: 0, repaired: 0, flagged: 0 }
      }
      throw err
    }

    let sectionRows = []
    try {
      sectionRows = await db
        .prepare(
          `SELECT profile_id, section_key, data FROM profile_sections
           WHERE section_key IN (?, ?, ?)`,
        )
        .all('organization_details', 'occupation', 'small_business_details')
    } catch {
      return { scanned: 0, repaired: 0, flagged: 0 }
    }

    const byProfile = new Map()
    const parseData = (raw) => {
      try {
        return typeof raw === 'object' && raw ? raw : JSON.parse(raw || '{}')
      } catch {
        return null
      }
    }
    for (const row of sectionRows) {
      const data = parseData(row.data)
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      if (!byProfile.has(row.profile_id)) byProfile.set(row.profile_id, {})
      byProfile.get(row.profile_id)[row.section_key] = data
    }

    let scanned = 0
    let repaired = 0
    let flagged = 0
    for (const profile of profileRows) {
      const rawType = profile.applicant_type || profile.primary_type
      if (!isIndividualProfileType(rawType)) continue // ORGS ARE OFF-LIMITS

      const sections = byProfile.get(profile.id)
      if (!sections) continue
      const orgDetails = sections.organization_details
      if (!orgDetails || typeof orgDetails !== 'object') continue
      const orgType = String(orgDetails.organization_type || '').trim()
      if (!orgType) continue
      scanned += 1

      const occupation = sections.occupation
      // THE INVERSE CASE (the Anita class, 2026-08-01). A person who runs a
      // FARM is a person who legitimately IS also a business — the exact
      // mirror image of Kimberly Botts. Many farmers tick `occupation.farmer`
      // and leave `small_business_owner` at its schema DEFAULT of false: they
      // are farmers, not "small business owners". That default-false is not a
      // denial, and treating it as one would WIPE a real farm identity
      // (organization_details.organization_type + small_business_details.
      // business_name), which is precisely what makes USDA/FSA/NRCS/SARE
      // programs reachable through the applicant-type gate. A declared farm
      // identity therefore means the structured denial is INCOMPLETE, and the
      // profile falls into the module's existing "ambiguous → log for human
      // review, never change" branch.
      const declaresFarm = hasFarmIdentity({ profile, sections })
      const contradicts =
        occupation && typeof occupation === 'object' &&
        occupation.nonprofit_employee === false &&
        occupation.small_business_owner === false &&
        !declaresFarm
      if (!contradicts) {
        // Genuinely ambiguous: no explicit structured denial. Do NOT guess —
        // this person-type profile may legitimately also run the org.
        flagged += 1
        log.warn('ambiguous individual/org section conflict left for human review (no structured denial)', {
          profileId: profile.id,
          orgType,
          declaresFarm,
        })
        continue
      }

      const nextOrgDetails = { ...orgDetails, organization_type: null }
      await db
        .prepare('UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?')
        .run(JSON.stringify(nextOrgDetails), profile.id, 'organization_details')

      const smallBiz = sections.small_business_details
      if (smallBiz && typeof smallBiz === 'object' && smallBiz.business_name) {
        const nextSmallBiz = { ...smallBiz, business_name: null }
        await db
          .prepare('UPDATE profile_sections SET data = ? WHERE profile_id = ? AND section_key = ?')
          .run(JSON.stringify(nextSmallBiz), profile.id, 'small_business_details')
      }

      repaired += 1
      log.info('cleared contradicted org-section fields on individual-type profile', {
        profileId: profile.id,
        clearedOrgType: orgType,
      })
    }

    if (repaired > 0 || flagged > 0) {
      log.info('[individual-org-conflict] summary', { scanned, repaired, flagged })
    }
    return { scanned, repaired, flagged }
  })
}

/**
 * INVARIANT: PROFILE_ID INTEGRITY (canonical_rules.md — profile-scoped pipeline;
 * every grant/task binds to a REAL profile, by its canonical id).
 *
 * Deferred work (crawler jobs, Hamilton tasks) and older inserts can stamp a
 * grant/application_task with a DESIGNATED-PROFILE SLUG (e.g. 'profile-brian-client')
 * instead of the profile's live canonical UUID. The slug is the same person, but
 * the stale value (a) makes "scored against / save portal login" bind to a slug
 * the UI can't resolve, and (b) drifts the row out of the canonical-id pipeline.
 *
 * REPAIR (normalize, never delete): resolve each known designated slug ONCE to its
 * live profile id (via the same resolver the dispatcher uses) and rewrite any
 * grant/application_task carrying the slug to the canonical id. We deliberately do
 * NOT null/delete dangling-but-unmappable ids here — that would risk a cascade with
 * enforceProfileScopedPipeline (which purges NULL-profile orphans). Unmappable rows
 * are scoped to a non-existent profile, so they never surface in a real pipeline;
 * they're left for human review rather than auto-destroyed (safety posture above).
 */
export async function enforceProfileIdIntegrity(db) {
  return runInvariant('profile_id_integrity', async () => {
    const slugs = (Array.isArray(DESIGNATED_PROFILES) ? DESIGNATED_PROFILES : [])
      .map((p) => String(p?.id || '').trim())
      .filter(Boolean)
    if (slugs.length === 0) return { repaired: 0, scanned: 0 }

    // Resolve each designated slug to its live canonical id ONCE (read-only — no
    // reseed during a sweep). Only keep slugs whose canonical id actually differs
    // (i.e. the profile lives under a UUID, so the slug is stale).
    const slugToCanonical = new Map()
    for (const slug of slugs) {
      let resolved = null
      try {
        resolved = await resolveProfileForId(db, slug, { allowReseed: false })
      } catch {
        resolved = null
      }
      if (resolved && resolved.resolvedId && String(resolved.resolvedId) !== slug) {
        slugToCanonical.set(slug, String(resolved.resolvedId))
      }
    }
    if (slugToCanonical.size === 0) return { repaired: 0, scanned: slugs.length }

    // Tables that carry a profile_id we should normalize. application_tasks may
    // not exist on every DB/dialect — guard each UPDATE so a missing table is a
    // silent skip, not a boot failure.
    const tables = ['grants', 'application_tasks']
    let repaired = 0
    for (const table of tables) {
      for (const [slug, canonical] of slugToCanonical) {
        try {
          const res = await db
            .prepare(`UPDATE ${table} SET profile_id = ? WHERE profile_id = ?`)
            .run(canonical, slug)
          repaired += changesOf(res)
        } catch {
          // table absent on this dialect/DB — skip
        }
      }
    }
    if (repaired > 0) {
      log.info('normalized stale designated-slug profile_ids to canonical ids', {
        repaired,
        slugsMapped: slugToCanonical.size,
      })
    }
    return { repaired, scanned: slugs.length }
  })
}

/**
 * Return the column names on `profile_opportunity_matches` for the active
 * dialect. Same dialect-agnostic / defensive contract as listGrantColumns.
 */
async function listMatchColumns(db) {
  try {
    if ((db?.dialect || 'sqlite') === 'postgres') {
      const rows = await db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'profile_opportunity_matches'`,
        )
        .all()
      return new Set((rows || []).map((r) => String(r.column_name)))
    }
    const cols = await db.prepare('PRAGMA table_info(profile_opportunity_matches)').all()
    return new Set((cols || []).map((c) => String(c.name)))
  } catch {
    return new Set()
  }
}

/** Score a demoted match is forced BELOW the display floor to so it stops
 *  surfacing. Canonical DEMOTED_MATCH_SCORE sits below REVIEW and the
 *  pipeline bar on the live scale (the old hardcoded 10 ended up ABOVE the
 *  8 bar when the scale changed, so demoted rows kept surfacing). */
const STUDENT_AID_DEMOTE_SCORE = DEMOTED_MATCH_SCORE

/**
 * INVARIANT: STUDENT-AID OPPORTUNITIES DO NOT SURFACE TO A NON-STUDENT PROFILE
 * (canonical_rules.md eligibility realism — a person is only matched to funding
 * they can actually apply for).
 *
 * THE BUG THIS CLOSES
 * -------------------
 * A `profile_opportunity_matches` row carries a PERSISTED decision + score. The
 * canonical match engine already caps a student-aid opportunity (TN HOPE, FAFSA,
 * Pell, TSAA, foundation scholarships…) BELOW the display floor for a non-student
 * profile (services/matchEngine.js — STUDENT_AID_NONSTUDENT_CAP + REJECT), so a
 * FRESH score never surfaces one. But two facts combine into a live defect:
 *   1. The decision is persisted and never re-scored when the engine improves
 *      (matching logic is versioned, the stored row is not).
 *   2. `web-llm` rows are DELIBERATELY excluded from the crawler-os reconcile
 *      DELETE + xmatch cleanup (so real web scholarships are never wiped), which
 *      means a stale `web-llm` ACCEPT is NEVER recomputed.
 * Result: a senior widow (Liubov Samoylenko, `individual`, is_student=false) kept
 * surfacing 13 stale `web-llm` scholarship ACCEPTs (81/accept, computed a week
 * earlier under older logic) even though the CURRENT engine REJECTs/caps every
 * one of them. `qualifiesForDisplay` surfaces any ACCEPT regardless of score, so
 * the stale ACCEPT alone kept them visible.
 *
 * WHY THE OTHER NETS MISS IT
 * --------------------------
 *   - This lives in `profile_opportunity_matches` (the DISCOVERY/surface table),
 *     not `grants` (the pipeline) — the relevance-floor / orphan / amount sweeps
 *     only touch `grants`.
 *   - pipelineEligibilitySweep uses the applicant-type gate, which treats
 *     student == individual (a scholarship stamped applicant_types=['individual']
 *     is NOT an applicant-type mismatch), so it cannot detect this class.
 *
 * THE RULE (re-assert the engine's OWN decision at the persisted layer)
 * --------------------------------------------------------------------
 * A surfaced student-aid match is demoted (decision→reject, score→below floor)
 * when — and ONLY when — the profile is one the engine's cap already fires for:
 *   - the opportunity is a student-aid opportunity (same predicate the engine
 *     uses: isStudentAidOpportunity), AND
 *   - the profile is NOT a student (thesis.is_student false), AND
 *   - the profile does NOT declare a student-aid NEED (scholarship / student_aid
 *     / cost_of_attendance) — this mirrors the engine's `!wantsStudentAid` arm,
 *     so an adult learner who genuinely wants aid is preserved.
 * A real student (Anastasia White) and an aid-seeking adult are NEVER touched, so
 * this raises PRECISION without lowering recall. Directory/referral rows (mission
 * rule: directories always survive) are exempt.
 *
 * REPAIR is a DEMOTION, not a delete: the row is kept (reversible — a future
 * legitimate re-crawl re-scores it) but forced below the display floor so
 * `qualifiesForDisplay` hides it. Idempotent: a demoted row no longer qualifies,
 * so a re-run is a no-op.
 *
 * OVERRIDE: ON by default. Set ENFORCE_STUDENT_AID_ELIGIBILITY=0 for count-only.
 */
export async function enforceStudentAidEligibility(db, { resolveThesis = null } = {}) {
  return runInvariant('student_aid_eligibility', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('match_score') || !matchCols.has('match_decision')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }

    // Lazy imports so a boot-time module cycle can never abort the sweep, and so
    // the SAME predicate/floor the live engine + surfacing paths use is reused
    // here (no re-encoding → no drift). All are already loaded in a running app.
    // resolveThesis is injectable for tests (default: the live thesis builder).
    let DEFAULT_MIN_SCORE, SURFACED_MATCHER_VERSIONS_SQL, isStudentAidOpportunity, buildThesisForProfile
    try {
      ;({ DEFAULT_MIN_SCORE } = await import('../config/matchThresholds.js'))
      ;({ SURFACED_MATCHER_VERSIONS_SQL } = await import('../config/matchSurfacing.js'))
      ;({ isStudentAidOpportunity } = await import('../services/matchEngine.js'))
      if (!resolveThesis) ({ buildThesisForProfile } = await import('../services/crawlerOsService.js'))
    } catch (err) {
      log.warn('student_aid_eligibility: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const floor = Number(DEFAULT_MIN_SCORE) || 75

    // Candidate SURFACED student-aid-ish matches. A cheap SQL prefilter narrows to
    // scholarship/student/tuition/FAFSA/Pell titles (or student-aid categories);
    // isStudentAidOpportunity refines in JS. Only rows that WOULD surface
    // (qualifiesForDisplay = ACCEPT decision OR score >= floor) are candidates —
    // a buried REVIEW is already hidden. Directories are exempt (always survive).
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, m.match_score, m.match_decision,
                  o.title, o.description, o.categories
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
            WHERE m.matcher_version IN ${SURFACED_MATCHER_VERSIONS_SQL}
              AND (UPPER(COALESCE(m.match_decision,'')) = 'ACCEPT' OR m.match_score >= ?)
              AND UPPER(COALESCE(o.opportunity_kind,'')) NOT IN ('DIRECTORY','PAST_AWARD_INTEL')
              AND (
                lower(COALESCE(o.title,'')) LIKE '%scholar%'
                OR lower(COALESCE(o.title,'')) LIKE '%student%'
                OR lower(COALESCE(o.title,'')) LIKE '%tuition%'
                OR lower(COALESCE(o.title,'')) LIKE '%fafsa%'
                OR lower(COALESCE(o.title,'')) LIKE '%pell%'
                OR lower(COALESCE(o.title,'')) LIKE '%financial aid%'
                OR lower(COALESCE(o.title,'')) LIKE '%hope%'
                OR lower(COALESCE(o.title,'')) LIKE '%promise%'
                OR lower(COALESCE(o.title,'')) LIKE '%reconnect%'
                OR lower(COALESCE(o.categories,'')) LIKE '%scholar%'
                OR lower(COALESCE(o.categories,'')) LIKE '%student_aid%'
                OR lower(COALESCE(o.categories,'')) LIKE '%cost_of_attendance%'
              )`,
        )
        .all(floor)
    } catch (err) {
      // profile_opportunity_matches / funding_opportunities absent on a minimal
      // test DB, or opportunity_kind/description/categories missing — degrade to 0.
      log.warn('student_aid_eligibility: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    // Refine to genuine student-aid opportunities and group by profile.
    const byProfile = new Map()
    for (const r of rows || []) {
      if (!isStudentAidOpportunity({ title: r.title, description: r.description, categories: r.categories }, null)) continue
      if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
      byProfile.get(r.profile_id).push(r)
    }
    if (byProfile.size === 0) return { scanned: 0, repaired: 0, enforced: true, profilesAffected: 0 }

    // Decide per profile using the thesis (drift-free: same is_student the
    // discovery/matching path derives). A student, or a non-student who declares
    // a student-aid need, is exempt — mirroring the engine's cap condition.
    const disabled = _parseBoolEnv(process.env.ENFORCE_STUDENT_AID_ELIGIBILITY) === false
    const STUDENT_AID_NEEDS = new Set(['student_aid', 'cost_of_attendance', 'scholarship'])
    const hasExplanationCol = matchCols.has('match_explanation')
    const hasUpdatedAtCol = matchCols.has('updated_at')

    let scanned = 0
    let repaired = 0
    const affected = []
    const getThesis = resolveThesis || buildThesisForProfile
    for (const [profileId, matchRows] of byProfile) {
      let thesis = null
      try { thesis = await getThesis(db, profileId) } catch { thesis = null }
      if (!thesis) continue // can't establish student status → do not touch (safe)
      const isStudent = Boolean(thesis.is_student)
      const wantsAid = Array.isArray(thesis.needs) && thesis.needs.some((n) => STUDENT_AID_NEEDS.has(String(n)))
      if (isStudent || wantsAid) continue // legitimately eligible — leave alone
      scanned += matchRows.length
      if (disabled) continue

      for (const r of matchRows) {
        const cur = Number(r.match_score)
        const newScore = Number.isFinite(cur) ? Math.min(cur, STUDENT_AID_DEMOTE_SCORE) : STUDENT_AID_DEMOTE_SCORE
        const sets = ['match_decision = ?', 'match_score = ?']
        const args = ['reject', newScore]
        if (hasExplanationCol) {
          sets.push('match_explanation = ?')
          args.push('Demoted by student_aid_eligibility invariant: student-aid opportunity surfaced to a non-student profile (engine caps these below the display floor).')
        }
        if (hasUpdatedAtCol) {
          sets.push('updated_at = ?')
          args.push(new Date().toISOString())
        }
        args.push(r.match_id)
        try {
          const res = await db.prepare(`UPDATE profile_opportunity_matches SET ${sets.join(', ')} WHERE id = ?`).run(...args)
          repaired += changesOf(res) || 1
        } catch (err) {
          log.warn('student_aid_eligibility: demote failed for match (non-fatal)', { match: r.match_id, error: String(err?.message || err) })
        }
      }
      affected.push({ profileId, demoted: matchRows.length })
    }

    if (disabled) {
      if (scanned > 0) log.warn('student-aid matches on non-student profiles present (demote DISABLED via ENFORCE_STUDENT_AID_ELIGIBILITY=0)', { scanned, profiles: affected.length })
      return { scanned, repaired: 0, enforced: false, profilesAffected: affected.length }
    }
    if (repaired > 0) {
      log.info('demoted student-aid matches surfaced to non-student profiles', {
        repaired,
        profilesAffected: affected.length,
        sample: affected.slice(0, 10),
      })
    }
    return { scanned, repaired, enforced: true, profilesAffected: affected.length }
  })
}

/**
 * INVARIANT: A BLOCKED HAMILTON TASK WHOSE BLOCKER NO LONGER REPRODUCES IS
 * RE-QUEUED (Hamilton lifecycle self-heal — "automation is king": a fixed
 * cause must not leave its casualties stranded).
 *
 * THE BUGS THIS CLOSES
 * --------------------
 * 1. STALE FALSE-BLOCKS. Preflight once raised FALSE "Profile is missing
 *    first name / last name / email" hard stops (display_name parsing bug,
 *    fixed 2026-06-20 in hamiltonPreflight). The producer is fixed, but the
 *    19 tasks it blocked stay status='blocked' forever — nothing ever re-runs
 *    a previously blocked task whose blocker no longer reproduces against the
 *    CURRENT profile. This sweep re-checks each blocked task whose blocker is
 *    the missing-profile-field preflight class using the SAME presence logic
 *    preflight uses (recheckMissingProfileFields — no drift) and, when every
 *    flagged field is now present, re-queues it (status 'ready', blocker
 *    fields cleared) so the normal scheduler re-pick resumes it.
 * 2. DUPLICATE OPEN HARD-STOPS. The blocker insert had no dedup, so retries
 *    stacked identical open blockers (task 51b2f063 carried 3 identical open
 *    unknown_application_method stops). The insert path now dedupes
 *    (hamiltonBlockerStore.recordBlocker); this sweep repairs the rows already
 *    stacked: for each (task, blocker_type, field/key) group of OPEN blockers
 *    it keeps the OLDEST and marks the extras resolved with strategy
 *    'duplicate' — rows are never deleted (append-only audit store).
 *
 * SAFETY POSTURE
 * --------------
 *   - CONSERVATIVE CLASS GATE: only tasks whose ENTIRE outstanding blocker set
 *     is the missing-profile-field preflight class are re-checked. A task with
 *     any other unresolved item (document, login, consent, …) is never touched.
 *   - COUNT-GATED: requeues are capped per boot (default 50, env
 *     HAMILTON_SELF_HEAL_REQUEUE_CAP) so a huge backlog can't cause a boot storm.
 *   - IDEMPOTENT: a requeued task is no longer 'blocked' and a deduped group
 *     has one open row, so a re-run is a no-op.
 *   - OVERRIDE: ON by default. Set ENFORCE_HAMILTON_TASK_SELF_HEAL=0 for
 *     count-only (no writes), same posture as ENFORCE_RELEVANCE_FLOOR.
 */
const SELF_HEAL_REQUEUE_CAP_DEFAULT = 50

/** Resolve the per-boot requeue cap at call time so tests/ops can tune env. */
export function resolveSelfHealRequeueCap() {
  const v = Number.parseInt(process.env.HAMILTON_SELF_HEAL_REQUEUE_CAP || '', 10)
  return Number.isFinite(v) && v > 0 ? v : SELF_HEAL_REQUEUE_CAP_DEFAULT
}

// Map a preflight blocker label back to its field key ("Profile is missing
// first name" → first_name; the school label is worded differently).
function preflightLabelToFieldKey(label) {
  const text = String(label || '').trim().toLowerCase()
  if (!text) return null
  if (/^profile is missing school\s*\/\s*university$/.test(text)) return 'school_name'
  const m = /^profile is missing ([a-z ]+)$/.exec(text)
  return m ? m[1].trim().replace(/\s+/g, '_') : null
}

/**
 * INVARIANT: A TASK-FLAGGED PROFILE FIELD THE PROFILE CAN NOW ANSWER IS
 * RESOLVED EVERYWHERE (the Anastasia first-name class, owner report
 * 2026-07-27).
 *
 * Hamilton flags missing fields PER TASK (application_missing_info), but the
 * fix is PROFILE-WIDE: the owner adds first_name once. Prod carried 30+
 * unresolved "Profile is missing first name" rows across Anastasia's portal
 * tasks while basic_information.first_name = "Anastasia" sat right there —
 * the reconcile existed but ran only after DOCUMENT PARSES, and the task
 * self-heal above only re-queues status='blocked' tasks without resolving
 * the flag rows on waiting/review tasks, so every portal kept announcing the
 * same already-answered ask forever.
 *
 * Per-call gates: PUT /api/profiles/:id and PUT /:id/sections/:sectionKey
 * call reconcileProfileFieldsToTasks after every save. This sweep is the net
 * for every OTHER write path (interview answers, Anya enrichment, imports,
 * direct SQL) — same store function, no drift: values come from
 * profile_sections + the profiles row + name parts derived from
 * display_name via the canonical parseFullName.
 *
 * OVERRIDE: ENFORCE_STALE_MISSING_FIELDS=0 for count-only; bound
 * STALE_MISSING_FIELD_PROFILE_LIMIT (default 50 profiles per boot).
 */
export async function enforceStaleMissingFieldResolution(db) {
  return runInvariant('stale_missing_field_resolution', async () => {
    try {
      await db.prepare('SELECT task_id FROM application_missing_info LIMIT 1').get()
    } catch {
      return { repaired: 0, skipped: 'schema' }
    }
    const enforce = process.env.ENFORCE_STALE_MISSING_FIELDS !== '0'
    const limRaw = Number.parseInt(process.env.STALE_MISSING_FIELD_PROFILE_LIMIT || '', 10)
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? limRaw : 50

    // Profiles with any unresolved FIELD flag on a live task. `IS NOT TRUE`
    // is deliberate: resolved is INTEGER on SQLite and BOOLEAN on Postgres.
    const rows = await db.prepare(`
      SELECT DISTINCT at.profile_id AS pid
        FROM application_missing_info mi
        JOIN application_tasks at ON at.id = mi.task_id
       WHERE mi.resolved IS NOT TRUE
         AND mi.kind = 'field'
         AND at.profile_id IS NOT NULL
         AND at.status NOT IN ('submitted', 'failed', 'cancelled', 'completed')
       LIMIT ${limit}
    `).all()
    const profiles = (rows || []).map((r) => r.pid).filter(Boolean)
    if (profiles.length === 0) return { repaired: 0, scannedProfiles: 0 }
    if (!enforce) return { repaired: 0, scannedProfiles: profiles.length, enforced: false }

    let reconcileProfileFieldsToTasks
    try {
      ;({ reconcileProfileFieldsToTasks } = await import('../services/hamilton/applicationTaskStore.js'))
    } catch {
      return { repaired: 0, skipped: 'store_unavailable' }
    }

    let fieldsResolved = 0
    let tasksResumed = 0
    for (const pid of profiles) {
      try {
        const r = await reconcileProfileFieldsToTasks(db, { profileId: pid, resolvedBy: 'boot_reconcile' })
        fieldsResolved += r.fieldsResolved
        tasksResumed += r.tasksResumed
      } catch { /* one bad profile must not abort the sweep */ }
    }
    if (fieldsResolved > 0) {
      log.info('resolved stale task-flagged fields the profile already answers', {
        scannedProfiles: profiles.length, fieldsResolved, tasksResumed,
      })
    }
    return { repaired: fieldsResolved, tasksResumed, scannedProfiles: profiles.length, enforced: true }
  })
}

/**
 * INVARIANT: A SYSTEM-SIDE TASK STOP THAT NO LONGER REPRODUCES IS CLEARED,
 * AND A TASK WHOSE FUNDING SOURCE WAS PURGED IS CLOSED (the Robert White
 * 41-stop class, owner report 2026-07-27).
 *
 * Preflight files 'crawler_profile_rules' / 'application_url' hard stops as
 * missing-info rows, but nothing ever re-ran the check — the blocked-task
 * self-heal above deliberately skips non-profile-field items. So a stop was
 * permanent by construction (a later crawl endorsing the pair, or URL-rescue
 * finding the portal page, changed nothing), and 18 tasks whose grant row
 * had been PURGED sat blocked forever as unfulfillable zombies.
 *
 * Re-check runs the SAME code that wrote each stop (assessHamiltonFundingSource
 * / the usable-URL bar) with three honest outcomes: passes → resolve + resume;
 * source gone entirely → cancel the task; still failing → leave it visible.
 *
 * OVERRIDE: ENFORCE_HAMILTON_STOP_RECHECK=0 for count-only; bound
 * HAMILTON_STOP_RECHECK_LIMIT (default 200 tasks per boot).
 */
export async function enforceHamiltonStopRecheck(db, deps = {}) {
  return runInvariant('hamilton_stop_recheck', async () => {
    try {
      await db.prepare('SELECT task_id FROM application_missing_info LIMIT 1').get()
    } catch {
      return { repaired: 0, skipped: 'schema' }
    }
    const enforce = process.env.ENFORCE_HAMILTON_STOP_RECHECK !== '0'
    const limRaw = Number.parseInt(process.env.HAMILTON_STOP_RECHECK_LIMIT || '', 10)
    const limit = Number.isFinite(limRaw) && limRaw > 0 ? limRaw : 200

    let recheckHamiltonPolicyStops
    try {
      ;({ recheckHamiltonPolicyStops } = await import('../services/hamilton/hamiltonStopRecheck.js'))
    } catch {
      return { repaired: 0, skipped: 'store_unavailable' }
    }
    const r = await recheckHamiltonPolicyStops(db, { limit, enforce, verifyLink: deps.verifyLink ?? null })
    return {
      repaired: r.itemsResolved + r.tasksCancelled,
      itemsResolved: r.itemsResolved,
      tasksResumed: r.tasksResumed,
      tasksCancelled: r.tasksCancelled,
      leftHonest: r.leftHonest,
      linksReverified: r.linksReverified,
      scannedTasks: r.scannedTasks,
      enforced: enforce,
    }
  })
}

export async function enforceHamiltonTaskSelfHeal(db) {
  return runInvariant('hamilton_task_self_heal', async () => {
    // application_tasks may not exist on a minimal/test DB — degrade silently.
    try {
      await db.prepare('SELECT id FROM application_tasks LIMIT 1').get()
    } catch {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }

    // Lazy imports (same pattern as enforceStudentAidEligibility): reuse the
    // EXACT preflight presence logic + the canonical task/blocker stores so
    // this sweep can never drift from the live check, and a missing module can
    // never abort boot.
    let PREFLIGHT_PROFILE_FIELD_KEYS, recheckMissingProfileFields
    let updateApplicationTask, appendTaskEvent, resolveMissingInfoItem
    let getResolvedFieldsAsMap = null
    try {
      ;({ PREFLIGHT_PROFILE_FIELD_KEYS, recheckMissingProfileFields } = await import('../services/hamilton/hamiltonPreflight.js'))
      ;({ updateApplicationTask, appendTaskEvent, resolveMissingInfoItem } = await import('../services/hamilton/applicationTaskStore.js'))
    } catch (err) {
      log.warn('hamilton_task_self_heal: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    try {
      ;({ getResolvedFieldsAsMap } = await import('../services/hamilton/hamiltonResolvedFieldStore.js'))
    } catch { getResolvedFieldsAsMap = null }

    const disabled = _parseBoolEnv(process.env.ENFORCE_HAMILTON_TASK_SELF_HEAL) === false
    const cap = resolveSelfHealRequeueCap()
    const fieldClass = new Set(PREFLIGHT_PROFILE_FIELD_KEYS)

    // ── Part 1: re-check blocked missing-profile-field tasks ─────────────────
    let blockedRows = []
    try {
      blockedRows = await db.prepare(
        `SELECT id, profile_id, last_agent_message FROM application_tasks
          WHERE status = 'blocked' ORDER BY updated_at ASC LIMIT 500`,
      ).all()
      if (!Array.isArray(blockedRows)) blockedRows = []
    } catch { blockedRows = [] }

    // Minimal profile-bundle loader (profiles row + parsed sections merged, the
    // shape recheckMissingProfileFields expects — display_name at the top level
    // is what enables first/last-name derivation). Cached per profile.
    const profileCache = new Map()
    const loadProfile = async (profileId) => {
      if (profileCache.has(profileId)) return profileCache.get(profileId)
      let bundle = null
      try {
        const row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
        if (row) {
          const sections = {}
          try {
            const sectionRows = await db
              .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
              .all(String(profileId))
            for (const r of sectionRows || []) {
              try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
            }
          } catch { /* profile_sections absent — profiles row alone still allows name derivation */ }
          bundle = { ...row, ...sections, sections }
        }
      } catch { bundle = null }
      profileCache.set(profileId, bundle)
      return bundle
    }

    let scanned = 0
    let requeued = 0
    let requeueCapped = false
    for (const task of blockedRows) {
      // Flagged field keys for this task: unresolved missing-info items first
      // (the canonical record preflight writes), else parse the preflight
      // last_agent_message for legacy rows blocked before items were recorded.
      let unresolvedItems = []
      try {
        unresolvedItems = await db.prepare(
          'SELECT kind, key FROM application_missing_info WHERE task_id = ? AND resolved = 0',
        ).all(String(task.id))
        if (!Array.isArray(unresolvedItems)) unresolvedItems = []
      } catch { unresolvedItems = [] }

      let keys
      if (unresolvedItems.length > 0) {
        // Class gate: EVERY outstanding item must be a profile field in the
        // preflight class, or we leave the task alone.
        if (!unresolvedItems.every((m) => m.kind === 'field' && fieldClass.has(String(m.key)))) continue
        keys = unresolvedItems.map((m) => String(m.key))
      } else {
        const msg = String(task.last_agent_message || '')
        if (!/stopped at preflight:/i.test(msg)) continue
        const detail = msg.replace(/^.*stopped at preflight:\s*/i, '')
        const parts = detail.split(';').map((s) => s.trim()).filter(Boolean)
        if (parts.length === 0) continue
        const mapped = parts.map(preflightLabelToFieldKey)
        // Same class gate: every recorded blocker label must map to the class.
        if (mapped.some((k) => !k || !fieldClass.has(k))) continue
        keys = mapped
      }

      const profile = await loadProfile(task.profile_id)
      if (!profile) continue
      let resolvedFields = null
      if (getResolvedFieldsAsMap) {
        try { resolvedFields = await getResolvedFieldsAsMap(db, task.profile_id) } catch { resolvedFields = null }
      }
      const stillMissing = recheckMissingProfileFields(profile, keys, resolvedFields)
      if (stillMissing.length > 0) continue // blocker still real — leave blocked

      scanned += 1
      if (disabled) continue
      if (requeued >= cap) { requeueCapped = true; break }

      for (const m of unresolvedItems) {
        try {
          await resolveMissingInfoItem(db, task.id, {
            kind: m.kind, key: m.key, value: 'present_on_profile', resolvedBy: 'self_heal_sweep',
          })
        } catch { /* item resolution is best-effort; the requeue is the repair */ }
      }
      await updateApplicationTask(db, task.id, {
        status: 'ready',
        nextRetryAt: null,
        currentStep: 'self_heal_requeue',
        lastAgentMessage: 'Previously-flagged profile fields are now present — task re-queued; Hamilton will resume automatically.',
      })
      await appendTaskEvent(db, {
        taskId: task.id,
        eventType: 'unblocked',
        status: 'ready',
        step: 'self_heal',
        message: `Boot self-heal: the "${keys.join(', ')}" preflight blocker no longer reproduces against the current profile — task re-queued.`,
        actorRole: 'agent',
        details: { self_heal: true, rechecked_keys: keys },
      })
      requeued += 1
    }

    // ── Part 2: dedupe already-stacked OPEN hard-stops ──────────────────────
    // Keep the OLDEST open row per (task, type, key) group; mark the extras
    // resolved with strategy 'duplicate' (never delete — append-only store).
    let dedupedBlockers = 0
    let duplicateGroups = 0
    try {
      const { blockerDedupeKey, recordResolution } = await import('../services/hamilton/hamiltonBlockerStore.js')
      const open = await db.prepare(
        `SELECT id, task_id, blocker_type, blocker_text, metadata_json, detected_at
           FROM hamilton_blockers WHERE resolved_at IS NULL`,
      ).all()
      const groups = new Map()
      for (const row of open || []) {
        const key = `${row.task_id}|${row.blocker_type}|${blockerDedupeKey(row)}`
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(row)
      }
      const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
      for (const rows of groups.values()) {
        if (rows.length < 2) continue
        duplicateGroups += 1
        if (disabled) { dedupedBlockers += rows.length - 1; continue }
        const sorted = [...rows].sort((a, b) => {
          const ta = Date.parse(String(a.detected_at ?? '')) || 0
          const tb = Date.parse(String(b.detected_at ?? '')) || 0
          if (ta !== tb) return ta - tb
          return String(a.id).localeCompare(String(b.id))
        })
        const keeper = sorted[0]
        for (let i = 1; i < sorted.length; i += 1) {
          const dupe = sorted[i]
          await db.prepare(
            `UPDATE hamilton_blockers
                SET resolved_at = ${nowFn}, resolution_strategy = 'duplicate', updated_at = ${nowFn}
              WHERE id = ? AND resolved_at IS NULL`,
          ).run(dupe.id)
          try {
            await recordResolution(db, {
              blockerId: dupe.id, taskId: dupe.task_id,
              strategy: 'duplicate', outcome: 'resolved',
              detail: `Duplicate of open blocker ${keeper.id} (same task/type/key); resolved by boot self-heal sweep.`,
            })
          } catch { /* audit row is best-effort; the resolve above is the repair */ }
          dedupedBlockers += 1
        }
      }
    } catch { /* hamilton_blockers absent — nothing to dedupe */ }

    if (disabled) {
      if (scanned > 0 || dedupedBlockers > 0) {
        log.warn('hamilton self-heal candidates present (writes DISABLED via ENFORCE_HAMILTON_TASK_SELF_HEAL=0)', {
          requeueCandidates: scanned, duplicateBlockers: dedupedBlockers,
        })
      }
      return { scanned: scanned + dedupedBlockers, repaired: 0, enforced: false, requeued: 0, dedupedBlockers: 0 }
    }
    if (requeued > 0 || dedupedBlockers > 0) {
      log.info('hamilton task self-heal repaired stale lifecycle state', {
        requeued, dedupedBlockers, duplicateGroups, requeueCapped, cap,
      })
    }
    return {
      scanned: scanned + dedupedBlockers,
      repaired: requeued + dedupedBlockers,
      enforced: true,
      requeued,
      dedupedBlockers,
      ...(requeueCapped ? { requeueCapped: true, cap } : {}),
    }
  })
}

/**
 * INVARIANT: A SEARCH-ENGINE RESULTS URL IS NEVER AN APPLICATION TARGET
 * (URL hygiene — canonical_rules.md "no random junk" + urlRules.js Phase G).
 *
 * Crawler fallbacks used to synthesize "https://www.google.com/search?q=…"
 * links when no real portal URL was known, and those were persisted as
 * funding_opportunities.application_url and application_tasks.portal_url /
 * application_url. Hamilton then queued the search page as a portal,
 * classified Google's sign-in wall as login_required, and retried login 5x
 * against a search results page (verified in prod: 8 Robert tasks + 1
 * Anastasia task, 2026-07). The producers are now fixed (school-card
 * fallbacks removed, insert-path scrub in opportunityInserter, classifier
 * readUrl filter); this sweep is the NET that heals rows any path already
 * persisted.
 *
 * Behavior (bounded, idempotent, non-destructive — no row is ever deleted):
 *   - application_tasks: NULL the offending portal_url / application_url; on
 *     a non-terminal task also reclassify to the truthful state — status
 *     'blocked', automation_type 'unknown', next_retry_at cleared, and a
 *     last_agent_message naming unknown_application_method so humans see why.
 *     Terminal tasks (submitted/completed/cancelled/failed) only get their
 *     URLs nulled; their history is never rewritten.
 *   - funding_opportunities + grants (the sources feeding tasks): NULL the
 *     offending application/apply/url columns.
 *
 * Count-gated: at most SEARCH_URL_SWEEP_LIMIT rows per table per boot — the
 * sweep is idempotent so any remainder heals on subsequent boots. Disable via
 * ENFORCE_URL_HYGIENE=0 (count-only, like the other toggles). SQL LIKE is a
 * cheap prefilter only; the canonical isSearchEngineUrl() is authoritative on
 * every row before any write.
 */
const SEARCH_URL_SWEEP_LIMIT = 500

// LIKE prefilters mirroring urlRules.SEARCH_ENGINE_URL_PATTERNS (broad on
// purpose; JS re-verifies). Each literal is an intentional validator entry.
const SEARCH_URL_LIKE_PREFILTERS = Object.freeze([
  '%google.%/search%', // audit:allow placeholder
  '%google.com/url?%', // audit:allow placeholder
  '%bing.com/search%', // audit:allow placeholder
  '%duckduckgo.com/%', // audit:allow placeholder
  '%yahoo.com/search%', // audit:allow placeholder
  '%yandex.%/search%', // audit:allow placeholder
  '%baidu.com/s?%', // audit:allow placeholder
  '%ecosia.org/search%', // audit:allow placeholder
])

// Task statuses whose history must never be rewritten by the sweep. Mirrors
// applicationTaskStore.TASK_TERMINAL_STATUSES (+ 'completed'); inlined so the
// boot sweep does not import the store module (whose schema bootstrap must not
// run against arbitrary DBs).
const SEARCH_URL_SWEEP_TERMINAL_TASK_STATUSES = new Set([
  'submitted', 'completed', 'cancelled', 'failed',
])

function buildSearchUrlLikeWhere(columns) {
  const clauses = []
  const params = []
  for (const col of columns) {
    for (const like of SEARCH_URL_LIKE_PREFILTERS) {
      clauses.push(`${col} LIKE ?`)
      params.push(like)
    }
  }
  return { where: clauses.join(' OR '), params }
}

export async function enforceNoSearchEngineApplicationTargets(db) {
  return runInvariant('no_search_engine_application_targets', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_URL_HYGIENE) === false
    let scanned = 0
    let repaired = 0

    // ── 1. application_tasks: null URLs + reclassify non-terminal blockers ──
    {
      const { where, params } = buildSearchUrlLikeWhere(['portal_url', 'application_url'])
      let rows = []
      try {
        rows = await db.prepare(
          `SELECT id, status, portal_url, application_url FROM application_tasks
            WHERE ${where} LIMIT ${SEARCH_URL_SWEEP_LIMIT}`,
        ).all(...params)
      } catch { rows = [] /* table absent on this schema — nothing to heal */ }

      for (const row of rows || []) {
        const badPortal = isSearchEngineUrl(row.portal_url)
        const badApplication = isSearchEngineUrl(row.application_url)
        if (!badPortal && !badApplication) continue // LIKE prefilter false positive
        scanned += 1
        if (disabled) continue
        const sets = []
        if (badPortal) sets.push('portal_url = NULL')
        if (badApplication) sets.push('application_url = NULL')
        const isTerminal = SEARCH_URL_SWEEP_TERMINAL_TASK_STATUSES.has(String(row.status || ''))
        if (!isTerminal) {
          sets.push("status = 'blocked'")
          sets.push("automation_type = 'unknown'")
          sets.push('next_retry_at = NULL')
          sets.push(`last_agent_message = 'URL-hygiene invariant: the recorded application link was a search-results page, not a real portal (unknown_application_method). A human should supply the funder''s actual application URL.'`)
        }
        try {
          const res = await db.prepare(`UPDATE application_tasks SET ${sets.join(', ')} WHERE id = ?`).run(row.id)
          repaired += changesOf(res) || 1
        } catch (err) {
          log.warn('url hygiene: application_tasks repair failed (non-fatal)', { task: row.id, error: String(err?.message || err) })
        }
      }
    }

    // ── 2. funding sources feeding the tasks ────────────────────────────────
    // Column sets are probed implicitly: a SELECT naming a missing column (or
    // table) throws and that table is skipped — recall-over-crash.
    const sourceTables = [
      { table: 'funding_opportunities', columns: ['application_url', 'apply_url', 'source_url'] },
      { table: 'grants', columns: ['application_url', 'url'] },
    ]
    for (const { table, columns } of sourceTables) {
      const { where, params } = buildSearchUrlLikeWhere(columns)
      let rows = []
      try {
        rows = await db.prepare(
          `SELECT id, ${columns.join(', ')} FROM ${table} WHERE ${where} LIMIT ${SEARCH_URL_SWEEP_LIMIT}`,
        ).all(...params)
      } catch { rows = [] /* table/column absent — skip */ }

      for (const row of rows || []) {
        const badCols = columns.filter((c) => isSearchEngineUrl(row[c]))
        if (badCols.length === 0) continue
        scanned += 1
        if (disabled) continue
        try {
          const res = await db.prepare(
            `UPDATE ${table} SET ${badCols.map((c) => `${c} = NULL`).join(', ')} WHERE id = ?`,
          ).run(row.id)
          repaired += changesOf(res) || 1
        } catch (err) {
          log.warn(`url hygiene: ${table} repair failed (non-fatal)`, { id: row.id, error: String(err?.message || err) })
        }
      }
    }

    if (disabled) {
      if (scanned > 0) log.warn('search-engine application targets present (repair DISABLED via ENFORCE_URL_HYGIENE=0)', { scanned })
      return { scanned, repaired: 0, enforced: false }
    }
    if (repaired > 0) {
      log.info('nulled search-engine application targets + reclassified affected tasks', { scanned, repaired })
    }
    return { scanned, repaired, enforced: true }
  })
}

/**
 * INVARIANT: a row naming a REGISTERED canonical public program (TN Promise /
 * TN Reconnect / TN HOPE — backend/config/canonicalProgramRegistry.js) sends
 * the applicant to the program's OFFICIAL application URL.
 *
 * THE CLASS (the "TN Promise opens a Cleveland State paramedic page" report,
 * 2026-07-31): the web lane reads a page that merely MENTIONS a famous
 * program ("TN Promise eligible!") and emits an opportunity TITLED by the
 * mention with the PAGE's url as application target. Measured in prod:
 * 6 of 10 TN Promise rows pointed at program pages / blog posts; TN HOPE rows
 * pointed at a College Confidential forum thread. Clicking "Open" on such a
 * card launches a secure login for a page where the program cannot be applied
 * for at all.
 *
 * Repair repoints application_url ONLY — source_url/evidence_url stay as
 * honest provenance of where the mention was read. Linked pipeline grants
 * still carrying the EXACT old junk target are echoed the fix (exact-match
 * only, so a user-entered URL is never clobbered). Per-call gate:
 * opportunityInserter.upsertFundingOpportunity. Idempotent: a repaired row's
 * host is official, so it leaves the candidate set. LIKE prefilter per
 * registry entry keeps the sweep off full scans; the registry's precise JS
 * matcher is authoritative on every row before any write ("Bank of Hope
 * Scholarship" must never be claimed by Tennessee HOPE).
 * OVERRIDE: ON by default; ENFORCE_CANONICAL_PROGRAM_TARGETS=0 for count-only.
 */
const CANONICAL_PROGRAM_SWEEP_LIMIT = 500

export async function enforceCanonicalProgramApplicationTargets(db) {
  return runInvariant('canonical_program_application_targets', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_CANONICAL_PROGRAM_TARGETS) === false
    let scanned = 0
    let repaired = 0
    let grantsEchoed = 0

    for (const program of CANONICAL_PROGRAMS) {
      const likes = Array.isArray(program.likePrefilters) ? program.likePrefilters : []
      if (likes.length === 0) continue
      const where = likes.map(() => '(LOWER(title) LIKE ? OR LOWER(sponsor) LIKE ?)').join(' OR ')
      const params = likes.flatMap((l) => [l, l])
      let rows = []
      try {
        rows = await db.prepare(
          `SELECT id, title, sponsor, application_url FROM funding_opportunities
            WHERE ${where} LIMIT ${CANONICAL_PROGRAM_SWEEP_LIMIT}`,
        ).all(...params)
      } catch { rows = [] /* table/columns absent on this schema — skip */ }

      for (const row of rows || []) {
        const repair = canonicalProgramTargetRepair(row)
        if (!repair) continue // not this program, or already on an official host
        scanned += 1
        if (disabled) continue
        try {
          const res = await db.prepare(
            'UPDATE funding_opportunities SET application_url = ? WHERE id = ?',
          ).run(repair.officialUrl, row.id)
          repaired += changesOf(res) || 1
          // Echo onto linked pipeline grants STILL carrying the exact old junk
          // target. Exact-match only — a user-entered URL is never clobbered.
          if (row.application_url) {
            for (const col of ['application_url', 'url']) {
              try {
                const g = await db.prepare(
                  `UPDATE grants SET ${col} = ? WHERE funding_opportunity_id = ? AND ${col} = ?`,
                ).run(repair.officialUrl, row.id, row.application_url)
                grantsEchoed += changesOf(g) || 0
              } catch { /* column absent on this schema */ }
            }
          }
        } catch (err) {
          log.warn('canonical-program target repair failed (non-fatal)', { id: row.id, error: String(err?.message || err) })
        }
      }
    }

    if (disabled) {
      if (scanned > 0) {
        log.warn('canonical-program rows with off-program application targets present (repair DISABLED via ENFORCE_CANONICAL_PROGRAM_TARGETS=0)', { scanned })
      }
      return { scanned, repaired: 0, grantsEchoed: 0, enforced: false }
    }
    if (repaired > 0) {
      log.info('repointed canonical-program application targets to official URLs', { scanned, repaired, grantsEchoed })
    }
    return { scanned, repaired, grantsEchoed, enforced: true }
  })
}

/**
 * INVARIANT: last_verified_at means a real TARGET verification happened, not a
 * source scrape. The crawler-os persistence path (crawlerOsPersistence.js) used
 * to stamp `last_verified_at` from the SOURCE page's `fetched_at` — i.e. when we
 * fetched the LISTING/aggregator, NOT when we checked the opportunity's own
 * application target. Three harms followed:
 *   1. The Source Trace UI showed a "verified" time that was really a scrape time.
 *   2. linkVerificationService (re-verify after 30d) SKIPPED these rows because
 *      they looked freshly verified — so their real target was never probed.
 *   3. A fallback query ordered by last_verified_at boosted these false rows.
 * The producer is fixed (source capture no longer stamps it); this net repairs
 * rows ALREADY persisted with the false stamp.
 *
 * PRECISE, SAFE PREDICATE — a genuine verification (linkVerificationService, or
 * opportunityInserter's live-check insert) ALWAYS records who/how it checked:
 * `verified_by`, `verification_method`, and a real `link_status`
 * (ok|redirect|broken|skipped). A source-capture false stamp has a
 * `last_verified_at` timestamp but NONE of that evidence. We only clear rows that
 * carry a verification TIME with ZERO evidence any verification occurred, scoped
 * to record_origin='live_crawl' (the crawler-os path that produced the bug).
 * Clearing to NULL re-queues the row for the real verifier (its candidate query
 * picks `last_verified_at IS NULL` first). Nothing a real probe touched is moved.
 *
 * BOUNDS (mirror enforceAmountEnrichment / url-rescue boot nets so a large
 * historical backlog can't stampede the verifier or the DB on one boot): at most
 * VERIFIED_AT_HONESTY_BOOT_LIMIT rows (default 500) cleared per boot in chunks,
 * within VERIFIED_AT_HONESTY_TIME_BUDGET_MS (default 10s). Each cleared row no
 * longer matches next boot, so the backlog drains monotonically over boots.
 * OVERRIDE: ON by default; ENFORCE_VERIFIED_AT_HONESTY=0 for count-only.
 */
const VERIFIED_AT_HONESTY_BOOT_LIMIT_DEFAULT = 500
const VERIFIED_AT_HONESTY_TIME_BUDGET_MS_DEFAULT = 10000
const VERIFIED_AT_HONESTY_CHUNK = 200

export async function enforceLiveCrawlVerifiedAtHonesty(db) {
  return runInvariant('live_crawl_verified_at_honesty', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_VERIFIED_AT_HONESTY) === false
    const bootLimit = _parsePositiveIntEnv(
      process.env.VERIFIED_AT_HONESTY_BOOT_LIMIT,
      VERIFIED_AT_HONESTY_BOOT_LIMIT_DEFAULT,
    )
    const timeBudgetMs = _parsePositiveIntEnv(
      process.env.VERIFIED_AT_HONESTY_TIME_BUDGET_MS,
      VERIFIED_AT_HONESTY_TIME_BUDGET_MS_DEFAULT,
    )

    // Falsely-stamped rows: a verification TIME with zero verification evidence,
    // scoped to the crawler-os live_crawl path that produced the bug.
    const WHERE = `record_origin = 'live_crawl'
        AND last_verified_at IS NOT NULL
        AND verified_by IS NULL
        AND verification_method IS NULL
        AND (link_status IS NULL OR link_status = 'unverified')`

    let scanned = 0
    try {
      const row = await db
        .prepare(`SELECT COUNT(*) AS c FROM funding_opportunities WHERE ${WHERE}`)
        .get()
      scanned = Number(row?.c ?? 0)
    } catch (err) {
      // Minimal/fixture DBs may lack these columns — nothing to enforce.
      log.warn('verified_at_honesty: candidate scan failed (non-fatal)', {
        error: String(err?.message || err),
      })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }

    if (scanned === 0) return { scanned: 0, repaired: 0, enforced: !disabled }
    if (disabled) {
      log.warn('source-scrape false last_verified_at stamps present (repair DISABLED via ENFORCE_VERIFIED_AT_HONESTY=0)', {
        scanned,
      })
      return { scanned, repaired: 0, enforced: false }
    }

    const startedAt = Date.now()
    let repaired = 0
    while (repaired < bootLimit) {
      if (Date.now() - startedAt > timeBudgetMs) break
      const chunk = Math.min(VERIFIED_AT_HONESTY_CHUNK, bootLimit - repaired)
      let n = 0
      try {
        const res = await db
          .prepare(
            `UPDATE funding_opportunities
                SET last_verified_at = NULL
              WHERE id IN (
                SELECT id FROM funding_opportunities WHERE ${WHERE} LIMIT ?
              )`,
          )
          .run(chunk)
        n = changesOf(res)
      } catch (err) {
        log.warn('verified_at_honesty: clear failed (non-fatal)', {
          error: String(err?.message || err),
        })
        break
      }
      repaired += n
      if (n === 0) break
    }

    if (repaired > 0) {
      log.info('cleared source-scrape false last_verified_at stamps; re-queued for real target verification', {
        scanned,
        repaired,
        remaining: Math.max(0, scanned - repaired),
      })
    }
    return { scanned, repaired, enforced: true }
  })
}

/**
 * INVARIANT: APPLICATION-URL RESCUE — a real candidate rejected ONLY for a
 * missing URL gets ONE bounded chance to be rescued with a real, live page.
 *
 * THE GAP THIS CLOSES (2026-07-06)
 * --------------------------------
 * Docs/email/LLM-extracted candidates frequently carry a real title + sponsor
 * but no application URL, so the opportunityInserter url gate rejects them
 * (stage 'url', reason 'missing_application_url') and 80+ real programs sat
 * dead in rejection_log. The gate is CORRECT (a URL-less catalog row is
 * unusable); what was missing is a rescue lane that finds the program's REAL
 * page and re-drives the candidate through the full insert gate stack.
 *
 * HONESTY POSTURE (canonical_rules.md G0 — never invent data): the rescued URL
 * comes from findOfficialUrlForOpportunity — a live web search for the
 * candidate's own title+sponsor, a token-overlap plausibility check, and a
 * liveness probe. Nothing is guessed or synthesized; "not found" leaves the
 * rejection standing. The re-drive goes through upsertFundingOpportunity, so
 * every gate (provenance/policy/validation/reviewer/reality/dedupe) re-applies.
 *
 * BOUNDS + OUTAGE GUARD: per boot, at most URL_RESCUE_BOOT_LIMIT search
 * attempts within URL_RESCUE_TIME_BUDGET_MS; a system_kv cursor
 * ('url_rescue_last_rejection_id') makes each rejection row get exactly ONE
 * attempt — EXCEPT when every search in the run came back empty/failed
 * (searched:false or hits===0), which is indistinguishable from a search-
 * provider outage: then the cursor does NOT advance, so candidates are never
 * permanently burned by an outage. `ENFORCE_URL_RESCUE=0` → count-only mode.
 */
const URL_RESCUE_SCAN_LIMIT = 50
const URL_RESCUE_BOOT_LIMIT_DEFAULT = 8
const URL_RESCUE_TIME_BUDGET_MS_DEFAULT = 20000
const URL_RESCUE_CURSOR_KEY = 'url_rescue_last_rejection_id'
/**
 * Legacy rejection rows (logged before raw_meta carried a candidate snapshot)
 * may be rescued on title alone, but only when the title is distinctive enough
 * to make a confident search match: at least this many significant tokens.
 */
const URL_RESCUE_TITLE_ONLY_MIN_TOKENS = 4

function _parsePositiveIntEnv(value, fallback) {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

async function readUrlRescueCursor(db) {
  try {
    // Same key-value store + missing-table tolerance as the Brave budget pacer
    // (services/yana/braveBudget.js) — survives deploys, never blocks boot.
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(URL_RESCUE_CURSOR_KEY)
    const n = Number.parseInt(row?.value ?? '', 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

async function writeUrlRescueCursor(db, id) {
  try {
    const iso = new Date().toISOString()
    const value = String(id)
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, iso, URL_RESCUE_CURSOR_KEY)
    if (!changesOf(res)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(URL_RESCUE_CURSOR_KEY, value, iso)
    }
  } catch (err) {
    log.warn('url rescue: cursor persist failed (non-fatal)', { error: String(err?.message || err) })
  }
}

/** Parse the raw_meta JSON of a rejection row; absent/legacy/corrupt → null. */
function parseRescueCandidateMeta(rawMeta) {
  if (typeof rawMeta !== 'string' || !rawMeta.trim()) return null
  try {
    const meta = JSON.parse(rawMeta)
    const candidate = meta?.candidate
    return candidate !== null && candidate !== undefined && typeof candidate === 'object' ? candidate : null
  } catch {
    return null
  }
}

export async function enforceApplicationUrlRescue(db, deps = {}) {
  return runInvariant('application_url_rescue', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_URL_RESCUE) === false
    const bootLimit = _parsePositiveIntEnv(process.env.URL_RESCUE_BOOT_LIMIT, URL_RESCUE_BOOT_LIMIT_DEFAULT)
    const timeBudgetMs = _parsePositiveIntEnv(process.env.URL_RESCUE_TIME_BUDGET_MS, URL_RESCUE_TIME_BUDGET_MS_DEFAULT)
    const findOfficialUrl = deps.findOfficialUrl ?? findOfficialUrlForOpportunity

    const counters = {
      scanned: 0,
      attempted: 0,
      rescued: 0,
      failed: 0,
      skippedNoTitle: 0,
      skippedNoMeta: 0,
      notFound: 0,
      // runInvariant summary compatibility: rescued rows ARE the repair.
      repaired: 0,
      enforced: !disabled,
    }

    const cursor = await readUrlRescueCursor(db)
    let rows = []
    try {
      rows = await db.prepare(
        `SELECT id, source, title, raw_meta FROM rejection_log
          WHERE stage = 'url' AND reason = 'missing_application_url' AND id > ?
          ORDER BY id ASC LIMIT ${URL_RESCUE_SCAN_LIMIT}`,
      ).all(cursor)
    } catch { rows = [] /* rejection_log absent on this schema — nothing to rescue */ }
    rows = rows || []

    if (disabled) {
      counters.scanned = rows.length
      if (rows.length > 0) {
        log.warn('url rescue: rescuable url-rejections present (rescue DISABLED via ENFORCE_URL_RESCUE=0)', { pending: rows.length })
      }
      return counters
    }

    const startMs = Date.now()
    const searchOutcomes = []
    // Cursor candidate: highest rejection id actually PROCESSED (attempted or
    // deliberately skipped). Rows beyond the boot/time budget are NOT burned —
    // they stay ahead of the cursor for the next boot.
    let lastProcessedId = cursor

    for (const row of rows) {
      if (counters.attempted >= bootLimit || (Date.now() - startMs) > timeBudgetMs) break
      counters.scanned += 1

      const title = typeof row.title === 'string' ? row.title.trim() : ''
      if (!title) {
        counters.skippedNoTitle += 1
        lastProcessedId = row.id
        continue
      }

      const candidate = parseRescueCandidateMeta(row.raw_meta)
      if (candidate === null && significantTitleTokens(title).length < URL_RESCUE_TITLE_ONLY_MIN_TOKENS) {
        // Legacy row without a candidate snapshot AND a title too generic for
        // a confident title-only search — skipping is the honest move.
        counters.skippedNoMeta += 1
        lastProcessedId = row.id
        continue
      }

      counters.attempted += 1
      const found = await findOfficialUrl({ title, sponsor: candidate?.sponsor ?? null })
      searchOutcomes.push(found)
      lastProcessedId = row.id

      if (!found?.url) {
        counters.notFound += 1
        continue
      }

      try {
        // Re-drive the candidate's OWN fields (nothing invented) through the
        // canonical insert path with the found, already-probed URL. verifyUrl
        // stays false: findOfficialUrlForOpportunity just probed it live.
        const result = await upsertFundingOpportunity(db, {
          title,
          sponsor: candidate?.sponsor ?? null,
          description: candidate?.description ?? null,
          deadline: candidate?.deadline ?? null,
          amount_min: candidate?.amount_min ?? null,
          amount_max: candidate?.amount_max ?? null,
          categories: Array.isArray(candidate?.categories) ? candidate.categories : [],
          source: candidate?.source ?? row.source ?? 'url_rescue',
          ...(candidate?.record_origin ? { record_origin: candidate.record_origin } : {}),
          source_url: found.url,
        }, { verifyUrl: false })
        if (result && (result.inserted || result.updated) && !result.skipped) {
          counters.rescued += 1
        } else {
          // Found a live page but the full gate stack (or dedupe) still said
          // no — an honest terminal outcome, counted, never retried.
          counters.failed += 1
        }
      } catch (err) {
        counters.failed += 1
        log.warn('url rescue: re-drive failed (non-fatal)', { rejection: row.id, error: String(err?.message || err) })
      }
    }

    counters.repaired = counters.rescued

    // Provider-outage guard: when EVERY search this run either failed outright
    // (searched:false) or honestly returned zero hits, we cannot distinguish
    // "program not findable" from "search providers down" — do NOT advance the
    // cursor, so these candidates keep their one real chance.
    const providerOutage =
      counters.attempted > 0 &&
      searchOutcomes.every((o) => o?.searched === false || (o?.searched === true && Number(o?.hits) === 0))
    if (!providerOutage && lastProcessedId > cursor) {
      await writeUrlRescueCursor(db, lastProcessedId)
    } else if (providerOutage) {
      log.warn('url rescue: all searches empty/failed this run — treating as provider outage; cursor NOT advanced', {
        attempted: counters.attempted,
      })
    }

    if (counters.rescued > 0) {
      log.info('url rescue: re-drove url-less candidates with real, liveness-verified pages', {
        scanned: counters.scanned,
        attempted: counters.attempted,
        rescued: counters.rescued,
        notFound: counters.notFound,
      })
    }
    return counters
  })
}

/**
 * INVARIANT: PIPELINE GRANTS CARRY THE FUNDER'S NAME WHEN IT IS KNOWABLE.
 *
 * `grants.funder` is the pipeline's display name for the granting organization
 * (the catalog's column is `funding_opportunities.sponsor`; the bridge maps
 * sponsor→funder at insert time). Historic naming drift (#725 class: `sponsor`
 * vs `funder` vs `funder_name`) produced pipeline rows with an empty funder
 * even though the linked catalog row knows the sponsor. This sweep re-copies
 * the sponsor from the linked opportunity — a pure data repair from our own
 * stored source metadata, never an invented value (data-honesty rule: rows
 * whose linked opportunity ALSO lacks a sponsor are counted, not guessed).
 *
 * Idempotent: a repaired row no longer matches the WHERE clause. Count-only
 * reporting for the un-derivable remainder keeps the gap observable (Sam/Anya
 * read the boot summary) without fabricating data.
 */
/**
 * INVARIANT: NO DANGLING PROFILE-OPPORTUNITY MATCHES
 * (a surfaced match must point at a catalog row that still exists).
 *
 * THE BUG THIS CLOSES (2026-07-06)
 * --------------------------------
 * Catalog rows are deleted by several paths (dedupe collapse, reality-gate
 * purges, the Amy reaper, manual cleanups) and NONE of them cleaned up
 * `profile_opportunity_matches` rows pointing at the deleted opportunity.
 * 271 dangling matches had accumulated; Avanell Leamon's matches view showed
 * 96 candidates ≥65 of which 62 were unusable ghosts — every read path joins
 * to funding_opportunities, so they inflate counts, waste promote passes
 * (`opportunity_not_found`), and misrepresent discovery quality to the
 * coverage flywheel.
 *
 * THE RULE: a match row whose opportunity_id no longer resolves to a
 * funding_opportunities row is deleted. Nothing of value is lost — the match
 * is unusable everywhere (all surfacing paths join the catalog). Idempotent;
 * ON by default; ENFORCE_NO_DANGLING_MATCHES=0 for count-only.
 */
export async function enforceNoDanglingMatches(db) {
  return runInvariant('no_dangling_matches', async () => {
    // Both tables must exist (minimal test DBs may lack either) — probe first.
    try {
      await db.prepare('SELECT 1 FROM profile_opportunity_matches LIMIT 1').get()
      await db.prepare('SELECT 1 FROM funding_opportunities LIMIT 1').get()
    } catch {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const DANGLING_WHERE = `NOT EXISTS (
      SELECT 1 FROM funding_opportunities fo
       WHERE fo.id = profile_opportunity_matches.opportunity_id
    )`

    let violators = 0
    try {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM profile_opportunity_matches WHERE ${DANGLING_WHERE}`)
        .get()
      violators = Number(row?.n) || 0
    } catch (err) {
      log.warn('no_dangling_matches: count query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }
    if (violators === 0) return { scanned: 0, repaired: 0, enforced: true }

    const disabled = _parseBoolEnv(process.env.ENFORCE_NO_DANGLING_MATCHES) === false
    if (disabled) {
      log.warn('dangling profile-opportunity matches present (delete DISABLED via ENFORCE_NO_DANGLING_MATCHES=0)', { violators })
      return { scanned: violators, repaired: 0, enforced: false }
    }

    let repaired = 0
    try {
      const result = await db
        .prepare(`DELETE FROM profile_opportunity_matches WHERE ${DANGLING_WHERE}`)
        .run()
      repaired = changesOf(result)
    } catch (err) {
      log.warn('no_dangling_matches: delete failed (non-fatal)', { error: String(err?.message || err) })
    }
    if (repaired > 0) {
      log.info('purged dangling profile-opportunity matches (catalog row gone)', { repaired })
    }
    return { scanned: violators, repaired, enforced: true }
  })
}

/**
 * INVARIANT: PIPELINE GRANTS CARRY A DOLLAR VALUE WHEN ONE IS KNOWABLE
 * (pipeline-$ visibility — the "$6,500 pipeline with 118 real sources" bug).
 *
 * THE BUG THIS CLOSES (2026-07-05)
 * --------------------------------
 * Every "Pipeline Potential" surface sums amount_requested (via the
 * backend/config/pipelineValue.js choke point), but the canonical auto-add
 * saver (opportunityMatcher.saveToProfilePipeline) historically wrote
 * amount_requested = NULL because catalog opportunities carry amount_min/
 * amount_max, never amount_requested. Fleet-wide only 15 of 489 active
 * pipeline grants had a value; Robert (118 active sources) displayed $6,500
 * while his rows carried ~$1.8M of award ceilings the display never read.
 *
 * THE RULE (same #725 naming-drift class as funder_backfill)
 * ----------------------------------------------------------
 *   1. A grant missing BOTH amount_min and amount_max inherits them from its
 *      linked funding_opportunities row (the catalog is the source of truth
 *      for award size). NEVER invented — unlinked rows are left alone.
 *   2. amount_requested, when empty, defaults to amount_max ?? amount_min —
 *      the SAME default the manual /from-opportunity promote path has always
 *      applied. A user-entered amount_requested is never overwritten.
 *   3. Rows with no amount derivable anywhere are COUNTED (missingAmount) as
 *      an ingest-quality signal for Sam/Anya/Amy — never guessed.
 *
 * ORDERING: runs BEFORE enforceIndividualAmountCeiling on purpose — once a
 * a real award ceiling is visible in amount_requested, the existing ceiling
 * sweep can (correctly, per G4 doctrine) purge institutional-scale money that
 * was mis-matched into an INDIVIDUAL's pipeline. Backfill makes values honest;
 * the ceiling keeps them realistic.
 *
 * OVERRIDE: ON by default; ENFORCE_GRANT_AMOUNT_BACKFILL=0 for count-only.
 * Idempotent: repaired rows no longer match the WHERE on re-run.
 */
export async function enforceGrantAmountBackfill(db) {
  return runInvariant('grant_amount_backfill', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('amount_requested') || !grantCols.has('amount_max')) {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_GRANT_AMOUNT_BACKFILL) === false

    let repairedFromCatalog = 0
    let repairedRequested = 0
    let repairedStatus = 0

    if (!disabled) {
      // Step 0 (catalog amount SANITY net — the HUD Section 4 class): an
      // UNTRUSTED-source catalog row carrying a numeric per-award figure
      // outside the extractor's plausibility window is a program appropriation
      // misparse, not an award. Ingest now demotes these to TEXT
      // (resolveOpportunityAmounts); this is the boot net for rows persisted
      // BEFORE that guard. The figure is preserved as honest text; grants that
      // inherited the fabricated number (amount_requested defaulted from it)
      // are cleaned in the same pass — user-entered asks and awarded money are
      // never touched (only values EQUAL to the stripped fabricated numbers).
      try {
        const suspect = await db
          .prepare(
            `SELECT id, amount_min, amount_max, source, source_trust_tier
               FROM funding_opportunities
              WHERE (COALESCE(amount_max, 0) > ${Number(AMOUNT_MAX_PLAUSIBLE)}
                  OR COALESCE(amount_min, 0) > ${Number(AMOUNT_MAX_PLAUSIBLE)})
              LIMIT 200`,
          )
          .all()
        for (const row of Array.isArray(suspect) ? suspect : []) {
          if (isOfficialAmountSource(row)) continue
          const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`
          const text =
            row.amount_min && row.amount_max && row.amount_min !== row.amount_max
              ? `${fmt(row.amount_min)} – ${fmt(row.amount_max)} (program funding level)`
              : `${fmt(row.amount_max ?? row.amount_min)} (program funding level)`
          await db
            .prepare(
              `UPDATE funding_opportunities
                  SET amount_min = NULL, amount_max = NULL, amount_text = ?,
                      amount_status = 'not_listed', amount_confidence = NULL
                WHERE id = ?`,
            )
            .run(text, row.id)
          await db
            .prepare(
              `UPDATE grants
                  SET amount_requested = CASE WHEN amount_requested IN (?, ?) THEN NULL ELSE amount_requested END,
                      amount_min = CASE WHEN amount_min = ? THEN NULL ELSE amount_min END,
                      amount_max = CASE WHEN amount_max = ? THEN NULL ELSE amount_max END
                WHERE funding_opportunity_id = ?
                  AND COALESCE(amount_awarded, 0) <= 0`,
            )
            .run(row.amount_min, row.amount_max, row.amount_min, row.amount_max, row.id)
          repairedStatus += 1
        }
      } catch (err) {
        log.warn('grant_amount_backfill: catalog amount-sanity net failed (non-fatal)', { error: String(err?.message || err) })
      }

      // Step 1: inherit award min/max from the linked catalog row when the
      // grant has neither. Guarded by EXISTS so we never null-out anything.
      if (grantCols.has('funding_opportunity_id')) {
        try {
          const result = await db
            .prepare(
              `UPDATE grants
                  SET amount_min = (
                        SELECT fo.amount_min FROM funding_opportunities fo
                         WHERE fo.id = grants.funding_opportunity_id
                      ),
                      amount_max = (
                        SELECT fo.amount_max FROM funding_opportunities fo
                         WHERE fo.id = grants.funding_opportunity_id
                      )
                WHERE COALESCE(grants.amount_min, 0) <= 0
                  AND COALESCE(grants.amount_max, 0) <= 0
                  AND grants.funding_opportunity_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM funding_opportunities fo
                     WHERE fo.id = grants.funding_opportunity_id
                       AND (COALESCE(fo.amount_min, 0) > 0 OR COALESCE(fo.amount_max, 0) > 0)
                  )`,
            )
            .run()
          repairedFromCatalog = changesOf(result)
        } catch (err) {
          // funding_opportunities absent on a minimal test DB → count-only below.
          log.warn('grant_amount_backfill: catalog-inherit query failed (non-fatal)', { error: String(err?.message || err) })
        }
      }

      // Step 2: default amount_requested from the grant's own ceiling/floor —
      // EXCEPT when the floor→ceiling spread is wider than
      // WIDE_AWARD_RANGE_RATIO. A "$1M–$42M" range is a program ENVELOPE, not
      // a realistic single award; defaulting the ask to the ceiling fabricated
      // ~$84M of pipeline value across two org profiles (the HUD Section 4
      // class). Wide ranges default to the FLOOR; the ceiling stays visible
      // in amount_max. WIDE_AWARD_RANGE_RATIO is a module numeric constant —
      // interpolation below is compile-time, not user input.
      try {
        const result = await db
          .prepare(
            `UPDATE grants
                SET amount_requested = CASE
                      WHEN COALESCE(amount_min, 0) > 0 AND COALESCE(amount_max, 0) > 0
                       AND amount_max > amount_min * ${Number(WIDE_AWARD_RANGE_RATIO)}
                      THEN amount_min
                      ELSE COALESCE(NULLIF(amount_max, 0), NULLIF(amount_min, 0))
                    END
              WHERE COALESCE(amount_requested, 0) <= 0
                AND (COALESCE(amount_max, 0) > 0 OR COALESCE(amount_min, 0) > 0)`,
          )
          .run()
        repairedRequested = changesOf(result)
      } catch (err) {
        log.warn('grant_amount_backfill: requested-default query failed (non-fatal)', { error: String(err?.message || err) })
      }

      // Step 3 (amount VISIBILITY, migrations 132/0136): derive the catalog's
      // amount_status from its own numeric fields (legacy rows predate the
      // column), then mirror text/status/confidence onto linked grants, then
      // stamp truly amount-less active grants 'not_listed' so pipeline cards
      // render an honest label instead of a blank. Statuses are LABELS about
      // what is known — never invented dollar values.
      if (grantCols.has('amount_status')) {
        try {
          await db
            .prepare(
              `UPDATE funding_opportunities
                  SET amount_status = CASE
                        WHEN COALESCE(amount_min, 0) > 0 AND amount_min = amount_max THEN 'known'
                        ELSE 'range'
                      END
                WHERE amount_status IS NULL
                  AND (COALESCE(amount_max, 0) > 0 OR COALESCE(amount_min, 0) > 0)`,
            )
            .run()
        } catch (err) {
          log.warn('grant_amount_backfill: catalog status derive failed (non-fatal)', { error: String(err?.message || err) })
        }

        // Step 3b (converging catalog TEXT sweep): rows ingested BEFORE the
        // extractor existed (or before its 2026-07-06 pattern expansion) have
        // stored title/description text that was never read for amounts. Run
        // the conservative extractor over the un-labeled backlog, bounded per
        // boot; rows where nothing is found get amount_status='not_listed' so
        // the WHERE clause converges to zero instead of rescanning forever.
        // Same precision doctrine as ingest: numeric values only from explicit
        // per-award phrasings; program-total/varies/contact become TEXT+status.
        try {
          const backlog = await db
            .prepare(
              `SELECT id, title, description, amount_description
                 FROM funding_opportunities
                WHERE COALESCE(amount_min, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0
                  AND amount_status IS NULL
                  AND amount_text IS NULL
                LIMIT 5000`,
            )
            .all()
          let extracted = 0
          for (const row of Array.isArray(backlog) ? backlog : []) {
            const resolved = resolveOpportunityAmounts({
              title: row.title,
              description: row.description,
              amount_description: row.amount_description,
            })
            const foundSomething =
              resolved.amount_min !== null || resolved.amount_max !== null ||
              resolved.amount_text !== null || resolved.amount_status !== 'not_listed'
            await db
              .prepare(
                `UPDATE funding_opportunities
                    SET amount_min = COALESCE(?, amount_min),
                        amount_max = COALESCE(?, amount_max),
                        amount_text = ?,
                        amount_status = ?,
                        amount_confidence = ?
                  WHERE id = ?`,
              )
              .run(
                resolved.amount_min,
                resolved.amount_max,
                resolved.amount_text,
                resolved.amount_status,
                resolved.amount_confidence,
                row.id,
              )
            if (foundSomething) extracted += 1
          }
          if (backlog.length > 0) {
            log.info('grant_amount_backfill: catalog text sweep', {
              scanned: backlog.length,
              extracted,
              remaining_hint: backlog.length === 5000 ? 'more next boot' : 'converged',
            })
          }
        } catch (err) {
          log.warn('grant_amount_backfill: catalog text sweep failed (non-fatal)', { error: String(err?.message || err) })
        }
        if (grantCols.has('funding_opportunity_id')) {
          try {
            const result = await db
              .prepare(
                `UPDATE grants
                    SET amount_text = (
                          SELECT fo.amount_text FROM funding_opportunities fo
                           WHERE fo.id = grants.funding_opportunity_id
                        ),
                        amount_status = (
                          SELECT fo.amount_status FROM funding_opportunities fo
                           WHERE fo.id = grants.funding_opportunity_id
                        ),
                        amount_confidence = (
                          SELECT fo.amount_confidence FROM funding_opportunities fo
                           WHERE fo.id = grants.funding_opportunity_id
                        )
                  WHERE (grants.amount_status IS NULL OR grants.amount_status = 'not_listed')
                    AND grants.funding_opportunity_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1 FROM funding_opportunities fo
                       WHERE fo.id = grants.funding_opportunity_id
                         AND fo.amount_status IS NOT NULL
                    )`,
              )
              .run()
            repairedStatus = changesOf(result)
          } catch (err) {
            log.warn('grant_amount_backfill: status mirror failed (non-fatal)', { error: String(err?.message || err) })
          }
        }
        try {
          // Grants with a real numeric value but no status yet (own-value rows).
          await db
            .prepare(
              `UPDATE grants
                  SET amount_status = CASE
                        WHEN COALESCE(amount_min, 0) > 0 AND amount_min = amount_max THEN 'known'
                        WHEN COALESCE(amount_max, 0) > 0 OR COALESCE(amount_min, 0) > 0 THEN 'range'
                        ELSE 'known'
                      END
                WHERE amount_status IS NULL
                  AND (COALESCE(amount_requested, 0) > 0
                    OR COALESCE(amount_max, 0) > 0
                    OR COALESCE(amount_min, 0) > 0)`,
            )
            .run()
          const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
          // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
          await db
            .prepare(
              `UPDATE grants
                  SET amount_status = 'not_listed'
                WHERE amount_status IS NULL
                  AND status IN (${statuses})
                  AND COALESCE(amount_requested, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0
                  AND COALESCE(amount_min, 0) <= 0
                  AND amount_text IS NULL`,
            )
            .run()
        } catch (err) {
          log.warn('grant_amount_backfill: grant status derive failed (non-fatal)', { error: String(err?.message || err) })
        }
      }
    }

    // Observability: active-pipeline rows still showing NO dollar value —
    // un-derivable from stored metadata. This is the crawler amount-extraction
    // quality signal Sam reports and Amy's flywheel probes.
    let missing = 0
    try {
      const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM grants
            WHERE status IN (${statuses})
              AND COALESCE(amount_requested, 0) <= 0
              AND COALESCE(amount_max, 0) <= 0
              AND COALESCE(amount_min, 0) <= 0`,
        )
        .get()
      missing = Number(row?.n) || 0
    } catch { /* non-fatal */ }

    const repaired = repairedFromCatalog + repairedRequested + repairedStatus
    if (repaired > 0) {
      log.info('backfilled pipeline grant amounts', {
        repairedFromCatalog,
        repairedRequested,
        repairedStatus,
        stillMissingAmount: missing,
        enforced: !disabled,
      })
    }
    return { scanned: repaired + missing, repaired, enforced: !disabled, missingAmount: missing, repairedStatus }
  })
}

/**
 * INVARIANT: pipeline lifecycle statuses tell the truth about who set them.
 *
 * A protected status ('submitted') means a HUMAN or Hamilton actually
 * submitted an application. Bulk imports / schema-repair backfills stamped
 * rows 'submitted' from the SOURCE's own listing status (grants.gov
 * "(posted)") with submitted_date NULL — permanently shielding never-scored,
 * often-ineligible rows from every purge/re-score sweep (the HUD Section 4
 * $42M rows). Detection is deliberately SURGICAL — all three must hold:
 *   1. status = 'submitted' with submitted_date IS NULL (no real submission)
 *   2. import/repair provenance: notes carry the adapter's
 *      "Funding opportunity … (posted)" summary OR match_explanation says
 *      admin_schema_repair
 *   3. no Hamilton submission artifacts implied (submitted_date is the
 *      canonical submission stamp; a real submit path always sets it)
 * Matching rows are demoted to 'discovered' so the score-backfill /
 * relevance-floor nets can finally judge them. A row a user REALLY submitted
 * (submitted_date set, or human notes) is never touched.
 *
 * OVERRIDE: ON by default; ENFORCE_STATUS_PROVENANCE=0 for count-only.
 */
export async function enforceImportedStatusHonesty(db) {
  return runInvariant('imported_status_honesty', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('status') || !grantCols.has('submitted_date')) {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }
    const disabled = _parseBoolEnv(process.env.ENFORCE_STATUS_PROVENANCE) === false

    // Compile-time constant fragment (no user input flows in).
    const SAFE_WHERE = `
        status = 'submitted'
        AND submitted_date IS NULL
        AND (
          notes LIKE 'Funding opportunity %(posted).%'
          OR notes LIKE 'Funding opportunity %(posted)'
          OR CAST(match_explanation AS TEXT) LIKE '%admin_schema_repair%'
        )`

    let scanned = 0
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM grants WHERE ${SAFE_WHERE}`).get()
      scanned = Number(row?.n) || 0
    } catch (err) {
      log.warn('imported_status_honesty: scan failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }
    if (scanned === 0) return { scanned: 0, repaired: 0, enforced: !disabled }
    if (disabled) {
      log.warn('import-stamped "submitted" rows present (demote DISABLED via ENFORCE_STATUS_PROVENANCE=0)', { rows: scanned })
      return { scanned, repaired: 0, enforced: false }
    }

    let repaired = 0
    try {
      const result = await db
        .prepare(`UPDATE grants SET status = 'discovered' WHERE ${SAFE_WHERE}`)
        .run()
      repaired = changesOf(result)
      if (repaired > 0) {
        log.info('demoted import-stamped submitted rows to discovered (no real submission ever happened)', { repaired })
      }
    } catch (err) {
      log.warn('imported_status_honesty: demote failed (non-fatal)', { error: String(err?.message || err) })
    }
    return { scanned, repaired, enforced: true }
  })
}

/**
 * INVARIANT: a relevant pipeline source's award amount is ACQUIRED when the
 * funder's own page states it (the "$0 pipeline full of real sources" class:
 * only ~18% of the catalog carries any dollar figure because ingest text is
 * often one aggregator sentence — nothing ever read the funder's page).
 *
 * Bounded per boot: for catalog rows LINKED TO ACTIVE PIPELINE grants that
 * have no numeric amount and no amount_text yet, fetch the source page
 * through the crawler-os production fetcher (SSRF/DNS-rebinding safe) and
 * run the conservative awardAmountExtractor over the page text. Numbers only
 * from explicit per-award phrasings; program totals stay text-only; nothing
 * is ever invented (G0). Attempted rows are remembered in system_kv so a
 * page that yields nothing is not re-fetched every boot.
 *
 * OVERRIDE: ON by default; ENFORCE_AMOUNT_ENRICHMENT=0 for count-only.
 * Bounds: AMOUNT_ENRICH_BOOT_LIMIT (default 10) fetches per boot,
 * AMOUNT_ENRICH_TIME_BUDGET_MS (default 20000). Callers with a bigger window
 * (the nightly sweep's dedicated enrichment pass) may override both via
 * deps.limit / deps.timeBudgetMs — the boot path stays cheap by default.
 */
/**
 * INVARIANT: A PIPELINE GRANT IS LINKED TO ITS CATALOG ROW WHEN ONE EXISTS
 * (the amount-answer census blind spot, 2026-07-17).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `enforceAmountEnrichment` and `enforceGrantAmountBackfill` both reach a grant
 * ONLY through `grants.funding_opportunity_id` — they JOIN or subquery on it. A
 * grant with that column NULL is therefore STRUCTURALLY invisible to every
 * amount net: it can never be enriched, can never inherit a catalog amount, and
 * shows up in `pipeline.amountCoverage` as `unanswered_no_catalog_row`. Prod
 * 2026-07-17: 82 of 313 active pipeline grants were unlinked, and the coverage
 * check (correctly) failed on the 70 of them with no amount — a real gap the
 * #954 census SURFACED but did not close.
 *
 * Many of those grants DO have a catalog twin — the crawler upserts a
 * `funding_opportunities` row AND a `grants` row from the same result
 * (`crawlerManager.js`), but the grant was written without the link. The two
 * rows share a URL, which is one of the tiers of the canonical dedup identity
 * (`canonicalOpportunityKey`: external_id → title+sponsor → URL), so a grant and
 * an active catalog row at the SAME url are the same real-world opportunity.
 *
 * THE RULE (high-precision; a wrong link is cross-profile bleed — never guess)
 * ---------------------------------------------------------------------------
 * Link an unlinked active-pipeline grant to a catalog row ONLY when ALL hold:
 *   1. URL IDENTITY — the grant's own URL (`url`/`application_url`), normalized
 *      (lowercase, trailing '/' stripped), equals a normalized URL on the
 *      catalog row (`source_url`/`url`/`application_url`).
 *   2. EXACTLY ONE active catalog row matches. Two or more is AMBIGUOUS (a
 *      shared directory URL) and is left alone — counted, never guessed. This is
 *      the same posture as `reconcileConvertedApplications` ("ambiguous matches
 *      flagged, never guessed").
 *   3. NO PROFILE CONFLICT — if BOTH rows carry a `profile_id` and they differ,
 *      skip. A profile-scoped catalog row belongs to a different pipeline; the
 *      URL coincidence must not cross that boundary (G4/G8). A NULL on either
 *      side is profile-agnostic and compatible.
 * Only NULL → value: an existing link is never touched. Idempotent (a linked
 * grant leaves the candidate set) and bounded (`GRANT_CATALOG_LINK_LIMIT`).
 *
 * It runs immediately BEFORE `enforceAmountEnrichment` so a grant linked this
 * boot gets its amount read/inherited in the SAME sweep — the whole point.
 *
 * OVERRIDE: ON by default; `ENFORCE_GRANT_CATALOG_LINK=0` for count-only.
 */
export async function enforceGrantCatalogLink(db, deps = {}) {
  return runInvariant('grant_catalog_link', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('funding_opportunity_id') || !grantCols.has('url')) {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }
    const disabled = _parseBoolEnv(process.env.ENFORCE_GRANT_CATALOG_LINK) === false
    const LIMIT = Math.max(1, Number(deps.limit ?? process.env.GRANT_CATALOG_LINK_LIMIT) || 500)
    const scopedGrantIds = Array.isArray(deps.grantIds)
      ? [...new Set(deps.grantIds.map(String).filter(Boolean))]
      : null
    if (scopedGrantIds && scopedGrantIds.length === 0) {
      return { scanned: 0, repaired: 0, enforced: !disabled }
    }

    // RTRIM(x, '/') strips trailing slashes on BOTH sqlite and postgres (both
    // read the 2nd arg as a character set). LOWER folds case. Kept as one
    // expression so the candidate scan and the per-row match use IDENTICAL
    // normalization — a mismatch there would link on a near-miss.
    const norm = (col) => `RTRIM(LOWER(COALESCE(${col}, '')), '/')`
    const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')

    let candidates = []
    try {
      // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
      const scopeSql = scopedGrantIds
        ? ` AND g.id IN (${scopedGrantIds.map(() => '?').join(', ')})`
        : ''
      // audit:allow dynamic-sql — scopeSql contains placeholders only; ids stay bound.
      candidates = await db
        .prepare(
          `SELECT g.id, g.profile_id,
                  ${norm('g.url')} AS u1, ${norm('g.application_url')} AS u2
             FROM grants g
            WHERE g.status IN (${statuses})
              AND g.funding_opportunity_id IS NULL
              AND COALESCE(g.url, g.application_url, '') <> ''
              ${scopeSql}
             ORDER BY g.id ASC
             LIMIT ?`,
        )
        .all(...(scopedGrantIds || []), LIMIT)
    } catch (err) {
      log.warn('grant_catalog_link: candidate scan failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }

    const fresh = Array.isArray(candidates) ? candidates : []
    if (fresh.length === 0) return { scanned: 0, repaired: 0, enforced: !disabled }

    let linked = 0
    let ambiguous = 0
    let unlinkable = 0
    for (const g of fresh) {
      // The grant carries at least one non-empty normalized URL (WHERE guard).
      const urls = [g.u1, g.u2].filter((u) => u && u.length)
      let matches = []
      try {
        // Match ANY of the grant's URLs against ANY catalog URL column, on an
        // ACTIVE row, that is profile-compatible. DISTINCT id so a row matching
        // on two columns counts once. The profile guard: skip a catalog row
        // owned by a DIFFERENT profile than the grant (a URL coincidence must
        // not cross a pipeline boundary); NULL on either side is compatible.
        // Catalog URL columns that exist in BOTH dialects. Prod Postgres also
        // has a bare `url` column, but the SQLite schema does not, and a live
        // probe confirmed `url` adds ZERO matches the other three columns miss —
        // so referencing it would break CI (SQLite) for no coverage. Schema
        // drift is the hazard, not the missing column (the #946/#954 lesson).
        const placeholders = urls.map(() => '?').join(', ')
        matches = await db
          .prepare(
            `SELECT DISTINCT fo.id, fo.profile_id
               FROM funding_opportunities fo
              WHERE fo.is_active
                AND (
                     ${norm('fo.source_url')} IN (${placeholders})
                  OR ${norm('fo.application_url')} IN (${placeholders})
                  OR ${norm('fo.evidence_url')} IN (${placeholders})
                )`,
          )
          .all(...urls, ...urls, ...urls)
      } catch (err) {
        log.warn('grant_catalog_link: match query failed (non-fatal)', { grant: g.id, error: String(err?.message || err) })
        continue
      }

      const compatible = (Array.isArray(matches) ? matches : []).filter((m) => {
        const gp = g.profile_id === null || g.profile_id === undefined ? '' : String(g.profile_id)
        const fp = m.profile_id === null || m.profile_id === undefined ? '' : String(m.profile_id)
        // Compatible unless BOTH sides name a profile and they disagree.
        return !(gp && fp && gp !== fp)
      })

      if (compatible.length === 0) { unlinkable++; continue }
      if (compatible.length > 1) { ambiguous++; continue } // never guess

      if (disabled) { linked++; continue } // count-only: what WOULD link
      try {
        // Guarded to NULL → value: the WHERE re-asserts the row is still
        // unlinked, so a concurrent writer that linked it first is never
        // overwritten. is_active is re-checked so a row deactivated between
        // scan and write is not linked.
        const res = await db
          .prepare(
            `UPDATE grants
                SET funding_opportunity_id = ?
              WHERE id = ?
                AND funding_opportunity_id IS NULL
                AND EXISTS (SELECT 1 FROM funding_opportunities fo WHERE fo.id = ? AND fo.is_active)`,
          )
          .run(compatible[0].id, g.id, compatible[0].id)
        if (changesOf(res) > 0) linked++
      } catch (err) {
        log.warn('grant_catalog_link: link write failed (non-fatal)', { grant: g.id, error: String(err?.message || err) })
      }
    }

    if (linked > 0) {
      log.info('linked unlinked pipeline grants to their catalog rows', { linked, ambiguous, unlinkable, enforced: !disabled })
    }
    return { scanned: fresh.length, repaired: linked, ambiguous, unlinkable, enforced: !disabled }
  })
}

/**
 * INVARIANT: A LOCATOR/BENEFIT PAGE CARRIES ITS HONEST KIND (prod triage
 * 2026-07-21).
 *
 * The amount-answer census (`pipeline.amountCoverage`) had two standing MISS
 * blocks nothing could ever answer by reading:
 *
 *   - sam.gov `/fal/<uuid>/view` (43 rows) — SAM.gov Assistance Listings: the
 *     CFDA PROGRAM directory. A listing page describes a program and points at
 *     where opportunities post; it is a locator, never an award.
 *   - ssa.gov benefit sections (30 rows, `/survivor`, `/disability`, …) —
 *     federal benefit programs with no fixed per-applicant award figure.
 *
 * Both are the "no-per-award-figure BY DESIGN" class the census's own
 * recommended_fix names ("classify as a BENEFIT/DIRECTORY kind so it counts as
 * no-amount-by-design"). This sweep applies that classification by a POSITIVE
 * structural URL-shape rule (services/sources/locatorUrlKind.js) — the rows
 * leave the census denominator because of what the page IS, never via a
 * fabricated `none_published` denial for a page that was never read (silence
 * is not a denial; a denial requires page_read===true).
 *
 * SAFETY: writes where `opportunity_kind` was never recorded (NULL/'') — OR
 * where it holds one of the GENERIC MACHINE-STAMPED ingest kinds
 * (GENERIC_OVERRIDABLE_KINDS below). Prod 2026-07-22: 12 studentaid.gov FAFSA
 * portal rows and 6 ProPublica 990 profile pages sat permanently in the
 * census's `unreadable` bucket because an ingest writer had stamped them
 * 'PROGRAM'/'DIRECT_GRANT'/'direct' — a generated default, not a judgment —
 * and the blanket never-overwrite rule froze the misclassification in place.
 * The structural URL rule is a verified positive claim about what the page IS;
 * it outranks a generated default, and ONLY a generated default: a row
 * carrying 'directory'/'benefit'/any value outside the explicit allowlist is
 * never touched. Bounded per boot; idempotent (a classified row leaves the
 * candidate set).
 *
 * OVERRIDE: ON by default; `ENFORCE_LOCATOR_KIND_CLASSIFICATION=0` = count-only.
 */

/**
 * GENERIC_OVERRIDABLE_KINDS now lives beside the structural rules themselves
 * (services/sources/locatorUrlKind.js) so the sweep and the upsert WRITERS
 * share one list by construction; re-exported here for existing consumers.
 */
export { GENERIC_OVERRIDABLE_KINDS }

export async function enforceLocatorKindClassification(db, deps = {}) {
  return runInvariant('locator_kind_classification', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_LOCATOR_KIND_CLASSIFICATION) === false
    const LIMIT = Math.max(1, Number.parseInt(deps.limit ?? process.env.LOCATOR_KIND_BOOT_LIMIT ?? '500', 10) || 500)

    let candidates = []
    try {
      // LIKE prefilter narrows the scan to the shapes the positive rules know
      // — the pattern list is EXPORTED BY the classifier module
      // (LOCATOR_URL_LIKE_PREFILTERS) so a rule added there is automatically
      // scanned here (gate finding: a hand-copied two-host list silently
      // orphaned every newer rule). The REAL decision is the pure classifier
      // below — a LIKE hit that fails the structural shape is left untouched.
      const likeClauses = LOCATOR_URL_LIKE_PREFILTERS
        .map(() => `COALESCE(source_url, '') LIKE ? OR COALESCE(application_url, '') LIKE ? OR COALESCE(evidence_url, '') LIKE ?`)
        .join(' OR ')
      const likeParams = LOCATOR_URL_LIKE_PREFILTERS.flatMap((p) => [p, p, p])
      const overridable = GENERIC_OVERRIDABLE_KINDS.map(() => '?').join(', ')
      // audit:allow dynamic-sql — likeClauses/overridable are built from frozen lists; values stay bound.
      candidates = await db
        .prepare(
          `SELECT id, source_url, application_url, evidence_url
             FROM funding_opportunities
            WHERE (opportunity_kind IS NULL OR TRIM(opportunity_kind) = '' OR opportunity_kind IN (${overridable}))
              AND (${likeClauses})
            LIMIT ?`,
        )
        .all(...GENERIC_OVERRIDABLE_KINDS, ...likeParams, LIMIT)
    } catch (err) {
      // Minimal/legacy schema (no evidence_url etc.) → count nothing, never throw.
      log.warn('locator_kind_classification: candidate scan failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }

    const rows = Array.isArray(candidates) ? candidates : []
    let repaired = 0
    let byKind = { directory: 0, benefit: 0 }
    for (const row of rows) {
      const verdict = classifyLocatorKindFromRow(row)
      if (!verdict) continue
      if (disabled) { repaired++; byKind[verdict.kind]++; continue } // count-only: what WOULD classify
      try {
        // Guard re-asserted in the WHERE so a kind written between scan and
        // update (another sweep, an admin) is never clobbered — the same
        // NULL/''/generic-overridable set as the scan, nothing wider.
        const overridable = GENERIC_OVERRIDABLE_KINDS.map(() => '?').join(', ')
        // audit:allow dynamic-sql — overridable placeholders from the frozen list; values stay bound.
        const res = await db
          .prepare(
            `UPDATE funding_opportunities
                SET opportunity_kind = ?,
                    result_kind = COALESCE(NULLIF(TRIM(COALESCE(result_kind, '')), ''), ?)
              WHERE id = ?
                AND (opportunity_kind IS NULL OR TRIM(opportunity_kind) = '' OR opportunity_kind IN (${overridable}))`,
          )
          .run(verdict.kind, verdict.kind, row.id, ...GENERIC_OVERRIDABLE_KINDS)
        if (changesOf(res) > 0) { repaired++; byKind[verdict.kind]++ }
      } catch (err) {
        log.warn('locator_kind_classification: write failed (non-fatal)', { opportunity: row.id, error: String(err?.message || err) })
      }
    }

    if (repaired > 0) {
      log.info(disabled
        ? 'locator/benefit rows WOULD be classified (ENFORCE_LOCATOR_KIND_CLASSIFICATION=0)'
        : 'classified locator/benefit catalog rows by positive URL shape', {
        scanned: rows.length, repaired, ...byKind, enforced: !disabled,
      })
    }
    return { scanned: rows.length, repaired: disabled ? 0 : repaired, wouldRepair: disabled ? repaired : undefined, ...byKind, enforced: !disabled }
  })
}

/**
 * system_kv key: rolling ring of the most recent amount-enrichment FAILURES
 * (HTTP status + short reason per row, newest last).
 *
 * WHY. The grants.gov adapter had effectively NEVER succeeded from Railway —
 * a WAF 403 on every datacenter-egress call (prod 2026-07-21: 127 attempted,
 * 0 evidenced answers; the identical keyless call works from a residential
 * machine) — and NOTHING recorded the failing status anywhere. The sweep
 * summary counts `fetchFailed` but not WHY, so diagnosing this outage class
 * required ad-hoc prod spelunking. This ring is the read side: each failed
 * enrich attempt leaves { status, reason, environment } behind, so "every
 * recent failure is http_403 environment:true" is one system_kv read away
 * (Sam/Anya-visible per the agent-observability rule).
 */
export const AMOUNT_ENRICH_FAILURE_LOG_KEY = 'amount_enrich_failure_log'
/** Ring size: enough to show a pattern, small enough to stay a cheap KV row. */
const AMOUNT_ENRICH_FAILURE_LOG_MAX = 50

async function appendAmountEnrichFailureLog(db, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return
  try {
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    let prior = []
    try {
      const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ENRICH_FAILURE_LOG_KEY)
      const parsed = row?.value ? JSON.parse(row.value) : null
      prior = Array.isArray(parsed?.failures) ? parsed.failures : []
    } catch { prior = [] }
    const iso = new Date().toISOString()
    const failures = [...prior, ...entries].slice(-AMOUNT_ENRICH_FAILURE_LOG_MAX)
    const value = JSON.stringify({ updated_at: iso, failures })
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, iso, AMOUNT_ENRICH_FAILURE_LOG_KEY)
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(AMOUNT_ENRICH_FAILURE_LOG_KEY, value, iso)
    }
  } catch { /* telemetry is best-effort — never fail the sweep it observes */ }
}

/** One failure-ring entry from an enrich result. Pure; shared by both sweeps. */
function amountEnrichFailureEntry({ lane, id, res }) {
  return {
    at: new Date().toISOString(),
    lane,
    id: String(id),
    status: Number.isFinite(Number(res?.status)) ? Number(res.status) : null,
    reason: String(res?.reason ?? 'unknown').slice(0, 120),
    transient: res?.transient === true,
    environment: res?.environment === true,
  }
}

/**
 * SYSTEMIC-BURN GUARD (the 2026-07-22 mass burn).
 *
 * A "stable" failure is a per-ROW judgment: 404/410, an in-band API refusal of
 * this id, a JS-shell thin_page — facts another try cannot change, so the row
 * burns. But eleven minutes after #1006 deployed, ONE sweep run burned 34
 * grants.gov rows in ~5 seconds, each failing ~150ms apart with the SAME
 * stable-class reason — and every one of those ids answers perfectly today
 * (verified live from the prod egress, 2026-07-25). That was the API having a
 * degraded incident, not 34 facts about 34 rows: when EVERY row of a host
 * fails identically in one run and NOT ONE row of that host was successfully
 * read, the failure describes the run, not the rows.
 *
 * So a stable failure is no longer burned inline. It is DEFERRED to the end of
 * the run and burned only if its (host, reason) group stayed below the
 * systemic streak limit or the same host also produced a real read this run
 * (proof the source was alive, so the failures are genuinely row-specific).
 * A group at/over the limit with zero same-host reads is reclassified as an
 * ENVIRONMENT-style outcome: no burn, no ordinary-retry spend, env-counter
 * incremented — which parks the rows on the existing blocked lane
 * (`unanswered_blocked`, slow re-probe) where a real outage is VISIBLE and
 * recoverable instead of silently permanent.
 *
 * Pure; exported for tests.
 *
 * @param {Array<{id:string, host:string|null, reason:string|null}>} pending
 * @param {Set<string>} readHosts hosts that produced page_read:true this run
 * @param {number} streakLimit group size at which a uniform failure is systemic
 * @returns {{burnNow: Array, systemic: Array}}
 */
export function partitionSystemicStableFailures(pending, readHosts, streakLimit) {
  const rows = Array.isArray(pending) ? pending : []
  const groups = new Map()
  const keyOf = (p) => `${p?.host ?? 'unknown'}|${p?.reason ?? 'unknown'}`
  for (const p of rows) groups.set(keyOf(p), (groups.get(keyOf(p)) ?? 0) + 1)
  const burnNow = []
  const systemic = []
  for (const p of rows) {
    const uniform = (groups.get(keyOf(p)) ?? 0) >= streakLimit
    const hostAlive = Boolean(p?.host) && readHosts instanceof Set && readHosts.has(p.host)
    if (uniform && !hostAlive) systemic.push(p)
    else burnNow.push(p)
  }
  return { burnNow, systemic }
}

/** Hostname (no www.) of the first URL a row carries, or null. Pure. */
function amountEnrichHostOf(...urls) {
  for (const url of urls) {
    if (!url) continue
    try { return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase() } catch { /* next */ }
  }
  return null
}

export async function enforceAmountEnrichment(db, deps = {}) {
  return runInvariant('amount_enrichment', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_AMOUNT_ENRICHMENT) === false
    const LIMIT = Math.max(1, Number.parseInt(deps.limit ?? process.env.AMOUNT_ENRICH_BOOT_LIMIT ?? '10', 10) || 10)
    const TIME_BUDGET_MS = Math.max(1000, Number.parseInt(deps.timeBudgetMs ?? process.env.AMOUNT_ENRICH_TIME_BUDGET_MS ?? '20000', 10) || 20000)
    const MAX_ATTEMPTS = Math.max(1, Number.parseInt(deps.maxAttempts ?? process.env.AMOUNT_ENRICH_MAX_ATTEMPTS ?? '3', 10) || 3)
    const scopedOpportunityIds = Array.isArray(deps.opportunityIds)
      ? [...new Set(deps.opportunityIds.map(String).filter(Boolean))]
      : null
    if (scopedOpportunityIds && scopedOpportunityIds.length === 0) {
      return { scanned: 0, repaired: 0, enforced: !disabled }
    }

    // Catalog rows worth enriching: linked to an ACTIVE pipeline grant, no
    // numeric amount, no text yet (or explicitly not_listed), has a page, and
    // NOT already attempted.
    //
    // The attempted-exclusion MUST be part of this query, not a JS filter after
    // it. The previous implementation SELECTed `LIMIT 200` and then dropped
    // already-attempted rows in JS: once those 200 arbitrary rows had all been
    // tried (~2 nights at the nightly budget), every subsequent run filtered
    // them all away, reported "0 candidates", and never reached row 201. The
    // sweep read as green while doing nothing — which is why raising the
    // nightly budget to 120 on 2026-07-08 left coverage pinned at ~12%.
    const ENV_MAX = Math.max(1, Number.parseInt(deps.envMaxAttempts ?? AMOUNT_ENRICH_ENV_MAX_ATTEMPTS, 10) || AMOUNT_ENRICH_ENV_MAX_ATTEMPTS)
    const ENV_REPROBE = Math.max(0, Number.parseInt(deps.envReprobeLimit ?? AMOUNT_ENRICH_ENV_REPROBE_LIMIT, 10) || 0)

    let candidates = []
    let blockedProbe = []
    let attemptedColumnMissing = false
    try {
      const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
      // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
      const scopeSql = scopedOpportunityIds
        ? ` AND fo.id IN (${scopedOpportunityIds.map(() => '?').join(', ')})`
        : ''
      // Shared candidate predicate. ${'${envPredicate}'} splits it into two
      // DISJOINT lanes so an environment-BLOCKED row (env failures >= ENV_MAX —
      // our egress is WAF/auth-blocked for its host) can never occupy the main
      // bounded batch: before this split, low-id blocked rows re-entered the
      // batch every run (attempts=0 sorts first) and starved valid
      // never-attempted rows out of the budget entirely.
      const candidateSql = (envPredicate, orderSql) =>
        // fo.source / fo.source_id / fo.record_origin are what the amount
        // ADAPTER registry routes on (services/sources/amountAdapters.js): the
        // source identifies whose API can answer this row, and source_id (the
        // opportunity NUMBER) is how a row whose URL carries no numeric id is
        // resolved. Selecting only URLs would silently degrade every adapter
        // to URL-pattern matching and drop the rows that need it most.
        `SELECT DISTINCT fo.id, fo.title, fo.source_url, fo.application_url, fo.evidence_url,
                fo.source, fo.source_id, fo.record_origin,
                COALESCE(fo.amount_enrich_attempts, 0) AS attempts,
                COALESCE(fo.amount_enrich_env_attempts, 0) AS env_attempts
           FROM funding_opportunities fo
           JOIN grants g ON g.funding_opportunity_id = fo.id
          WHERE g.status IN (${statuses})
            AND COALESCE(fo.amount_min, 0) <= 0
            AND COALESCE(fo.amount_max, 0) <= 0
            AND (fo.amount_status IS NULL OR fo.amount_status = 'not_listed')
            AND fo.amount_text IS NULL
            AND fo.amount_enrich_attempted_at IS NULL
            AND COALESCE(fo.source_url, fo.application_url, fo.evidence_url) IS NOT NULL
            AND ${envPredicate}
            ${scopeSql}
          ORDER BY ${orderSql}
          LIMIT ?`
      // audit:allow dynamic-sql — envPredicate/orderSql are the frozen literals below; ids stay bound.
      candidates = await db
        .prepare(candidateSql(
          `COALESCE(fo.amount_enrich_env_attempts, 0) < ${ENV_MAX}`,
          'COALESCE(fo.amount_enrich_attempts, 0) ASC, fo.id ASC',
        ))
        .all(...(scopedOpportunityIds || []), Math.max(LIMIT, 1))
      // The SLOWER re-probe lane: blocked rows stay re-checkable (the block
      // lifts the moment a probe gets a non-environment outcome) but at most
      // ENV_REPROBE of them per run, OVER the main budget — never instead of a
      // fresh row. Least-blocked first so a newly-blocked row is confirmed
      // before an anciently-blocked one is re-polled.
      if (ENV_REPROBE > 0) {
        blockedProbe = await db
          .prepare(candidateSql(
            `COALESCE(fo.amount_enrich_env_attempts, 0) >= ${ENV_MAX}`,
            'COALESCE(fo.amount_enrich_env_attempts, 0) ASC, fo.id ASC',
          ))
          .all(...(scopedOpportunityIds || []), ENV_REPROBE)
      }
    } catch (err) {
      // A DB that predates ensureAmountVisibilityColumns() has no attempted
      // column. Count-only rather than silently falling back to the wedged
      // ring — boot re-asserts the column, so this self-heals next start.
      attemptedColumnMissing = /amount_enrich_attempted_at|amount_enrich_env_attempts/i.test(String(err?.message || err))
      log.warn('amount_enrichment: candidate scan failed (non-fatal)', {
        error: String(err?.message || err),
        attemptedColumnMissing,
      })
      return { scanned: 0, repaired: 0, skipped: attemptedColumnMissing ? 'schema' : 'query' }
    }

    const fresh = [...(candidates || []), ...(blockedProbe || [])]
    if (fresh.length === 0) return { scanned: 0, repaired: 0, enforced: !disabled }
    if (disabled) {
      log.warn('amount-less active pipeline sources present (enrichment DISABLED via ENFORCE_AMOUNT_ENRICHMENT=0)', {
        candidates: fresh.length,
      })
      return { scanned: fresh.length, repaired: 0, enforced: false }
    }

    const { enrichOpportunityAmountFromSource } =
      deps.enrichImpl ? { enrichOpportunityAmountFromSource: deps.enrichImpl } : await import('../services/amountEnrichment.js')

    // Record one try. `attempts` always increments; `amount_enrich_attempted_at`
    // is the PERMANENT one-shot mark and is set only when we have actually
    // learned this row's answer:
    //
    //   - page_read      → the extractor scanned real copy. Done either way: an
    //                      amount found, or an honest "this page states none".
    //   - !transient     → a stable fact about the URL (404/410, or a JS shell
    //                      that will be thin every night). Another fetch cannot
    //                      teach us more, so stop asking.
    //   - out of retries → transient, but it has had MAX_ATTEMPTS bad nights.
    //                      Give up rather than re-fetch it forever. EXCEPTION:
    //                      an ENVIRONMENT failure (`environment: true` — WAF
    //                      403/401/429 on OUR egress) neither burns nor counts
    //                      an attempt; see the loop below.
    //
    // Everything else stays NULL and is retried — which is what the invariant
    // table has always CLAIMED ("a provider outage never burns a candidate's
    // one chance") but the code did not do: it marked unconditionally and put
    // the retry rule in a catch block that the service — documented "never
    // throws" — could not reach. Prod 2026-07-15: 30 rows burned, 0 amounts.
    // `envAttempts` is the CONSECUTIVE-environment-failure counter (migration
    // 151/0155): incremented only on an environment failure, reset to 0 by ANY
    // other outcome — success, denial, ordinary transient — because "the egress
    // un-blocked" is exactly what a non-environment outcome proves. It is
    // written in the same statement as the ordinary counters so the two can
    // never drift apart on a partial write.
    const recordAttempt = async (id, { burn, attempts, envAttempts = 0, reason = null }) => {
      try {
        await db
          .prepare(
            `UPDATE funding_opportunities
                SET amount_enrich_attempts = ?,
                    amount_enrich_env_attempts = ?,
                    amount_enrich_attempted_at = COALESCE(?, amount_enrich_attempted_at),
                    amount_enrich_last_reason = ?
              WHERE id = ?`,
          )
          .run(attempts, envAttempts, burn ? new Date().toISOString() : null, reason, id)
      } catch { /* best-effort; a missed mark only costs one re-fetch */ }
    }

    const startedAt = Date.now()
    let attemptedNow = 0
    let enriched = 0
    let textOnly = 0
    // Rows whose source was read and honestly states no per-award figure. NOT a
    // failure: it is the sweep learning the answer, and the only thing that lets
    // a coverage metric stop counting the row as a miss forever.
    let nonePublished = 0
    let fetchFailed = 0
    let retryable = 0
    let envBlocked = 0
    const failureLog = []
    // Deferred stable failures + the hosts that proved alive this run — the
    // systemic-burn guard's inputs (see partitionSystemicStableFailures).
    const pendingStable = []
    const readHosts = new Set()
    // The re-probe rows ride OVER the main budget by contract ("at most
    // ENV_REPROBE per run, over and above the main batch") — capping the loop
    // at LIMIT alone would let a full main batch silently swallow the re-probe
    // slots, and a blocked row would then never be re-checked at all. The time
    // budget still bounds the whole pass.
    const ATTEMPT_CAP = LIMIT + (blockedProbe?.length ?? 0)
    for (const cand of fresh) {
      if (attemptedNow >= ATTEMPT_CAP) break
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      attemptedNow++
      try {
        const res = await enrichOpportunityAmountFromSource(cand, deps)
        // ENVIRONMENT failure (adapter `environment: true` — WAF 403 / 401 /
        // 429): OUR egress is blocked, a fact about the DEPLOY, never about the
        // row. It must not consume the row's retry budget NOR burn it via
        // out-of-retries: a blocked environment fails every row identically
        // until an owner action (register GRANTS_GOV_API_KEY / change egress)
        // fixes it, and burning on it converts a config outage into permanent
        // answerless rows (prod 2026-07-21: the grants.gov adapter had NEVER
        // succeeded from Railway — WAF 403 on every call — yet each 4xx read
        // as "stable" and burned the row's one-shot mark blank).
        const environmentBlocked = res?.environment === true && res?.page_read !== true
        const attempts = Number(cand.attempts ?? 0) + (environmentBlocked ? 0 : 1)
        const envAttempts = environmentBlocked ? Number(cand.env_attempts ?? 0) + 1 : 0
        // The service never throws, so this — not a catch block — is the only
        // place the outage-must-not-burn rule can actually be enforced.
        const outOfRetries = attempts >= MAX_ATTEMPTS
        // A STABLE failure (not transient, not environment, nothing read) no
        // longer burns inline: it is deferred to the end of the run so the
        // systemic-burn guard can tell "34 facts about 34 rows" from "one bad
        // afternoon at the API" (the 2026-07-22 mass burn).
        const stableFailure = res?.page_read !== true && !environmentBlocked && res?.transient !== true
        const burn = res?.page_read === true
          || (!environmentBlocked && !stableFailure && outOfRetries)
        if (res?.page_read === true) {
          readHosts.add(amountEnrichHostOf(cand.source_url, cand.application_url, cand.evidence_url))
        } else {
          fetchFailed++
          if (environmentBlocked) envBlocked++
          if (!burn && !stableFailure) retryable++
          // Telemetry: WHY it failed (status + reason), so an outage class like
          // the WAF-403 block is diagnosable from system_kv instead of a prod
          // DB spelunk. Recorded for every enrich failure, burned or not.
          failureLog.push(amountEnrichFailureEntry({ lane: 'catalog', id: cand.id, res }))
        }
        // The mark is recorded AFTER the writes below, never before. It used to
        // run here — so when a write threw, the row was already burned and the
        // catch block's "non-fatal, will retry" was a LIE: the candidate query
        // excludes marked rows, so it could never be retried. That is not
        // hypothetical: the grants.gov adapter shipped returning the STRING
        // 'high' for `amount_confidence` (a REAL column). Postgres threw
        // `invalid input syntax for type real: "high"`, and 10 rows whose
        // amounts the API had ALREADY returned were burned holding nothing.
        // Every unit test passed — SQLite is typeless.
        //
        // Burn on what we LEARNED and successfully STORED, not on what we tried.
        if (res?.found && res.amounts) {
          await db
            .prepare(
              `UPDATE funding_opportunities
                  SET amount_min = ?, amount_max = ?, amount_text = ?,
                      amount_status = ?, amount_confidence = ?
                WHERE id = ?
                  AND COALESCE(amount_min, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0`,
            )
            .run(
              res.amounts.amount_min, res.amounts.amount_max, res.amounts.amount_text,
              res.amounts.amount_status, res.amounts.amount_confidence, cand.id,
            )
          enriched++
        } else if (res?.page_read === true) {
          // The source's own page/API was READ and states no per-award figure.
          // That is an ANSWER about this row, and until now it was thrown away:
          // the branch only wrote a status when it was NOT 'not_listed', which
          // is precisely the value the extractor returns for "read it, no figure
          // here". So the one fact worth recording — a DENIAL, gathered nightly
          // at real fetch cost — was the one fact never written down, and the
          // row became indistinguishable from one nothing had ever looked at.
          //
          // Downstream (pipeline.amountCoverage, Amy's amount_recall_miss) that
          // conflation is the difference between "the crawler missed an amount"
          // and "this funder publishes none" — an unreachable bar vs a real one.
          //
          // A better label the page DID state ('varies', 'contact_required', a
          // program-total excerpt) is more informative than the bare denial, so
          // it wins; `none_published` is the floor, not an override.
          const readStatus =
            res.amount_status && res.amount_status !== 'not_listed'
              ? res.amount_status
              : AMOUNT_STATUS_NONE_PUBLISHED
          await db
            .prepare(
              // Guarded to silence-or-nothing: a row that already carries an
              // honest status (or a real amount that landed between the scan and
              // now) is never downgraded by a later read.
              `UPDATE funding_opportunities
                  SET amount_text = COALESCE(?, amount_text),
                      amount_status = ?
                WHERE id = ?
                  AND (amount_status IS NULL OR amount_status = 'not_listed')
                  AND COALESCE(amount_min, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0`,
            )
            .run(res.amount_text ?? null, readStatus, cand.id)
          if (readStatus === AMOUNT_STATUS_NONE_PUBLISHED) nonePublished++
          else textOnly++
        }
        // Reached only when every write above SUCCEEDED. A stable failure has
        // NO data write, so deferring its mark to the post-loop guard cannot
        // violate the mark-after-write rule.
        if (stableFailure) {
          pendingStable.push({
            id: cand.id,
            host: amountEnrichHostOf(cand.source_url, cand.application_url, cand.evidence_url),
            reason: res?.reason ?? null,
            baseAttempts: Number(cand.attempts ?? 0),
            baseEnvAttempts: Number(cand.env_attempts ?? 0),
          })
        } else {
          await recordAttempt(cand.id, { burn, attempts, envAttempts, reason: res?.reason ?? null })
        }
      } catch (err) {
        // enrichOpportunityAmountFromSource is documented "never throws" and
        // returns its failures, so reaching here means a DB WRITE above failed.
        // The row is deliberately left UNMARKED, which is what makes the
        // "will retry" below true rather than a comforting lie — the mark now
        // runs only after the writes succeed. Do NOT move the retry rule into
        // this block: that was the original #944 bug (the guard sat in an
        // unreachable path while the mark ran unconditionally).
        fetchFailed++
        retryable++
        log.warn('amount_enrichment: write failed — row left unmarked so it WILL be retried', {
          opportunity: cand.id, error: String(err?.message || err),
        })
      }
    }

    // The systemic-burn guard: burn each deferred stable failure only if its
    // (host, reason) group stayed under the streak limit or its host also
    // produced a real read this run; a uniform group with a silent host is an
    // OUTAGE and parks on the environment-blocked lane instead of burning.
    const SYSTEMIC_STREAK = Math.max(
      2,
      Number.parseInt(deps.systemicStreakLimit ?? process.env.AMOUNT_ENRICH_SYSTEMIC_STREAK ?? '4', 10) || 4,
    )
    const { burnNow, systemic } = partitionSystemicStableFailures(pendingStable, readHosts, SYSTEMIC_STREAK)
    for (const p of burnNow) {
      await recordAttempt(p.id, { burn: true, attempts: p.baseAttempts + 1, envAttempts: 0, reason: p.reason })
    }
    for (const p of systemic) {
      envBlocked++
      retryable++
      await recordAttempt(p.id, { burn: false, attempts: p.baseAttempts, envAttempts: p.baseEnvAttempts + 1, reason: p.reason })
    }
    if (systemic.length > 0) {
      log.warn('amount_enrichment: SYSTEMIC stable-failure signature — burns withheld, rows parked environment-blocked', {
        withheld: systemic.length,
        streakLimit: SYSTEMIC_STREAK,
        groups: [...new Set(systemic.map((p) => `${p.host ?? 'unknown'}|${p.reason ?? 'unknown'}`))].slice(0, 5),
      })
    }

    // Remaining backlog, so Anya's report can show this converging (or not)
    // instead of only ever seeing this pass's bounded slice.
    //
    // `remaining` ALONE cannot tell success from exhaustion: it counts only
    // never-marked rows, so it falls to 0 both when every row got an amount and
    // when every row was tried and yielded nothing. Those look identical in the
    // report, and the second is the failure this fix exists for. So also count
    // `exhausted` — rows we are permanently done with that still carry no
    // dollar figure. remaining→0 with a large `exhausted` is the sweep finishing
    // with the coverage gap INTACT, which means the pages do not state amounts
    // and the answer is an adapter (grants.gov and sam.gov both have APIs), not
    // more fetching.
    let remaining = null
    let exhausted = null
    try {
      const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
      // TWO DIFFERENT QUESTIONS — do not re-merge these predicates.
      //
      // `remaining` = "how many rows are still WAITING for a read?", so it must
      // mirror the CANDIDATE query exactly (silence-only status, no amount text)
      // or it reports a backlog the sweep would never actually pick up.
      //
      // `exhausted` = "done with, still no dollar figure" — a fact about the
      // OUTCOME, which the invariant table defines without reference to status or
      // text. It must therefore NOT filter on them: once a read records its
      // answer (`none_published`, or a 'varies' label), the row is precisely what
      // `exhausted` exists to count, and a shared predicate silently dropped it
      // from BOTH buckets — making a fully-answered fleet look like an empty one.
      const stillUnread = `COALESCE(fo.amount_min, 0) <= 0
              AND COALESCE(fo.amount_max, 0) <= 0
              AND (fo.amount_status IS NULL OR fo.amount_status = 'not_listed')
              AND fo.amount_text IS NULL
              AND COALESCE(fo.source_url, fo.application_url, fo.evidence_url) IS NOT NULL`
      const noFigure = `COALESCE(fo.amount_min, 0) <= 0
              AND COALESCE(fo.amount_max, 0) <= 0
              AND COALESCE(fo.source_url, fo.application_url, fo.evidence_url) IS NOT NULL`
      // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
      const row = await db
        .prepare(
          `SELECT COUNT(DISTINCT fo.id) AS n
             FROM funding_opportunities fo
             JOIN grants g ON g.funding_opportunity_id = fo.id
            WHERE g.status IN (${statuses})
              AND ${stillUnread}
              AND fo.amount_enrich_attempted_at IS NULL`,
        )
        .get()
      remaining = Number(row?.n ?? 0)
      // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
      const done = await db
        .prepare(
          `SELECT COUNT(DISTINCT fo.id) AS n
             FROM funding_opportunities fo
             JOIN grants g ON g.funding_opportunity_id = fo.id
            WHERE g.status IN (${statuses})
              AND ${noFigure}
              AND fo.amount_enrich_attempted_at IS NOT NULL`,
        )
        .get()
      exhausted = Number(done?.n ?? 0)
    } catch { /* best-effort telemetry */ }

    // Persist the failure ring AFTER the loop (one KV write per sweep run).
    await appendAmountEnrichFailureLog(db, failureLog)

    if (envBlocked > 0) {
      log.warn('amount_enrichment: environment-blocked failures (egress/WAF/auth) — rows left retryable, owner action needed', {
        envBlocked, attempted: attemptedNow,
        statuses: [...new Set(failureLog.filter((f) => f.environment).map((f) => f.status))],
      })
    }
    if (enriched > 0 || textOnly > 0 || nonePublished > 0) {
      log.info('enriched catalog award amounts from funder pages', {
        attempted: attemptedNow, enriched, textOnly, nonePublished, fetchFailed, retryable, envBlocked, remaining, exhausted,
      })
    }
    return {
      scanned: fresh.length, attempted: attemptedNow, repaired: enriched,
      textOnly, nonePublished, fetchFailed, retryable, envBlocked, remaining, exhausted, enforced: true,
    }
  })
}

/**
 * INVARIANT: A GRANT WITH NO CATALOG TWIN IS READ DIRECTLY (the last mile of the
 * amount-answer census, 2026-07-17).
 *
 * `enforceAmountEnrichment` reads CATALOG rows; it reaches a grant only through
 * `funding_opportunity_id`. `enforceGrantCatalogLink` links the grants that have
 * a catalog twin — but ~38 active-pipeline grants in prod have NO twin at all
 * (Eldercare Locator, Coca-Cola Scholars, FAFSA — curated resources inserted
 * directly as grants). Nothing reads them, so they sit in
 * `pipeline.amountCoverage` as `unanswered_no_catalog_row` forever, and the
 * finding can never go green while a real, answerable row has simply never been
 * looked at.
 *
 * This sweep reads such a grant's OWN url via the SAME service the catalog sweep
 * uses (`enrichOpportunityAmountFromSource`, adapter-then-fetch, SSRF-safe) and
 * records the answer ON THE GRANT: a scholarship page yields a real amount; a
 * locator/benefit page yields an evidenced `none_published` (an honest denial,
 * not a blank). A JS shell / dead page stays `page_read:false` → NOT burned as a
 * denial (we learned we cannot read it, not that it pays nothing) → it remains
 * an honest `unanswered_unreadable` that names real adapter work.
 *
 * Burn/retry semantics are IDENTICAL to the catalog sweep (the whole reason the
 * grant carries its own `amount_enrich_attempted_at`/`amount_enrich_attempts`,
 * migration 142/0146): burn on `page_read` or a stable non-transient failure or
 * after MAX_ATTEMPTS; a provider outage never burns a row; an ENVIRONMENT
 * failure (WAF/auth block on OUR egress) neither burns nor consumes the retry
 * budget; the mark is written only AFTER the amount write succeeds. Amy synthetic-profile grants are excluded
 * (they are training artifacts, not real pipeline). Runs AFTER
 * `enforceGrantCatalogLink` so a grant that COULD link is linked first and read
 * through the catalog path; only genuine orphans reach here.
 *
 * OVERRIDE: ON by default; `ENFORCE_GRANT_DIRECT_AMOUNT=0` for count-only.
 */
export async function enforceGrantDirectAmountEnrichment(db, deps = {}) {
  return runInvariant('grant_direct_amount', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('amount_enrich_attempted_at') || !grantCols.has('url')) {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }
    const disabled = _parseBoolEnv(process.env.ENFORCE_GRANT_DIRECT_AMOUNT) === false
    const LIMIT = Math.max(1, Number.parseInt(deps.limit ?? process.env.GRANT_DIRECT_AMOUNT_BOOT_LIMIT ?? '10', 10) || 10)
    const TIME_BUDGET_MS = Math.max(1000, Number.parseInt(deps.timeBudgetMs ?? process.env.GRANT_DIRECT_AMOUNT_TIME_BUDGET_MS ?? '20000', 10) || 20000)
    const MAX_ATTEMPTS = Math.max(1, Number.parseInt(deps.maxAttempts ?? process.env.AMOUNT_ENRICH_MAX_ATTEMPTS ?? '3', 10) || 3)
    const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
    const VAL = pipelineValueSql('g')

    const ENV_MAX = Math.max(1, Number.parseInt(deps.envMaxAttempts ?? AMOUNT_ENRICH_ENV_MAX_ATTEMPTS, 10) || AMOUNT_ENRICH_ENV_MAX_ATTEMPTS)
    const ENV_REPROBE = Math.max(0, Number.parseInt(deps.envReprobeLimit ?? AMOUNT_ENRICH_ENV_REPROBE_LIMIT, 10) || 0)

    let candidates = []
    let blockedProbe = []
    try {
      // Same DISJOINT-lanes split as the catalog sweep above: an
      // environment-BLOCKED orphan grant (env failures >= ENV_MAX) leaves the
      // main bounded batch and is re-probed on the slower lane, so a WAF-blocked
      // host can never starve valid never-attempted orphans out of the budget.
      // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
      const candidateSql = (envPredicate, orderSql) =>
        `SELECT g.id, g.url, g.application_url, COALESCE(g.amount_enrich_attempts, 0) AS attempts,
                COALESCE(g.amount_enrich_env_attempts, 0) AS env_attempts
             FROM grants g
            WHERE g.status IN (${statuses})
              AND g.funding_opportunity_id IS NULL
              AND ${VAL} = 0
              AND (g.amount_status IS NULL OR g.amount_status = 'not_listed')
              AND (g.amount_text IS NULL OR g.amount_text = '')
              AND g.amount_enrich_attempted_at IS NULL
              AND COALESCE(g.url, g.application_url, '') <> ''
              AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.profile_id AND p.created_by = 'agent:amy')
              AND ${envPredicate}
            ORDER BY ${orderSql}
            LIMIT ?`
      // audit:allow dynamic-sql — envPredicate/orderSql are the frozen literals below.
      candidates = await db
        .prepare(candidateSql(
          `COALESCE(g.amount_enrich_env_attempts, 0) < ${ENV_MAX}`,
          'COALESCE(g.amount_enrich_attempts, 0) ASC, g.id ASC',
        ))
        .all(LIMIT)
      if (ENV_REPROBE > 0) {
        blockedProbe = await db
          .prepare(candidateSql(
            `COALESCE(g.amount_enrich_env_attempts, 0) >= ${ENV_MAX}`,
            'COALESCE(g.amount_enrich_env_attempts, 0) ASC, g.id ASC',
          ))
          .all(ENV_REPROBE)
      }
    } catch (err) {
      log.warn('grant_direct_amount: candidate scan failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }

    // Same env-counter contract as the catalog sweep: increment only on an
    // environment failure, reset on any other outcome, written atomically with
    // the ordinary counters. (Defined before the early returns below: the
    // structural re-claim net must run even on a boot with zero unburned
    // candidates.)
    const recordAttempt = async (id, { burn, attempts, envAttempts = 0, reason = null }) => {
      try {
        await db
          .prepare(
            `UPDATE grants
                SET amount_enrich_attempts = ?,
                    amount_enrich_env_attempts = ?,
                    amount_enrich_attempted_at = COALESCE(?, amount_enrich_attempted_at),
                    amount_enrich_last_reason = ?
              WHERE id = ?`,
          )
          .run(attempts, envAttempts, burn ? new Date().toISOString() : null, reason, id)
      } catch { /* best-effort; a missed mark only costs one re-fetch */ }
    }

    // ── STRUCTURAL RE-CLAIM over BURNED rows (the anti-migration net) ────────
    // A burn mark records that FETCHING was tried and is final; a structural
    // locator claim needs NO fetch, so a burned row is a legitimate claim
    // target the moment a rule exists for its URL. Without this net, every new
    // locatorUrlKind rule needed a hand-written un-burn migration to reach the
    // rows burned before it shipped (migrations 138/152/156 — three instances
    // of one class; the studentaid.gov orphans sat four days on the last one).
    // With it, adding a rule — e.g. a new STATE'S benefit/portal paths in
    // STATE_GOV_PATH_RULES — converges burned rows on the next boot, no
    // migration. Bounded and LIKE-prefiltered (cheap: DB-only, no fetch, no
    // budget spend); idempotent (a claimed row gains its answer and leaves the
    // predicate); the burn mark and both attempt counters are preserved —
    // nothing here re-opens fetching for a row the classifier does not claim.
    let structuralReclaimed = 0
    try {
      const RECLAIM_LIMIT = Math.max(1, Number.parseInt(deps.reclaimLimit ?? process.env.GRANT_STRUCTURAL_RECLAIM_LIMIT ?? '200', 10) || 200)
      const likeClauses = LOCATOR_URL_LIKE_PREFILTERS
        .map(() => `COALESCE(g.url, '') LIKE ? OR COALESCE(g.application_url, '') LIKE ?`)
        .join(' OR ')
      const likeParams = LOCATOR_URL_LIKE_PREFILTERS.flatMap((p) => [p, p])
      // audit:allow dynamic-sql — statuses/likeClauses derive from frozen constants; all values stay bound.
      const burnedRows = await db
        .prepare(
          `SELECT g.id, g.url, g.application_url,
                  COALESCE(g.amount_enrich_attempts, 0) AS attempts,
                  COALESCE(g.amount_enrich_env_attempts, 0) AS env_attempts
             FROM grants g
            WHERE g.status IN (${statuses})
              AND g.funding_opportunity_id IS NULL
              AND ${VAL} = 0
              AND (g.amount_status IS NULL OR g.amount_status = 'not_listed')
              AND (g.amount_text IS NULL OR g.amount_text = '')
              AND g.amount_enrich_attempted_at IS NOT NULL
              AND COALESCE(g.url, g.application_url, '') <> ''
              AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.profile_id AND p.created_by = 'agent:amy')
              AND (${likeClauses})
            LIMIT ?`,
        )
        .all(...likeParams, RECLAIM_LIMIT)
      for (const g of Array.isArray(burnedRows) ? burnedRows : []) {
        // Same effective-URL slot the fetch lane classifies (url ?? application_url).
        const structural = classifyLocatorKindFromRow({ source_url: g.url ?? g.application_url ?? null })
        if (!structural) continue
        if (disabled) { structuralReclaimed++; continue } // count-only: what WOULD re-claim
        const isBenefit = structural.kind === 'benefit'
        const wrote = await db
          .prepare(
            `UPDATE grants
                SET amount_status = COALESCE(?, amount_status),
                    amount_text = ?
              WHERE id = ?
                AND (amount_status IS NULL OR amount_status = 'not_listed')
                AND (amount_text IS NULL OR amount_text = '')
                AND COALESCE(amount_min, 0) <= 0
                AND COALESCE(amount_max, 0) <= 0
                AND COALESCE(amount_requested, 0) <= 0`,
          )
          .run(
            isBenefit ? 'varies' : null,
            isBenefit
              ? 'Benefit program — award varies by applicant'
              : 'Program directory/locator — points at opportunities; no per-award figure by design',
            g.id,
          )
        if (changesOf(wrote) > 0) {
          structuralReclaimed++
          // burn:false → COALESCE keeps the original mark; counters unchanged;
          // only the reason breadcrumb records who answered the row.
          await recordAttempt(g.id, {
            burn: false,
            attempts: Number(g.attempts ?? 0),
            envAttempts: Number(g.env_attempts ?? 0),
            reason: `locator_kind:${structural.reason}`,
          })
        }
      }
      if (structuralReclaimed > 0) {
        log.info(disabled
          ? 'burned orphan grants WOULD be structurally re-claimed (ENFORCE_GRANT_DIRECT_AMOUNT=0)'
          : 'structurally re-claimed burned orphan grants (no fetch spent)', { reclaimed: structuralReclaimed })
      }
    } catch (err) {
      log.warn('grant_direct_amount: structural re-claim scan failed (non-fatal)', { error: String(err?.message || err) })
    }

    const fresh = [...(Array.isArray(candidates) ? candidates : []), ...(Array.isArray(blockedProbe) ? blockedProbe : [])]
    if (fresh.length === 0) return { scanned: 0, repaired: 0, structural_reclaimed: structuralReclaimed, enforced: !disabled }
    if (disabled) return { scanned: fresh.length, repaired: 0, structural_reclaimed: structuralReclaimed, enforced: false }

    const { enrichOpportunityAmountFromSource } =
      deps.enrichImpl ? { enrichOpportunityAmountFromSource: deps.enrichImpl } : await import('../services/amountEnrichment.js')

    const startedAt = Date.now()
    let attemptedNow = 0
    let enriched = 0
    let nonePublished = 0
    let textOnly = 0
    let fetchFailed = 0
    let retryable = 0
    let envBlocked = 0
    const failureLog = []
    // Deferred stable failures + hosts that proved alive — the systemic-burn
    // guard's inputs (same contract as the catalog sweep above).
    const pendingStable = []
    const readHosts = new Set()
    // Re-probe slots ride OVER the main budget — same contract and rationale
    // as the catalog sweep above.
    const ATTEMPT_CAP = LIMIT + (blockedProbe?.length ?? 0)
    for (const g of fresh) {
      if (attemptedNow >= ATTEMPT_CAP) break
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      attemptedNow++
      try {
        // STRUCTURAL SHORT-CIRCUIT. The census can see `opportunity_kind` only
        // on CATALOG rows, so an orphan grant on a benefit host (studentaid.gov
        // Pell/work-study — a JS shell to the fetcher) would sit "unreadable"
        // forever even though the locator classifier makes a positive claim
        // about what the page IS. That claim carries its own honest amount
        // vocabulary — 'benefit' means "award varies by applicant" (the kind's
        // stated semantic in locatorUrlKind.js), a directory is a pointer and
        // never an award — so record it in the grant-side label vocabulary the
        // census already reads, and skip the doomed fetch.
        const structural = classifyLocatorKindFromRow({ source_url: g.url ?? g.application_url ?? null })
        if (structural) {
          const isBenefit = structural.kind === 'benefit'
          const wrote = await db
            .prepare(
              `UPDATE grants
                  SET amount_status = COALESCE(?, amount_status),
                      amount_text = ?
                WHERE id = ?
                  AND (amount_status IS NULL OR amount_status = 'not_listed')
                  AND (amount_text IS NULL OR amount_text = '')
                  AND COALESCE(amount_min, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0
                  AND COALESCE(amount_requested, 0) <= 0`,
            )
            .run(
              isBenefit ? 'varies' : null,
              isBenefit
                ? 'Benefit program — award varies by applicant'
                : 'Program directory/locator — points at opportunities; no per-award figure by design',
              g.id,
            )
          if (changesOf(wrote) > 0) {
            textOnly++
            // A structural fact about the URL's shape is stable — burn the
            // one-shot mark; the row now carries its honest answer.
            await recordAttempt(g.id, {
              burn: true,
              attempts: Number(g.attempts ?? 0) + 1,
              envAttempts: 0,
              reason: `locator_kind:${structural.reason}`,
            })
          }
          continue
        }
        // The service reads source_url ?? application_url ?? evidence_url. A grant
        // carries no source/source_id, so the API-adapter lane is a no-op here and
        // the page fetch runs — correct: an orphan grant at a grants.gov/sam.gov
        // URL will read as a thin_page and stay honestly unreadable, exactly like
        // the catalog path.
        const res = await enrichOpportunityAmountFromSource(
          { source_url: g.url ?? g.application_url ?? null },
          deps,
        )
        // Environment failure (WAF/auth/quota) never consumes the grant's
        // retry budget nor burns it via out-of-retries — identical rule and
        // rationale as the catalog sweep above.
        const environmentBlocked = res?.environment === true && res?.page_read !== true
        const attempts = Number(g.attempts ?? 0) + (environmentBlocked ? 0 : 1)
        const envAttempts = environmentBlocked ? Number(g.env_attempts ?? 0) + 1 : 0
        const outOfRetries = attempts >= MAX_ATTEMPTS
        // Stable failures defer to the post-loop systemic-burn guard — same
        // rule and rationale as the catalog sweep above.
        const stableFailure = res?.page_read !== true && !environmentBlocked && res?.transient !== true
        const burn = res?.page_read === true
          || (!environmentBlocked && !stableFailure && outOfRetries)
        if (res?.page_read === true) {
          readHosts.add(amountEnrichHostOf(g.url, g.application_url))
        } else {
          fetchFailed++
          if (environmentBlocked) envBlocked++
          if (!burn && !stableFailure) retryable++
          failureLog.push(amountEnrichFailureEntry({ lane: 'grant_direct', id: g.id, res }))
        }
        if (res?.found && res.amounts) {
          await db
            .prepare(
              `UPDATE grants
                  SET amount_min = ?, amount_max = ?, amount_text = ?,
                      amount_status = ?, amount_confidence = ?
                WHERE id = ?
                  AND COALESCE(amount_min, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0
                  AND COALESCE(amount_requested, 0) <= 0`,
            )
            .run(
              res.amounts.amount_min, res.amounts.amount_max, res.amounts.amount_text,
              res.amounts.amount_status, res.amounts.amount_confidence, g.id,
            )
          enriched++
        } else if (res?.page_read === true) {
          // Read, no per-award figure → record the evidenced denial (or a better
          // honest label the page stated). Same rule as the catalog sweep:
          // `none_published` is the floor; a real 'varies'/'contact_required' wins.
          const readStatus =
            res.amount_status && res.amount_status !== 'not_listed'
              ? res.amount_status
              : AMOUNT_STATUS_NONE_PUBLISHED
          await db
            .prepare(
              `UPDATE grants
                  SET amount_text = COALESCE(?, amount_text),
                      amount_status = ?
                WHERE id = ?
                  AND (amount_status IS NULL OR amount_status = 'not_listed')
                  AND COALESCE(amount_min, 0) <= 0
                  AND COALESCE(amount_max, 0) <= 0
                  AND COALESCE(amount_requested, 0) <= 0`,
            )
            .run(res.amount_text ?? null, readStatus, g.id)
          if (readStatus === AMOUNT_STATUS_NONE_PUBLISHED) nonePublished++
          else textOnly++
        }
        // Mark only AFTER the write succeeds (the #946 rule): a failed write
        // leaves the row unmarked so "will retry" is true, not a comforting lie.
        // A stable failure has no data write, so its deferred mark is safe.
        if (stableFailure) {
          pendingStable.push({
            id: g.id,
            host: amountEnrichHostOf(g.url, g.application_url),
            reason: res?.reason ?? null,
            baseAttempts: Number(g.attempts ?? 0),
            baseEnvAttempts: Number(g.env_attempts ?? 0),
          })
        } else {
          await recordAttempt(g.id, { burn, attempts, envAttempts, reason: res?.reason ?? null })
        }
      } catch (err) {
        fetchFailed++
        retryable++
        log.warn('grant_direct_amount: write failed — grant left unmarked so it WILL be retried', {
          grant: g.id, error: String(err?.message || err),
        })
      }
    }

    // Systemic-burn guard — same partition and outcome semantics as the
    // catalog sweep above.
    const SYSTEMIC_STREAK = Math.max(
      2,
      Number.parseInt(deps.systemicStreakLimit ?? process.env.AMOUNT_ENRICH_SYSTEMIC_STREAK ?? '4', 10) || 4,
    )
    const { burnNow, systemic } = partitionSystemicStableFailures(pendingStable, readHosts, SYSTEMIC_STREAK)
    for (const p of burnNow) {
      await recordAttempt(p.id, { burn: true, attempts: p.baseAttempts + 1, envAttempts: 0, reason: p.reason })
    }
    for (const p of systemic) {
      envBlocked++
      retryable++
      await recordAttempt(p.id, { burn: false, attempts: p.baseAttempts, envAttempts: p.baseEnvAttempts + 1, reason: p.reason })
    }
    if (systemic.length > 0) {
      log.warn('grant_direct_amount: SYSTEMIC stable-failure signature — burns withheld, grants parked environment-blocked', {
        withheld: systemic.length,
        streakLimit: SYSTEMIC_STREAK,
        groups: [...new Set(systemic.map((p) => `${p.host ?? 'unknown'}|${p.reason ?? 'unknown'}`))].slice(0, 5),
      })
    }

    let remaining = null
    let exhausted = null
    try {
      // audit:allow dynamic-sql — statuses is the frozen PIPELINE_ACTIVE_STATUSES constant
      const stillUnread = `${VAL} = 0
              AND g.funding_opportunity_id IS NULL
              AND (g.amount_status IS NULL OR g.amount_status = 'not_listed')
              AND (g.amount_text IS NULL OR g.amount_text = '')
              AND COALESCE(g.url, g.application_url, '') <> ''
              AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.profile_id AND p.created_by = 'agent:amy')`
      const r = await db.prepare(
        `SELECT COUNT(*) AS n FROM grants g
          WHERE g.status IN (${statuses}) AND ${stillUnread} AND g.amount_enrich_attempted_at IS NULL`,
      ).get()
      remaining = Number(r?.n ?? 0)
      const done = await db.prepare(
        `SELECT COUNT(*) AS n FROM grants g
          WHERE g.status IN (${statuses}) AND ${VAL} = 0 AND g.funding_opportunity_id IS NULL
            AND COALESCE(g.url, g.application_url, '') <> ''
            AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.profile_id AND p.created_by = 'agent:amy')
            AND g.amount_enrich_attempted_at IS NOT NULL`,
      ).get()
      exhausted = Number(done?.n ?? 0)
    } catch { /* best-effort telemetry */ }

    await appendAmountEnrichFailureLog(db, failureLog)

    if (enriched > 0 || nonePublished > 0 || textOnly > 0) {
      log.info('read orphan pipeline grants directly for award amounts', {
        attempted: attemptedNow, enriched, nonePublished, textOnly, fetchFailed, retryable, envBlocked, remaining, exhausted,
      })
    }
    return {
      scanned: fresh.length, attempted: attemptedNow, repaired: enriched,
      structural_reclaimed: structuralReclaimed,
      nonePublished, textOnly, fetchFailed, retryable, envBlocked, remaining, exhausted, enforced: true,
    }
  })
}

/**
 * DEAD-URL REPAIR (2026-07-26, owner rule: Sam repairs, not monitors).
 *
 * A row whose source URL is provably DEAD — the domain no longer resolves
 * (the pacfcf.org / 1stresponderchildren.org class: a crawler stored a wrong
 * or rotted domain for a REAL organization) or the page permanently 404s (the
 * tn.gov STEP UP class: a state CMS reorganized) — can never be answered by
 * any amount of fetching, adapters, or classification. Its burn is honest,
 * but the row's real defect is the URL, and the repair for that already
 * exists in this codebase: `findOfficialUrlForOpportunity` (search the row's
 * own title+sponsor → token-overlap plausibility → LIVENESS probe), used by
 * the application-url rescue for MISSING urls. This net applies the same
 * finder to DEAD urls.
 *
 * HONESTY CONTRACT (inherits the finder's): a URL is never fabricated or
 * guessed — only a live, plausibility-gated search hit is ever written, a
 * search-engine URL is refused (canonical isSearchEngineUrl, invariant
 * #urlHygiene), and a provider outage spends NOTHING. Deadness is RE-PROVED
 * with a live probe before any search: a row whose "dead" URL answers today
 * (a transient 404 window, a recovered host) is simply un-burned so the
 * ordinary amount lane re-reads it — its URL was never the problem.
 *
 * On repair the row's enrich state is RESET (mark NULL, counters 0): a new
 * URL is a new claim about the row, the same doctrine that re-opens a burn
 * when a new strategy ships (migration-135 rule). The next boot's amount
 * sweep then reads the REAL page. Attempt state for the repair itself lives
 * in system_kv `dead_url_repair_state` (MAX 3 searches per row, 7d cooldown,
 * exhausted = terminal) so a row whose real page genuinely cannot be found
 * stops consuming search budget.
 */
/**
 * SOURCE-LEVEL SAME-DOMAIN SELF-REPAIR (2026-07-26, owner: "give Sam the
 * ability to make these repairs autonomously" — the safe half).
 *
 * A registry SOURCE is code (sourceRegistry.js), so when its page moves the
 * fleet fails every crawl until a human edits the registry. This net closes
 * the SAME-DOMAIN half autonomously: for each source the shared detector says
 * failed EVERY recent queried run (findPersistentlyFailingSources — the same
 * query Sam's crawler.sourcePersistentFailure check reads, so finding and
 * actor cannot drift), probe the curated URL and:
 *
 *   - the HOST ITSELF redirects to a new location on the SAME registrable
 *     domain → write a runtime prefix override (system_kv, applied by the
 *     discovery fetcher wrapper) — deterministic, the org told us where it
 *     moved;
 *   - the page is dead but a DOMAIN-PINNED search (hits filtered to the
 *     curated registrable domain — the trust anchor, so a lookalike can never
 *     qualify) finds a live page → same-domain override;
 *   - anything CROSS-domain → a PROPOSAL in the same kv for the owner report,
 *     never an autonomous write (writeSourceUrlOverride throws on it anyway —
 *     the guard is in the store, not in caller discipline).
 *
 * Overrides are revertible (delete the kv entry), visible (Sam's check names
 * them), and self-judging: a source still failing WITH an override is
 * surfaced as needing registry work. Bounded per boot; per-source attempt
 * state (3 tries, 7d cooldown) so an unrepairable source stops spending
 * search budget.
 */
const SOURCE_URL_REPAIR_STATE_KEY = 'source_url_self_repair_state'

export async function enforceSourceUrlSelfRepair(db, deps = {}) {
  return runInvariant('source_url_self_repair', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_SOURCE_URL_SELF_REPAIR) === false
    const LIMIT = Math.max(1, Number.parseInt(deps.limit ?? process.env.SOURCE_URL_REPAIR_BOOT_LIMIT ?? '3', 10) || 3)
    const TIME_BUDGET_MS = Math.max(1000, Number.parseInt(deps.timeBudgetMs ?? process.env.SOURCE_URL_REPAIR_TIME_BUDGET_MS ?? '20000', 10) || 20000)
    const MAX_ATTEMPTS = Math.max(1, Number.parseInt(deps.maxAttempts ?? process.env.SOURCE_URL_REPAIR_MAX_ATTEMPTS ?? '3', 10) || 3)
    const COOLDOWN_MS = Math.max(0, Number.parseInt(deps.cooldownMs ?? process.env.SOURCE_URL_REPAIR_COOLDOWN_MS ?? String(7 * 24 * 60 * 60 * 1000), 10) || 0)
    const STREAK = Math.max(2, Number.parseInt(deps.streak ?? process.env.CRAWLER_SOURCE_FAILURE_STREAK ?? '5', 10) || 5)

    const { findPersistentlyFailingSources } = deps.detectorImpl
      ? { findPersistentlyFailingSources: deps.detectorImpl }
      : await import('../services/sources/sourceFailureDetector.js')
    const failing = await findPersistentlyFailingSources(db, { streak: STREAK })
    if (!Array.isArray(failing) || failing.length === 0) return { scanned: 0, repaired: 0, enforced: !disabled }
    if (disabled) return { scanned: failing.length, repaired: 0, enforced: false }

    const overridesMod = deps.overridesImpl ?? await import('../services/sources/sourceUrlOverrides.js')
    const { loadSourceUrlOverrides, writeSourceUrlOverride, writeSourceUrlProposal, isSameRegistrableDomain, registrableDomain, isTrivialUrlChange } = overridesMod
    const getSourceImpl = deps.getSourceImpl ?? (await import('../crawler-os/sourceRegistry.js')).getSource
    const checkUrlImpl = deps.checkUrlImpl ?? (await import('../services/linkVerificationService.js')).checkUrl
    const searchWebImpl = deps.searchWebImpl ?? (await import('../services/shared/webSearchEngine.js')).searchWeb

    const existingOverrides = await loadSourceUrlOverrides(db)
    const overriddenIds = new Set(existingOverrides.map((o) => o.source_id))

    let state = { entries: {} }
    try {
      const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(SOURCE_URL_REPAIR_STATE_KEY)
      const parsed = row?.value ? JSON.parse(row.value) : null
      if (parsed && typeof parsed.entries === 'object' && parsed.entries) state = parsed
    } catch { /* fresh state */ }

    const nowMs = Date.now()
    const startedAt = nowMs
    let scanned = 0
    let repaired = 0
    let proposed = 0
    let aliveNoRepair = 0
    let notFound = 0
    let outage = 0
    let skippedCooldown = 0

    for (const src of failing.slice(0, LIMIT)) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      const entry = state.entries[src.source_id] ?? { attempts: 0, last_at: null, exhausted: false }
      // An already-overridden source still failing is a HUMAN item (Sam's
      // check says so) — churning a second override would just thrash.
      if (overriddenIds.has(src.source_id)) { skippedCooldown++; continue }
      if (entry.exhausted) { skippedCooldown++; continue }
      if (entry.last_at && COOLDOWN_MS > 0 && nowMs - Date.parse(entry.last_at) < COOLDOWN_MS) { skippedCooldown++; continue }
      const source = getSourceImpl(src.source_id)
      const curated = typeof source?.base_url === 'string' ? source.base_url.trim() : ''
      if (!curated) { skippedCooldown++; continue }
      scanned++
      const spendAttempt = () => {
        entry.attempts += 1
        entry.last_at = new Date(nowMs).toISOString()
        if (entry.attempts >= MAX_ATTEMPTS) entry.exhausted = true
        state.entries[src.source_id] = entry
      }
      try {
        // 1. The host's own answer: a redirect off the curated prefix is the
        //    most trustworthy repair evidence that exists.
        const probe = await checkUrlImpl(curated, { timeoutMs: 8000 })
        const finalUrl = typeof probe?.finalUrl === 'string' ? probe.finalUrl : null
        if (probe && (probe.status === 'ok' || probe.status === 'redirect')) {
          // A trailing-slash-only "redirect" is not a move (prod, first boot:
          // sbir.gov → sbir.gov/) — it lands in aliveNoRepair below so the
          // source converges to exhausted instead of gaining a no-op override.
          if (finalUrl && !isTrivialUrlChange(curated, finalUrl) && !isSearchEngineUrl(finalUrl)) {
            spendAttempt()
            if (isSameRegistrableDomain(curated, finalUrl)) {
              await writeSourceUrlOverride(db, {
                source_id: src.source_id, from_prefix: curated, to_prefix: finalUrl,
                evidence: { kind: 'host_redirect', probed_at: new Date(nowMs).toISOString(), last_error: src.last_error ?? null },
              })
              repaired++
            } else {
              await writeSourceUrlProposal(db, {
                source_id: src.source_id, from_prefix: curated, to_prefix: finalUrl,
                evidence: { kind: 'host_redirect', probed_at: new Date(nowMs).toISOString(), last_error: src.last_error ?? null },
              })
              proposed++
            }
          } else {
            // Alive at the curated URL: the failure is content/auth-level —
            // not a URL problem this net can fix. Spend an attempt so a
            // permanently-unrepairable source converges to exhausted.
            spendAttempt()
            aliveNoRepair++
          }
          continue
        }
        // 2. Dead page: DOMAIN-PINNED search. Hits are filtered to the curated
        //    registrable domain BEFORE probing, so a lookalike can never win
        //    an override; the best OFF-domain hit (if its title carries the
        //    source's name tokens) becomes a proposal.
        const query = `"${source.name ?? src.source_label ?? src.source_id}"`
        let hits = []
        try {
          const raw = await searchWebImpl(query, { count: 6, timeoutMs: 10000 })
          hits = Array.isArray(raw) ? raw : []
        } catch {
          outage++
          continue // provider failure: spend nothing
        }
        if (hits.length === 0) { outage++; continue }
        spendAttempt()
        const anchor = registrableDomain(new URL(curated).hostname)
        const nameTokens = significantTitleTokens(source.name ?? src.source_label ?? '')
        const mentionsName = (h) => {
          if (nameTokens.length === 0) return false
          const text = `${h?.title ?? ''} ${h?.url ?? ''}`.toLowerCase()
          const present = nameTokens.filter((t) => text.includes(t))
          return present.length / nameTokens.length >= 0.5
        }
        const usable = hits.filter((h) => typeof h?.url === 'string' && /^https?:\/\//i.test(h.url) && !isSearchEngineUrl(h.url))
        const sameDomain = usable.filter((h) => { try { return registrableDomain(new URL(h.url).hostname) === anchor } catch { return false } })
        let done = false
        for (const hit of sameDomain.slice(0, 2)) {
          const p = await checkUrlImpl(hit.url, { timeoutMs: 8000 })
          if (p && (p.status === 'ok' || p.status === 'redirect')) {
            const target = p.finalUrl || hit.url
            if (isSameRegistrableDomain(curated, target)) {
              await writeSourceUrlOverride(db, {
                source_id: src.source_id, from_prefix: curated, to_prefix: target,
                evidence: { kind: 'domain_pinned_search', probed_at: new Date(nowMs).toISOString(), hit_title: hit.title ?? null },
              })
              repaired++
              done = true
              break
            }
          }
        }
        if (done) continue
        const offDomain = usable.find((h) => mentionsName(h) && (() => { try { return registrableDomain(new URL(h.url).hostname) !== anchor } catch { return false } })())
        if (offDomain) {
          await writeSourceUrlProposal(db, {
            source_id: src.source_id, from_prefix: curated, to_prefix: offDomain.url,
            evidence: { kind: 'cross_domain_search_hit', hit_title: offDomain.title ?? null, probed_at: new Date(nowMs).toISOString() },
          })
          proposed++
        } else {
          notFound++
        }
      } catch (err) {
        log.warn('source_url_self_repair: source failed (non-fatal)', { source: src.source_id, error: String(err?.message || err) })
      }
    }

    try {
      const value = JSON.stringify({ updated_at: new Date(nowMs).toISOString(), entries: state.entries })
      const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, new Date(nowMs).toISOString(), SOURCE_URL_REPAIR_STATE_KEY)
      if (!changesOf(res)) {
        await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(SOURCE_URL_REPAIR_STATE_KEY, value, new Date(nowMs).toISOString())
      }
    } catch (err) {
      log.warn('source_url_self_repair: state persist failed (non-fatal)', { error: String(err?.message || err) })
    }

    if (repaired > 0 || proposed > 0) {
      log.info('source self-repair: same-domain overrides applied / cross-domain proposals filed', { repaired, proposed })
    }
    return { scanned, repaired, proposed, aliveNoRepair, notFound, outage, skippedCooldown, enforced: true }
  })
}

const DEAD_URL_REPAIR_STATE_KEY = 'dead_url_repair_state'
const DEAD_URL_REASON_PREDICATE = (alias) =>
  `(COALESCE(${alias}.amount_enrich_last_reason, '') LIKE 'fetch_failed:404%'
    OR COALESCE(${alias}.amount_enrich_last_reason, '') LIKE 'fetch_failed:410%'
    OR COALESCE(${alias}.amount_enrich_last_reason, '') LIKE 'fetch_failed:ssrf_guard%')`

export async function enforceDeadUrlRepair(db, deps = {}) {
  return runInvariant('dead_url_repair', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('amount_enrich_last_reason') || !grantCols.has('url')) {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }
    const disabled = _parseBoolEnv(process.env.ENFORCE_DEAD_URL_REPAIR) === false
    const LIMIT = Math.max(1, Number.parseInt(deps.limit ?? process.env.DEAD_URL_REPAIR_BOOT_LIMIT ?? '4', 10) || 4)
    const TIME_BUDGET_MS = Math.max(1000, Number.parseInt(deps.timeBudgetMs ?? process.env.DEAD_URL_REPAIR_TIME_BUDGET_MS ?? '20000', 10) || 20000)
    const MAX_ATTEMPTS = Math.max(1, Number.parseInt(deps.maxAttempts ?? process.env.DEAD_URL_REPAIR_MAX_ATTEMPTS ?? '3', 10) || 3)
    const COOLDOWN_MS = Math.max(0, Number.parseInt(deps.cooldownMs ?? process.env.DEAD_URL_REPAIR_COOLDOWN_MS ?? String(7 * 24 * 60 * 60 * 1000), 10) || 0)
    const statuses = PIPELINE_ACTIVE_STATUSES.map((s) => `'${s}'`).join(', ')
    const VAL = pipelineValueSql('g')
    const NON_SYNTH = `NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = g.profile_id AND p.created_by = 'agent:amy')`

    // Two candidate lanes — the same two places an answer can live (census rule).
    let candidates = []
    try {
      // audit:allow dynamic-sql — statuses/predicates are frozen module constants.
      const orphans = await db
        .prepare(
          `SELECT 'grant' AS lane, g.id, g.title, g.funder AS sponsor,
                  COALESCE(g.url, g.application_url) AS dead_url
             FROM grants g
            WHERE g.status IN (${statuses})
              AND g.funding_opportunity_id IS NULL
              AND ${VAL} = 0
              AND (g.amount_status IS NULL OR g.amount_status = 'not_listed')
              AND (g.amount_text IS NULL OR g.amount_text = '')
              AND g.amount_enrich_attempted_at IS NOT NULL
              AND ${DEAD_URL_REASON_PREDICATE('g')}
              AND COALESCE(g.url, g.application_url, '') <> ''
              AND ${NON_SYNTH}
            LIMIT ?`,
        )
        .all(LIMIT)
      // audit:allow dynamic-sql — statuses/predicates are frozen module constants.
      const catalogRows = await db
        .prepare(
          `SELECT 'fo' AS lane, fo.id, fo.title, fo.sponsor,
                  COALESCE(fo.source_url, fo.application_url) AS dead_url
             FROM funding_opportunities fo
            WHERE fo.is_active
              AND COALESCE(fo.amount_min, 0) <= 0
              AND COALESCE(fo.amount_max, 0) <= 0
              AND (fo.amount_status IS NULL OR fo.amount_status = 'not_listed')
              AND (fo.amount_text IS NULL OR fo.amount_text = '')
              AND LOWER(COALESCE(fo.opportunity_kind, '')) NOT IN ('directory', 'benefit')
              AND fo.amount_enrich_attempted_at IS NOT NULL
              AND ${DEAD_URL_REASON_PREDICATE('fo')}
              AND COALESCE(fo.source_url, fo.application_url, '') <> ''
              AND EXISTS (SELECT 1 FROM grants g
                           WHERE g.funding_opportunity_id = fo.id
                             AND g.status IN (${statuses}) AND ${NON_SYNTH})
            LIMIT ?`,
        )
        .all(LIMIT)
      candidates = [...(Array.isArray(orphans) ? orphans : []), ...(Array.isArray(catalogRows) ? catalogRows : [])].slice(0, LIMIT)
    } catch (err) {
      log.warn('dead_url_repair: candidate scan failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, skipped: 'query' }
    }
    if (candidates.length === 0) return { scanned: 0, repaired: 0, enforced: !disabled }
    if (disabled) return { scanned: candidates.length, repaired: 0, enforced: false }

    const findOfficialUrl = deps.findOfficialUrl ?? findOfficialUrlForOpportunity
    const checkUrlImpl = deps.checkUrlImpl ?? (await import('../services/linkVerificationService.js')).checkUrl

    // Per-row repair-attempt state (searches are the scarce resource here, not
    // fetches): { entries: { '<lane>:<id>': { attempts, last_at, exhausted } } }.
    let state = { entries: {} }
    try {
      const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(DEAD_URL_REPAIR_STATE_KEY)
      const parsed = row?.value ? JSON.parse(row.value) : null
      if (parsed && typeof parsed.entries === 'object' && parsed.entries) state = parsed
    } catch { /* fresh state */ }

    const nowMs = Date.now()
    const startedAt = nowMs
    let repaired = 0
    let recoveredAlive = 0
    let notFound = 0
    let outage = 0
    let refused = 0
    let skippedCooldown = 0

    const resetSqlFor = (lane) =>
      lane === 'grant'
        ? `UPDATE grants
              SET url = ?,
                  amount_enrich_attempted_at = NULL,
                  amount_enrich_attempts = 0,
                  amount_enrich_env_attempts = 0,
                  amount_enrich_last_reason = ?
            WHERE id = ?
              AND (amount_status IS NULL OR amount_status = 'not_listed')
              AND (amount_text IS NULL OR amount_text = '')
              AND COALESCE(amount_min, 0) <= 0
              AND COALESCE(amount_max, 0) <= 0
              AND COALESCE(amount_requested, 0) <= 0`
        : `UPDATE funding_opportunities
              SET source_url = ?,
                  amount_enrich_attempted_at = NULL,
                  amount_enrich_attempts = 0,
                  amount_enrich_env_attempts = 0,
                  amount_enrich_last_reason = ?
            WHERE id = ?
              AND (amount_status IS NULL OR amount_status = 'not_listed')
              AND (amount_text IS NULL OR amount_text = '')
              AND COALESCE(amount_min, 0) <= 0
              AND COALESCE(amount_max, 0) <= 0`

    // Un-burn WITHOUT touching the URL (the alive-again path): counters are
    // preserved so MAX_ATTEMPTS still bounds a flapping host.
    const unburnSqlFor = (lane) =>
      lane === 'grant'
        ? `UPDATE grants SET amount_enrich_attempted_at = NULL, amount_enrich_last_reason = ? WHERE id = ?`
        : `UPDATE funding_opportunities SET amount_enrich_attempted_at = NULL, amount_enrich_last_reason = ? WHERE id = ?`

    for (const cand of candidates) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      const stateKey = `${cand.lane}:${cand.id}`
      const entry = state.entries[stateKey] ?? { attempts: 0, last_at: null, exhausted: false }
      if (entry.exhausted) { skippedCooldown++; continue }
      if (entry.last_at && COOLDOWN_MS > 0 && nowMs - Date.parse(entry.last_at) < COOLDOWN_MS) { skippedCooldown++; continue }
      try {
        // 1. RE-PROVE deadness. 'skipped' covers an unresolvable domain (the
        //    probe's own SSRF/DNS guard) — dead for our purposes; ok/redirect
        //    means the URL answers today and needs no repair, only a re-read.
        const probe = await checkUrlImpl(cand.dead_url, { timeoutMs: 8000 })
        if (probe && (probe.status === 'ok' || probe.status === 'redirect')) {
          await db.prepare(unburnSqlFor(cand.lane)).run('dead_url_recovered_alive', cand.id)
          recoveredAlive++
          delete state.entries[stateKey]
          continue
        }
        // 2. Search for the row's REAL page by its own identity.
        const found = await findOfficialUrl({ title: cand.title, sponsor: cand.sponsor ?? '' })
        if (found?.searched === false) { outage++; continue } // provider outage: spend nothing
        entry.attempts += 1
        entry.last_at = new Date(nowMs).toISOString()
        if (entry.attempts >= MAX_ATTEMPTS) entry.exhausted = true
        state.entries[stateKey] = entry
        if (!found?.url) { notFound++; continue }
        // 3. Guards: canonical URL hygiene; a "new" URL identical to the dead
        //    one proved live by the finder's own probe → alive-recovery, not a
        //    repair.
        if (isSearchEngineUrl(found.url)) { refused++; continue }
        const norm = (u) => String(u ?? '').trim().toLowerCase().replace(/\/+$/, '')
        if (norm(found.url) === norm(cand.dead_url)) {
          await db.prepare(unburnSqlFor(cand.lane)).run('dead_url_recovered_alive', cand.id)
          recoveredAlive++
          delete state.entries[stateKey]
          continue
        }
        const wrote = await db.prepare(resetSqlFor(cand.lane)).run(found.url, 'dead_url_repaired', cand.id)
        if (changesOf(wrote) > 0) {
          repaired++
          delete state.entries[stateKey]
          log.info('dead_url_repair: replaced a dead source URL with a live, plausibility-gated page', {
            lane: cand.lane, id: cand.id, from: String(cand.dead_url).slice(0, 120), to: String(found.url).slice(0, 120),
          })
        }
      } catch (err) {
        log.warn('dead_url_repair: candidate failed (non-fatal, no attempt spent on errors)', {
          id: cand.id, error: String(err?.message || err),
        })
      }
    }

    try {
      const value = JSON.stringify({ updated_at: new Date(nowMs).toISOString(), entries: state.entries })
      const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, new Date(nowMs).toISOString(), DEAD_URL_REPAIR_STATE_KEY)
      if (!changesOf(res)) {
        await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(DEAD_URL_REPAIR_STATE_KEY, value, new Date(nowMs).toISOString())
      }
    } catch (err) {
      log.warn('dead_url_repair: state persist failed (non-fatal)', { error: String(err?.message || err) })
    }

    return {
      scanned: candidates.length, repaired, recoveredAlive, notFound, outage, refused,
      skippedCooldown, enforced: true,
    }
  })
}

export async function enforceFunderBackfill(db) {
  return runInvariant('funder_backfill', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('funder') || !grantCols.has('funding_opportunity_id')) {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const EMPTY_FUNDER = `(g.funder IS NULL OR TRIM(g.funder) = '')`
    let repaired = 0
    try {
      const result = await db
        .prepare(
          `UPDATE grants
              SET funder = (
                SELECT fo.sponsor FROM funding_opportunities fo
                 WHERE fo.id = grants.funding_opportunity_id
                   AND fo.sponsor IS NOT NULL AND TRIM(fo.sponsor) <> ''
              )
            WHERE (grants.funder IS NULL OR TRIM(grants.funder) = '')
              AND grants.funding_opportunity_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM funding_opportunities fo
                 WHERE fo.id = grants.funding_opportunity_id
                   AND fo.sponsor IS NOT NULL AND TRIM(fo.sponsor) <> ''
              )`,
        )
        .run()
      repaired = changesOf(result)
    } catch (err) {
      // funding_opportunities absent on a minimal test DB → count-only below.
      log.warn('funder_backfill: repair query failed (non-fatal)', { error: String(err?.message || err) })
    }

    // Observability: how many pipeline rows still show no funder (un-derivable
    // from stored metadata — an ingest-quality signal, not repairable here).
    let missing = 0
    try {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM grants g WHERE ${EMPTY_FUNDER}`)
        .get()
      missing = Number(row?.n) || 0
    } catch { /* non-fatal */ }

    if (repaired > 0) {
      log.info('backfilled grants.funder from linked funding_opportunities.sponsor', { repaired, stillMissing: missing })
    }
    return { scanned: repaired + missing, repaired, missingFunder: missing }
  })
}

/**
 * INVARIANT: NO PROFESSION-INELIGIBLE OPPORTUNITY IN A PROFILE'S PIPELINE OR
 * HAMILTON QUEUE (canonical_rules.md G4 — profile relevance / eligibility realism).
 *
 * THE BUG THIS CLOSES
 * -------------------
 * A Tennessee PARAMEDIC student (Robert) had his Hamilton "Needs your input"
 * queue polluted with items locked to a DIFFERENT licensed profession — "Ohio
 * Nurses Foundation — CE Scholarships", "Texas/Florida Nurses Foundation",
 * "Nurse.org — Nursing Scholarships", "NASW — Social Work CE". They leaked in
 * because a free-text employment note ("400 hours in skilled nursing facilities")
 * seeded a "nursing scholarships" open-web search, and NOTHING hard-gates an
 * opportunity restricted to a profession the applicant does not practise:
 *   - the scorer applies only SOFT penalties;
 *   - the pipeline-insert gate (applicantTypeGate) only knows individual/org/
 *     business — not occupation;
 *   - these rows carry match_score IS NULL (doctrine-protected), so the relevance
 *     floor never touches them.
 * Each pipeline grant spawns an application_tasks row, which is exactly the
 * "… — needs your input" item the owner reads in HamiltonWorkPanel.
 *
 * THE RULE (high-precision, reuses the shared predicate — no drift)
 * ----------------------------------------------------------------
 * professionEligibility.js decides, per (profile, grant), whether the grant is
 * LOCKED to a recognised licensed profession the profile does NOT practise. It is
 * deliberately conservative: it resolves the profile's profession ONLY from
 * CURATED identity fields (intended major / field of study / career goal /
 * occupation — never free-text experience) and the opportunity lock ONLY from its
 * IDENTITY (title + funder — never description). It NEVER rejects when the
 * profile's field is unknown or when the profile already practises the locked
 * profession. Dry-run over ALL production grants flagged only the true positives.
 *
 * REPAIR
 * ------
 *   - CANCEL every non-terminal application_task for an ineligible (profile,
 *     grant) — this is what removes the item from the Hamilton "needs your input"
 *     queue, regardless of the grant's pipeline status.
 *   - PURGE the grant itself ONLY when it is in an early/discovery status
 *     (PURGEABLE_DISCOVERY_STATUSES or NULL) — recording a sticky-delete tombstone
 *     first so it stays gone. A protected/user-progressed grant is NEVER deleted;
 *     it is only marked eligibility_status='ineligible' for audit (its task is
 *     still cancelled). MTSU/portal names and recorded awards (amount_awarded > 0)
 *     are never touched.
 *
 * OVERRIDE: ON by default. Set ENFORCE_PROFESSION_ELIGIBILITY=0 for count-only
 * (no writes). Idempotent: a purged grant is gone and a cancelled task is
 * terminal, so a re-run is a no-op.
 */
const TERMINAL_TASK_STATUSES = Object.freeze([
  'submitted', 'completed', 'complete', 'done',
  'cancelled', 'canceled', 'archived', 'rejected', 'closed',
])

export async function enforceProfileEligibility(db, { resolveSignals = null } = {}) {
  return runInvariant('profession_eligibility', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('title') || !grantCols.has('profile_id') || !grantCols.has('status')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }

    // Lazy imports (same pattern as enforceStudentAidEligibility) so a boot-time
    // module cycle can't abort the sweep and the SAME predicate the write-path
    // gate uses is reused here (no re-encoding → no drift).
    let professionSignalTextFromSections, resolveProfileProfessions, opportunityLockText, assessProfessionEligibility
    let cancelApplicationTask = null
    let recordDismissalFn = null
    try {
      ;({
        professionSignalTextFromSections, resolveProfileProfessions,
        opportunityLockText, assessProfessionEligibility,
      } = await import('../services/eligibility/professionEligibility.js'))
    } catch (err) {
      log.warn('profession_eligibility: predicate unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    try { ({ cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')) } catch { cancelApplicationTask = null }
    try { ({ recordDismissal: recordDismissalFn } = await import('../services/pipelineDismissals.js')) } catch { recordDismissalFn = null }

    const hasFunder = grantCols.has('funder')
    const hasAwarded = grantCols.has('amount_awarded')
    const hasEligStatus = grantCols.has('eligibility_status')

    const rows = await db
      .prepare(
        `SELECT id, profile_id, title, ${hasFunder ? 'funder' : 'NULL AS funder'}, status${hasAwarded ? ', amount_awarded' : ''}
           FROM grants WHERE profile_id IS NOT NULL AND title IS NOT NULL`,
      )
      .all()
    if (!rows || rows.length === 0) return { scanned: 0, repaired: 0, enforced: true }

    const byProfile = new Map()
    for (const r of rows) {
      if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
      byProfile.get(r.profile_id).push(r)
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_PROFESSION_ELIGIBILITY) === false
    // Does application_tasks exist? (cancel is a no-op on a minimal test DB.)
    let hasTasks = false
    try { await db.prepare('SELECT id FROM application_tasks LIMIT 1').get(); hasTasks = true } catch { hasTasks = false }

    // Resolve a profile's professions from its curated section fields. Injectable
    // for tests via resolveSignals(profileId) → signal text.
    async function professionsFor(profileId) {
      if (typeof resolveSignals === 'function') {
        return resolveProfileProfessions(await resolveSignals(profileId))
      }
      let sectionsByKey = {}
      try {
        const secs = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
        for (const s of secs || []) sectionsByKey[s.section_key] = s.data
      } catch { sectionsByKey = {} }
      return resolveProfileProfessions(professionSignalTextFromSections(sectionsByKey))
    }

    async function cancelTasksForGrant(profileId, grantId, reason) {
      if (!hasTasks || !cancelApplicationTask) return 0
      let taskRows = []
      try {
        const ph = TERMINAL_TASK_STATUSES.map(() => '?').join(', ')
        taskRows = await db
          .prepare(`SELECT id FROM application_tasks WHERE profile_id = ? AND grant_id = ? AND (status IS NULL OR status NOT IN (${ph}))`)
          .all(profileId, grantId, ...TERMINAL_TASK_STATUSES)
      } catch { taskRows = [] }
      let n = 0
      for (const t of taskRows || []) {
        try {
          await cancelApplicationTask(db, t.id, { actorRole: 'system', reason })
          n += 1
        } catch (err) {
          log.warn('profession_eligibility: task cancel failed (non-fatal)', { task: t.id, error: String(err?.message || err) })
        }
      }
      return n
    }

    let scanned = 0
    let grantsPurged = 0
    let tasksCancelled = 0
    const affectedProfiles = new Set()

    for (const [profileId, grants] of byProfile) {
      let professions
      try { professions = await professionsFor(profileId) } catch { professions = new Set() }
      // Field unknown / not a recognised profession → never touch this profile.
      if (!professions || professions.size === 0) continue

      for (const g of grants) {
        const verdict = assessProfessionEligibility({ itemText: opportunityLockText(g), professions })
        if (!verdict.ineligible) continue
        scanned += 1
        if (disabled) continue

        // 1) Clear the Hamilton queue: cancel this grant's non-terminal tasks.
        tasksCancelled += await cancelTasksForGrant(profileId, g.id, `Ineligible for this profile — ${verdict.reason}`)

        // 2) Purge the grant only when it's early/discovery + safe to remove.
        const status = g.status === null || g.status === undefined ? null : String(g.status)
        const isEarly = status === null || PURGEABLE_DISCOVERY_STATUSES.includes(status)
        const protectedName = PROTECTED_NAME_PATTERN.test(`${g.title ?? ''} ${g.funder ?? ''}`)
        const hasAward = hasAwarded && Number(g.amount_awarded) > 0

        if (isEarly && !protectedName && !hasAward) {
          if (recordDismissalFn) {
            try { await recordDismissalFn(db, { profileId, grantRow: g, reason: `profession_eligibility: ${verdict.reason}` }) } catch { /* tombstone best-effort */ }
          }
          try {
            const res = await db.prepare('DELETE FROM grants WHERE id = ?').run(g.id)
            grantsPurged += changesOf(res) || 1
          } catch (err) {
            log.warn('profession_eligibility: grant delete failed (non-fatal)', { grant: g.id, error: String(err?.message || err) })
          }
        } else if (hasEligStatus) {
          // Protected/awarded → keep the row (never destroy user work) but mark it.
          try { await db.prepare('UPDATE grants SET eligibility_status = ? WHERE id = ?').run('ineligible', g.id) } catch { /* audit-only */ }
        }
        affectedProfiles.add(profileId)
      }
    }

    if (disabled) {
      if (scanned > 0) {
        log.warn('profession-mismatched pipeline items present (repair DISABLED via ENFORCE_PROFESSION_ELIGIBILITY=0)', {
          scanned, profilesAffected: affectedProfiles.size,
        })
      }
      return { scanned, repaired: 0, enforced: false, tasksCancelled: 0, profilesAffected: affectedProfiles.size }
    }

    if (grantsPurged > 0 || tasksCancelled > 0) {
      log.info('profession_eligibility: removed profession-mismatched items from pipelines + Hamilton queue', {
        grantsPurged, tasksCancelled, profilesAffected: affectedProfiles.size,
      })
    }
    return { scanned, repaired: grantsPurged, tasksCancelled, enforced: true, profilesAffected: affectedProfiles.size }
  })
}

/**
 * Shared loader for {profile, sections} contexts, used by the score-backfill
 * and pipeline-refill invariants below. Returns null when the profile is
 * missing/deleted/non-discoverable.
 */
async function _loadProfileContextForInvariant(db, profileId) {
  const profile = await db
    .prepare(`SELECT * FROM profiles WHERE id = ? LIMIT 1`)
    .get(profileId)
  if (!profile || profile.deleted_at) return null
  const status = String(profile.status ?? '').trim().toLowerCase()
  if (['deleted', 'archived', 'merged', 'inactive'].includes(status)) return null
  const sections = {}
  try {
    const rows = await db
      .prepare(`SELECT section_key, data FROM profile_sections WHERE profile_id = ?`)
      .all(profileId)
    for (const row of rows || []) {
      try {
        sections[row.section_key] = typeof row.data === 'string' ? JSON.parse(row.data || '{}') : (row.data || {})
      } catch { sections[row.section_key] = {} }
    }
  } catch { /* sections table may be absent in minimal test DBs */ }
  return { profile, sections }
}

/**
 * INVARIANT: EVERY PIPELINE GRANT CARRIES A MATCH SCORE WHEN ONE IS COMPUTABLE
 * ("unscored rows are indistinguishable from endorsed rows" — the Eileen
 * Fisher-on-a-church class: a NULL-score row sits in the pipeline looking
 * exactly like an engine-endorsed match).
 *
 * THE RULE: a grants row with match_score IS NULL is re-scored through the
 * canonical engine (computeMatchDecision) against its own profile, using the
 * linked catalog row when available and the grant's own fields otherwise.
 * The engine's honest number is stamped — including a LOW number for a
 * mismatch, which then becomes visible on every card and governable by the
 * relevance floor (whose status/name/origin protections still apply).
 * Rows that cannot be scored (no resolvable profile) are counted, not guessed.
 *
 * Bounded per boot (SCORE_BACKFILL_BATCH, default 300) so a large backlog
 * converges across a few boots instead of stalling one.
 *
 * OVERRIDE: ON by default; ENFORCE_GRANT_SCORE_BACKFILL=0 for count-only.
 */
export async function enforceGrantScoreBackfill(db) {
  return runInvariant('grant_score_backfill', async () => {
    let candidates
    try {
      candidates = await db
        .prepare(
          `SELECT g.id, g.profile_id, g.funding_opportunity_id, g.title, g.description,
                  g.funder, g.deadline, g.amount_min, g.amount_max
           FROM grants g
           WHERE g.match_score IS NULL AND g.profile_id IS NOT NULL
           LIMIT ${Math.max(1, Number.parseInt(process.env.SCORE_BACKFILL_BATCH || '300', 10) || 300)}`,
        )
        .all()
    } catch {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }
    if (!candidates?.length) return { scanned: 0, repaired: 0, enforced: true }

    const disabled = _parseBoolEnv(process.env.ENFORCE_GRANT_SCORE_BACKFILL) === false
    if (disabled) {
      log.warn('unscored pipeline grants present (backfill DISABLED via ENFORCE_GRANT_SCORE_BACKFILL=0)', {
        scanned: candidates.length,
      })
      return { scanned: candidates.length, repaired: 0, enforced: false }
    }

    // Lazy import: matchEngine pulls a large module graph; only pay for it
    // when there is actually something to score (and avoid boot-order cycles).
    const { computeMatchDecision } = await import('../services/matchEngine.js')

    const contextCache = new Map()
    let repaired = 0
    let unscorable = 0
    for (const g of candidates) {
      let ctx = contextCache.get(g.profile_id)
      if (ctx === undefined) {
        ctx = await _loadProfileContextForInvariant(db, g.profile_id)
        contextCache.set(g.profile_id, ctx)
      }
      if (!ctx) { unscorable++; continue }

      let opp = null
      if (g.funding_opportunity_id) {
        try {
          opp = await db
            .prepare(`SELECT * FROM funding_opportunities WHERE id = ? LIMIT 1`)
            .get(g.funding_opportunity_id)
        } catch { /* fall through to grant-row scoring */ }
      }
      const scoreTarget = opp ?? {
        id: g.id, title: g.title, description: g.description, sponsor: g.funder,
        deadline: g.deadline, amount_min: g.amount_min, amount_max: g.amount_max,
      }
      try {
        const decision = computeMatchDecision(ctx.profile, scoreTarget, { profileSections: ctx.sections })
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { unscorable++; continue }
        await db
          .prepare(`UPDATE grants SET match_score = ?, match_decision = COALESCE(match_decision, ?) WHERE id = ?`)
          .run(score, String(decision?.decision ?? 'REVIEW'), g.id)
        repaired++
      } catch (err) {
        unscorable++
        log.warn('grant_score_backfill: scoring failed for grant (non-fatal)', {
          grant: g.id, error: String(err?.message || err),
        })
      }
    }
    if (repaired > 0) {
      log.info('backfilled match scores onto unscored pipeline grants', { repaired, unscorable })
    }
    return { scanned: candidates.length, repaired, unscorable, enforced: true }
  })
}

/**
 * Run every machine-checkable product invariant, in order. Mirrors
 * ensureSchemaInvariants.js: each step is independently guarded, the whole
 * run never throws, and a structured summary is returned + logged.
 *
 * Order: sticky-deletes first (removes rows other invariants would otherwise
 * inspect), then tenancy re-alignment, then the relevance-floor signal.
 *
 * @returns {Promise<{ steps: Array<object>, ran: number, failed: number, totalRepaired: number }>}
 */
/**
 * INVARIANT: A 'converted' service application MUST point at a live profile.
 *
 * "Convert to Profile" used to only flip the status flag — the admin saw
 * "converted" while NO profile existed anywhere (the invisible-Anita bug,
 * 2026-07-06): the profile list showed nothing and the applicant's email
 * couldn't pass the production login gate. The per-call gate is the PATCH
 * route (routes/serviceApplication.js) calling convertApplicationToProfile;
 * this sweep is the net that heals rows converted by any other path (or
 * before the fix shipped). Conservative: ambiguous email/name matches are
 * flagged for human review, never guessed.
 */
export async function enforceConvertedApplicationsHaveProfiles(db) {
  return runInvariant('converted_applications_have_profiles', async () => {
    const result = await reconcileConvertedApplications(db)
    return {
      scanned: result.scanned,
      repaired: result.repaired,
      createdProfiles: result.createdProfiles,
      flagged: result.flagged,
    }
  })
}

/**
 * INVARIANT: ADMIN ACCOUNTS ARE NEVER RE-INTERVIEWED (owner-directed,
 * 2026-07-06 — "take away the Anya interview for secondary logins for admin").
 *
 * The one-time admin bulk reset stamped `users.guided_cycle_tour_status =
 * 'pending_reinterview'` to put existing users back through the new-user
 * experience (video → Anya's gap interview → guided tour). It also stamped
 * ADMIN accounts — and since the flag only clears when the whole sequence is
 * completed, every admin login re-opened the interview.
 *
 * REPAIR: any ADMIN row sitting in 'pending_reinterview' that has already had
 * its first-run (completed onboarding, or has EVER signed in before —
 * last_login_at is stamped at the createSessionAndTokens choke point) is
 * resolved to 'completed'. A genuinely fresh admin account (never onboarded,
 * never signed in) keeps its one first-run experience. Non-admin users are
 * NEVER touched — their reset flow is deliberate product behavior.
 *
 * Per-call first line of defense: resolveGuidedCycleTourStatus()
 * (backend/services/onboardingGates.js), applied wherever an auth payload
 * serializes guided_cycle_tour_status (buildUserPayload, GET /api/auth/me,
 * PATCH /api/auth/onboarding-state). This boot net repairs the rows
 * themselves so the flag cannot outlive a read path that forgot the gate.
 */
export async function enforceAdminReinterviewSuppression(db) {
  return runInvariant('admin_reinterview_suppression', async () => {
    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    // is_admin / has_completed_onboarding are BOOLEAN on Postgres but
    // INTEGER 0/1 on SQLite — spell the truthiness per dialect.
    const adminTrue = isPg
      ? 'is_admin IS TRUE'
      : 'COALESCE(is_admin, 0) = 1'
    const firstRunAlready = isPg
      ? '(has_completed_onboarding IS TRUE OR onboarding_completed_at IS NOT NULL OR last_login_at IS NOT NULL)'
      : '(COALESCE(has_completed_onboarding, 0) = 1 OR onboarding_completed_at IS NOT NULL OR last_login_at IS NOT NULL)'
    let result
    try {
      result = await db
        .prepare(
          `UPDATE users
              SET guided_cycle_tour_status = 'completed'
            WHERE guided_cycle_tour_status = 'pending_reinterview'
              AND ${adminTrue}
              AND ${firstRunAlready}`,
        )
        .run()
    } catch (err) {
      // Degrade silently on schema-less DBs (stripped test fixtures, partial
      // restores): ensureSchemaInvariants owns creating users tour columns
      // BEFORE this sweep runs in prod, so a missing table/column here is a
      // shape problem, not a data violation. Anything else is a real failure.
      const msg = String(err?.message || err).toLowerCase()
      if (msg.includes('no such table') || msg.includes('no such column') || msg.includes('does not exist')) {
        return { repaired: 0, skipped: 'users_tour_columns_missing' }
      }
      throw err
    }
    const repaired = changesOf(result)
    if (repaired > 0) {
      log.info('cleared pending_reinterview from already-onboarded admin accounts', { repaired })
    }
    return { repaired }
  })
}

/**
 * INVARIANT: AMY SYNTHETIC PROFILES EXPIRE (owner directive 2026-07-06 —
 * "make sure those profiles are getting deleted afterwards").
 *
 * THE BUG THIS CLOSES
 * -------------------
 * Amy's end-of-run cleanup was scoped to the profile ids SHE saw crawled in
 * THAT run (onlyIds = crawledProfileIds). In prod, discovery results for her
 * cohort skipped/threw, so the list was EMPTY every run → cleanup deleted
 * nothing, lifetime reap count 0, and 13 synthetic profiles accumulated —
 * including rows days past their amy_metadata.expires_at. Leftovers from
 * prior runs were permanently out of the per-run pass's scope by design.
 *
 * THE RULE
 * --------
 * A synthetic crawler-training profile (created_by='agent:amy', metadata
 * synthetic:true + allow_sam_cleanup:true) that is past its expires_at must
 * not outlive the next boot. This net calls the SAME guarded sweep the
 * end-of-run second pass and the nightly sweep use — cleanupExpiredAmyProfiles
 * (backend/services/amy/amyProfileStore.js) — so every safety guard holds
 * here too and is never re-implemented:
 *   - non-Amy rows are never scanned (created_by scope inside listAmyProfiles);
 *   - designated/system profiles are never touched;
 *   - metadata must say allow_sam_cleanup:true AND synthetic:true;
 *   - never-crawled rows are reaped ONLY far past TTL
 *     (AMY_NEVER_CRAWLED_MAX_AGE_HOURS, default 96h; TTL max is 72h);
 *   - a profile crawled within the last 6h is kept (mid-flight grace).
 *
 * Per-call first lines of defense: the end-of-run scoped cleanup + the new
 * unscoped expired pass in runAmyTraining, and the nightly maintenance sweep.
 * This boot net guarantees the rule regardless of whether those ran.
 *
 * OVERRIDE: ON by default; ENFORCE_AMY_SYNTHETIC_EXPIRY=0 for count-only
 * (dry-run: reports what WOULD be reaped, deletes nothing). Idempotent:
 * reaped rows are gone on re-run; a clean DB yields zero repairs.
 */
export async function enforceAmySyntheticExpiry(db, deps = {}) {
  return runInvariant('amy_synthetic_expiry', async () => {
    // Schema probe: minimal test DBs may lack profiles.created_by or the
    // profile_sections table the sweep reads — degrade to a skip, not a failure.
    try {
      await db.prepare('SELECT created_by FROM profiles LIMIT 1').get()
      await db.prepare('SELECT 1 FROM profile_sections LIMIT 1').get()
    } catch {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const enforce = _parseBoolEnv(process.env.ENFORCE_AMY_SYNTHETIC_EXPIRY) !== false
    // Lazy import (same precedent as the relevanceFloor config resolution):
    // keeps the boot module from statically pulling the services/amy graph.
    const cleanupExpired =
      deps.cleanupExpiredAmyProfiles ??
      (await import('../services/amy/amyProfileStore.js')).cleanupExpiredAmyProfiles
    const result = await cleanupExpired(db, { dryRun: !enforce })
    const wouldReap = Number(result?.deleted) || 0
    if (!enforce) {
      if (wouldReap > 0) {
        log.warn('expired Amy synthetic profiles present (reap DISABLED via ENFORCE_AMY_SYNTHETIC_EXPIRY=0)', {
          wouldReap,
          scanned: result?.scanned ?? 0,
        })
      }
      return { scanned: Number(result?.scanned) || 0, repaired: 0, wouldReap, enforced: false }
    }
    if (wouldReap > 0) {
      log.info('reaped expired Amy synthetic training profiles', {
        repaired: wouldReap,
        scanned: result?.scanned ?? 0,
      })
    }
    return { scanned: Number(result?.scanned) || 0, repaired: wouldReap, enforced: true }
  })
}

/**
 * A Yana lead's contact email actually belongs to THAT organization.
 *
 * Prod damage (2026-07-15): contact enrichment sorted candidate homepages by
 * name score but took the top one unconditionally, so when nothing matched the
 * org it scraped an unrelated site's address — helpdesk@franklin.edu on 10
 * distinct orgs, a newspaper's admin@conwaydailysun.com on 14, worldatlas /
 * mathway / roblox addresses on dozens more; 147 of 490 enriched candidates
 * shared an address with a DIFFERENT org. Each one makes John draft outreach to
 * the wrong organization. The per-call gate is `isPlausibleHomepage` in the
 * enricher; this is the net for rows already persisted (and for any future path
 * that writes a contact email).
 *
 * Repair = strip the address and send the lead back to `needs_enrichment` with
 * a fresh retry budget, so the now-gated enricher can find the RIGHT address.
 * It never invents a contact and never deletes a lead — the org keeps its
 * identity and simply waits until it is honestly reachable.
 *
 * Deliberately conservative about what it strips: only when the email's domain
 * carries NO distinctive token of the org name. A legitimate abbreviated domain
 * (upenn.edu for University of Pennsylvania) is stripped here but re-accepted on
 * the next enrichment pass, which sees the page TITLE this row no longer has —
 * self-healing, and it never leaves a WRONG address in place.
 *
 * Count-only via ENFORCE_LEAD_CONTACT_PLAUSIBILITY=0. Bounded per boot.
 */
/**
 * INVARIANT: no LIVE draft in the mailbox is addressed to the wrong organization.
 *
 * enforceLeadContactPlausibility() repairs the LEAD, but a draft John already
 * wrote from a bad lead keeps sitting in Drafts with the wrong recipient — and
 * a draft is one click (or one stray automation) from being sent to a stranger.
 * On 2026-07-15, 9 of 10 live drafts were addressed to an unrelated business
 * (`willienelson.com` for the "Willie Julie Educational Foundation",
 * `robertsoncountyfuneralhome.com` for the "Robertson Community Health
 * Foundation"). `purgeImplausibleDrafts()` already existed and could have caught
 * them, but NOTHING ever called it — it was reachable only via a manual
 * `POST /api/john/purge-implausible`. Per the choke-point rule, the mailbox
 * residue needs the same boot net the lead data has.
 *
 * Archives the row + removes the draft from the mailbox (Graph DELETE → Deleted
 * Items, recoverable; the provider REFUSES anything that is not still a draft,
 * so a sent message is never touched). The lead returns to enrichment and John
 * can re-draft it correctly — nothing is lost, and a wrong-org draft cannot sit
 * there waiting to be sent.
 *
 * NEVER sends. NEVER judges on a guess: a draft with no org name or no
 * recipient is skipped, not purged.
 *
 * OVERRIDE: ON by default; ENFORCE_JOHN_DRAFT_PLAUSIBILITY=0 for count-only
 * (dry-run — reports what WOULD be purged and touches nothing).
 * Bound: JOHN_DRAFT_PLAUSIBILITY_LIMIT (default 200).
 */
export async function enforceJohnDraftPlausibility(db, deps = {}) {
  return runInvariant('john_draft_plausibility', async () => {
    try {
      // Table is john_email_drafts (NOT john_drafts — the indexes are named
      // idx_john_drafts_*, which is a trap: probing the wrong name returns
      // skipped:'schema' and the whole invariant no-ops while reading green).
      await db.prepare('SELECT recipient_email FROM john_email_drafts LIMIT 1').get()
    } catch {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const dryRun = _parseBoolEnv(process.env.ENFORCE_JOHN_DRAFT_PLAUSIBILITY) === false
    const limit = Math.max(1, Number(process.env.JOHN_DRAFT_PLAUSIBILITY_LIMIT || 200))

    // Lazy imports — keep the boot module from statically pulling the john/Graph
    // graph (same precedent as enforceLeadContactPlausibility).
    const { purgeImplausibleDrafts } =
      deps.purgeImpl ? { purgeImplausibleDrafts: deps.purgeImpl } : await import('../services/john/johnDraftPlausibilityPurge.js')

    // No provider (Graph not configured) → still archive the ROWS? No: the store
    // must keep telling the truth about what is in the mailbox, so without a
    // provider we report only. The purge itself enforces that rule per-draft.
    let provider = deps.provider ?? null
    if (!provider && !dryRun) {
      try {
        const [{ getJohnConfig }, { createOutlookProvider }] = await Promise.all([
          import('../services/john/johnOutreachSafety.js'),
          import('../services/john/johnOutlookProvider.js'),
        ])
        const p = createOutlookProvider({ config: getJohnConfig(), logger: log })
        provider = p?.ready ? p : null
      } catch { provider = null }
    }

    const result = await purgeImplausibleDrafts(db, { provider, dryRun: dryRun || !provider, limit })

    if ((result?.implausible ?? 0) > 0) {
      const mode = dryRun ? 'DISABLED via ENFORCE_JOHN_DRAFT_PLAUSIBILITY=0' : (provider ? 'purged' : 'no Outlook provider — report only')
      log.warn('drafts addressed to the WRONG organization present', {
        implausible: result.implausible,
        purged: result.purged ?? 0,
        mode,
        orgs: (result.items || []).slice(0, 6).map((i) => `${i.organization_name} → ${i.recipient_email}`),
      })
    }
    return {
      scanned: result?.scanned ?? 0,
      repaired: result?.purged ?? 0,
      implausible: result?.implausible ?? 0,
      mailboxDeleted: result?.mailbox_deleted ?? 0,
      failed: result?.failed ?? 0,
      enforced: !dryRun && Boolean(provider),
    }
  })
}

export async function enforceLeadContactPlausibility(db) {
  return runInvariant('lead_contact_plausibility', async () => {
    try {
      await db.prepare('SELECT contact_email FROM yana_lead_candidates LIMIT 1').get()
    } catch {
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const enforce = _parseBoolEnv(process.env.ENFORCE_LEAD_CONTACT_PLAUSIBILITY) !== false
    const limit = Math.max(1, Number(process.env.LEAD_CONTACT_PLAUSIBILITY_LIMIT || 500))
    // Lazy import — keeps the boot module from statically pulling the yana graph
    // (same precedent as enforceAmySyntheticExpiry).
    const { isPlausibleHomepage } = await import('../services/yana/prospectExclusions.js')

    const rows = await db
      .prepare(
        `SELECT id, organization_name, contact_email
           FROM yana_lead_candidates
          WHERE contact_email IS NOT NULL AND TRIM(contact_email) <> ''
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(limit)

    const bad = []
    for (const row of rows || []) {
      const domain = String(row.contact_email).split('@')[1]
      if (!domain || !row.organization_name) continue
      // Title-less check: the stored row has no page title to vouch for an
      // abbreviation, so this is the hostname-only bar. Stripping is safe (the
      // gated re-enrichment restores a real match); keeping a wrong one is not.
      if (!isPlausibleHomepage({ url: `https://${domain}`, title: '' }, row.organization_name)) {
        bad.push(row)
      }
    }

    if (!enforce) {
      if (bad.length > 0) {
        log.warn('Yana leads carry an implausible contact email (repair DISABLED via ENFORCE_LEAD_CONTACT_PLAUSIBILITY=0)', {
          wouldRepair: bad.length,
          scanned: rows?.length || 0,
          examples: bad.slice(0, 3).map((b) => `${b.organization_name} → ${b.contact_email}`),
        })
      }
      return { scanned: rows?.length || 0, repaired: 0, wouldRepair: bad.length, enforced: false }
    }

    const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
    let repaired = 0
    for (const row of bad) {
      await db
        .prepare(
          `UPDATE yana_lead_candidates
              SET contact_email = NULL,
                  qualification_status = 'needs_enrichment',
                  pushed_to_john = 0,
                  enrich_attempts = 0,
                  contact_confidence = 0,
                  updated_at = ${nowFn}
            WHERE id = ?`,
        )
        .run(String(row.id))
      repaired += 1
    }
    if (repaired > 0) {
      log.info('stripped implausible contact emails from Yana leads (returned to needs_enrichment)', {
        repaired,
        scanned: rows?.length || 0,
        examples: bad.slice(0, 3).map((b) => `${b.organization_name} → ${b.contact_email}`),
      })
    }
    return { scanned: rows?.length || 0, repaired, enforced: true }
  })
}

/**
 * INVARIANT: persisted surfaced matches obey the decision contract.
 * REJECT rows are removed, below-REVIEW resources are removed, and surviving
 * directory/referral/school-portal evidence is labelled REVIEW. This global,
 * idempotent boot net repairs legacy and web-llm rows regardless of writer.
 */
export async function enforcePersistedMatchDecisionIntegrity(db) {
  return runInvariant('persisted_match_decision_integrity', async () => {
    const result = await normalizePersistedMatchDecisionIntegrity(db)
    return {
      scanned: Number(result?.scanned_canonical_evidence || 0),
      repaired: Number(result?.repaired || 0),
      removedRejects: Number(result?.removed_rejects || 0),
      removedCanonicalRejects: Number(result?.removed_canonical_rejects || 0),
      removedBelowReviewResources: Number(result?.removed_below_review_resources || 0),
      normalizedResources: Number(result?.normalized_resources || 0),
      ...(result?.reason ? { skipped: result.reason } : {}),
    }
  })
}

export async function runEnforceInvariants(db, { logger = log } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    logger?.warn?.('runEnforceInvariants: no usable db handle; skipping')
    return { steps: [], ran: 0, failed: 0, totalRepaired: 0 }
  }

  const steps = []
  steps.push(await enforceStickyDeletes(db))
  // Normalize stale designated-slug profile_ids to canonical ids BEFORE the
  // tenancy/scope sweeps so they operate on real, resolvable profile ids.
  steps.push(await enforceProfileIdIntegrity(db))
  steps.push(await enforceNoCrossProfileBleed(db))
  // Drop profile-less orphans next: removes rows the duplicate + relevance
  // sweeps would otherwise waste time scanning, and closes the org-scoped PDF
  // leak at the data layer (the print-side guard is the first line of defense).
  steps.push(await enforceProfileScopedPipeline(db))
  steps.push(await enforceNoDuplicateGrants(db))
  // Status-provenance honesty BEFORE the relevance floor: import-stamped
  // "submitted" rows (no real submission ever happened) are demoted to
  // 'discovered' so the floor / score-backfill nets can finally judge them —
  // protected statuses shield USER work, not bulk-import artifacts.
  steps.push(await enforceImportedStatusHonesty(db))
  steps.push(await enforceRelevanceFloor(db))
  // Pipeline-$ visibility: inherit award min/max from the linked catalog row
  // and default amount_requested from the ceiling/floor wherever empty, so
  // every Pipeline Potential surface can see the money that is actually there.
  // MUST run before the individual amount ceiling so the ceiling operates on
  // honest (backfilled) values.
  // Catalog LINK first: an unlinked grant is invisible to BOTH amount nets
  // below (they only reach a grant through funding_opportunity_id). Linking it
  // to its catalog twin here — URL-identity, exactly-one, profile-safe — puts it
  // in reach of the enrichment + backfill in the SAME boot.
  steps.push(await enforceGrantCatalogLink(db))
  // Kind honesty BEFORE amount acquisition: a locator/benefit page (sam.gov
  // assistance listings, ssa.gov benefit sections) gets its POSITIVE
  // opportunity_kind classification first, so the enrichment sweeps and the
  // amount-answer census stop treating a pointer page as a missing award.
  steps.push(await enforceLocatorKindClassification(db))
  // SOURCE-level same-domain self-repair first (the registry is code, so a
  // moved source page is otherwise unrepairable at runtime): a persistently-
  // failing source gets a same-registrable-domain override the discovery
  // fetcher applies; cross-domain moves become owner proposals.
  steps.push(await enforceSourceUrlSelfRepair(db))
  // Dead-URL repair BEFORE amount acquisition: a row whose domain no longer
  // resolves / permanently 404s gets its REAL page found (search → plausibility
  // → liveness) and its enrich state reset, so the sweeps just below read the
  // repaired URL in this same boot instead of skipping a burned row.
  steps.push(await enforceDeadUrlRepair(db))
  // Amount ACQUISITION first: read the funder's own page for active-pipeline
  // sources that carry no dollar figure (bounded per boot), so the backfill
  // right after can mirror freshly-learned amounts onto the grants same-boot.
  steps.push(await enforceAmountEnrichment(db))
  steps.push(await enforceGrantAmountBackfill(db))
  // Last mile: a grant with NO catalog twin is invisible to both nets above.
  // Read its own url directly (scholarship → amount; locator → honest
  // none_published), so an answerable orphan never sits in the coverage census
  // as unanswered just because nothing looked at it.
  steps.push(await enforceGrantDirectAmountEnrichment(db))
  // Amount-sanity net: purge institutional-scale ($ > ceiling) grants that were
  // mis-matched into an INDIVIDUAL/student pipeline (the ">$3M potential" bug).
  // Runs after the relevance floor because those below-floor rows are cheaper to
  // drop first; orgs/businesses and user-progressed work are never touched.
  steps.push(await enforceIndividualAmountCeiling(db))
  // Surface-table eligibility net: demote persisted student-aid matches that are
  // surfacing to a NON-student profile (stale ACCEPTs the live engine already
  // caps below the floor, e.g. web-llm rows that the reconcile never re-scores).
  // Operates on profile_opportunity_matches, so it complements the grants sweeps.
  steps.push(await enforceStudentAidEligibility(db))
  // Surface-table hygiene: a persisted match whose catalog row was deleted
  // (dedupe/reality-gate/reaper purges never cleaned matches up) is an
  // unusable ghost that inflates the matches view and wastes promote passes.
  steps.push(await enforceNoDanglingMatches(db))
  // Persisted-decision integrity AFTER dangling cleanup: no direct REJECT may
  // remain surfaced, and every surviving resource is REVIEW rather than ACCEPT.
  steps.push(await enforcePersistedMatchDecisionIntegrity(db))
  // Profession-eligibility net: cancel the Hamilton tasks + purge the early-status
  // grants for opportunities LOCKED to a profession the profile does not practise
  // (e.g. a nursing scholarship in a paramedic student's pipeline). Reuses the
  // shared professionEligibility predicate; conservative (never touches a profile
  // whose field is unknown, or a profession the profile actually practises).
  steps.push(await enforceProfileEligibility(db))
  // Pipeline DATA repair: re-copy the funder's name from the linked catalog row
  // (sponsor→funder) wherever naming drift left grants.funder empty; count the
  // un-derivable remainder for observability. Runs after the purge sweeps so it
  // never wastes work repairing rows they are about to remove.
  steps.push(await enforceFunderBackfill(db))
  // Profile-level data repair (not pipeline): collapse any doubled display_name
  // (e.g. "Jordan Lane Jordan Michael Lane") back to a single name.
  steps.push(await enforceProfileDisplayNameNotDoubled(db))
  // Profile-level DATA repair (not pipeline): collapse a conflicting income
  // across the 'financial' vs 'financial_information' sections of an INDIVIDUAL
  // profile down to the applicant's own (need-consistent / lower) figure, so
  // need-based matching can't be poisoned by a captured parent/household income.
  steps.push(await enforceProfileIncomeReconciliation(db))
  // Profile-level data repair (not pipeline): clear a contradicted org identity
  // (organization_details.organization_type / small_business_details.business_name)
  // hallucinated onto a person-type profile whose OWN occupation flags already
  // deny it (nonprofit_employee=false, small_business_owner=false) — the class
  // that promoted a disabled individual to an org applicant type and surfaced
  // institutional RFPs instead of individual-benefit programs.
  steps.push(await enforceIndividualOrgSectionConflict(db))
  // Hamilton lifecycle self-heal: re-queue blocked tasks whose missing-profile-
  // field preflight blocker no longer reproduces, and collapse already-stacked
  // duplicate OPEN hard-stops (keep oldest, resolve extras as 'duplicate').
  steps.push(await enforceHamiltonTaskSelfHeal(db))
  // AFTER the task self-heal so a just-requeued task's remaining flags are
  // reconciled in the same boot (and a fully-answered one can resume).
  steps.push(await enforceStaleMissingFieldResolution(db))
  // System-side stops (crawler policy / portal URL) re-checked with the same
  // code that wrote them; zombie tasks for purged sources are closed.
  steps.push(await enforceHamiltonStopRecheck(db))
  // URL-hygiene net: a search-engine RESULTS url is never a portal/application
  // target — null it wherever it was persisted and reclassify affected tasks
  // to the truthful unknown_application_method state.
  steps.push(await enforceNoSearchEngineApplicationTargets(db))
  // Canonical-program net: a row naming a registered public program (TN
  // Promise / Reconnect / HOPE) must send the applicant to the program's
  // OFFICIAL application URL — never the program page / blog post / forum
  // thread that happened to mention it (the "TN Promise opens a paramedic
  // page" class). Runs right after URL hygiene so both target repairs land
  // the same boot.
  steps.push(await enforceCanonicalProgramApplicationTargets(db))
  // Verification-honesty net: clear `last_verified_at` timestamps that the
  // crawler-os source-capture path stamped from the SOURCE page's fetched_at
  // (never a real target check), so the recurring verifier stops skipping them
  // and the Source Trace UI stops showing a scrape time as a "verified" time.
  // Bounded per boot; only touches rows with a verification time but zero
  // verification evidence.
  steps.push(await enforceLiveCrawlVerifiedAtHonesty(db))
  // Application-URL rescue: a candidate rejected ONLY for a missing URL gets
  // ONE bounded, budget-paced chance to be re-driven with a real, liveness-
  // verified page found by title+sponsor web search (never invented). Runs
  // AFTER the URL-hygiene net so a rescued row is immediately covered by it.
  steps.push(await enforceApplicationUrlRescue(db))
  // Score-visibility net: stamp an honest canonical score on any unscored
  // pipeline row so a manually-added mismatch can never masquerade as an
  // engine-endorsed match. Runs AFTER the purge sweeps (their status/name
  // protections still govern any subsequent floor action on the new scores).
  steps.push(await enforceGrantScoreBackfill(db))
  // Intake integrity net: every 'converted' service application must point at a
  // live profile (create-or-link); otherwise a real applicant is invisible to
  // the admin and locked out of login.
  steps.push(await enforceConvertedApplicationsHaveProfiles(db))
  // Admin UX net: an already-onboarded (or previously signed-in) ADMIN account
  // never sits in 'pending_reinterview' — a secondary admin login must not
  // re-open Anya's interview. Cheap single UPDATE on users.
  steps.push(await enforceAdminReinterviewSuppression(db))
  // Agent-data hygiene net: an EXPIRED Amy synthetic training profile never
  // outlives the boot — the run-scoped end-of-run cleanup silently no-ops when
  // discovery skips/errors (empty crawled-id list), so without this net
  // synthetics accumulate forever (the 13-live/0-reaped prod class).
  steps.push(await enforceAmySyntheticExpiry(db))
  steps.push(await enforceLeadContactPlausibility(db))
  // AFTER the lead repair: the lead is the cause, the draft is the residue.
  // Repairing the lead first means a draft purged here can be re-drafted from a
  // corrected lead on the next John pass.
  steps.push(await enforceJohnDraftPlausibility(db))

  const failed = steps.filter((s) => !s.ok).length
  const totalRepaired = steps.reduce((sum, s) => sum + (Number(s.repaired) || 0), 0)

  logger?.info?.('[enforce-invariants] summary', {
    ran: steps.length,
    failed,
    totalRepaired,
    steps: steps.map((s) => ({
      name: s.name,
      ok: s.ok,
      repaired: s.repaired ?? 0,
      ...(s.quarantined !== undefined ? { quarantined: s.quarantined } : {}),
      ...(s.scanned !== undefined ? { scanned: s.scanned } : {}),
      ...(s.duplicatesRemoved !== undefined ? { duplicatesRemoved: s.duplicatesRemoved } : {}),
      ...(s.profilesAffected !== undefined ? { profilesAffected: s.profilesAffected } : {}),
      ...(s.flagged !== undefined ? { flagged: s.flagged } : {}),
      ...(s.missingFunder !== undefined ? { missingFunder: s.missingFunder } : {}),
      ...(s.createdProfiles !== undefined ? { createdProfiles: s.createdProfiles } : {}),
      ...(s.missingAmount !== undefined ? { missingAmount: s.missingAmount } : {}),
      ...(s.floor !== undefined ? { floor: s.floor, floorSource: s.floorSource } : {}),
      ...(s.wouldReap !== undefined ? { wouldReap: s.wouldReap } : {}),
      // Repair-net detail (owner rule: Sam repairs, not monitors — and a
      // repair Sam cannot SEE is one it cannot report or escalate). Without
      // these, dead_url_repair persisted as a bare "repaired 0/3" with the
      // why (notFound vs outage vs refused) living only in boot logs.
      ...(s.structural_reclaimed !== undefined ? { structural_reclaimed: s.structural_reclaimed } : {}),
      ...(s.recoveredAlive !== undefined ? { recoveredAlive: s.recoveredAlive } : {}),
      ...(s.notFound !== undefined ? { notFound: s.notFound } : {}),
      ...(s.outage !== undefined ? { outage: s.outage } : {}),
      ...(s.refused !== undefined ? { refused: s.refused } : {}),
      ...(s.skippedCooldown !== undefined ? { skippedCooldown: s.skippedCooldown } : {}),
      ...(s.proposed !== undefined ? { proposed: s.proposed } : {}),
      ...(s.aliveNoRepair !== undefined ? { aliveNoRepair: s.aliveNoRepair } : {}),
    })),
  })

  // Agent observability (standing rule: agent-scope mechanisms must be
  // visible to Sam + Anya): persist the latest sweep summary to system_kv so
  // the Sam check `pipeline.invariantSweepOutcomes` — and through it Anya's
  // daily owner digest — can read what the boot nets actually did, instead of
  // the outcomes living only in ephemeral boot logs. Best-effort.
  try {
    const value = JSON.stringify({
      at: new Date().toISOString(),
      ran: steps.length,
      failed,
      totalRepaired,
      steps: steps.map((s) => ({ name: s.name, ok: s.ok, repaired: s.repaired ?? 0, scanned: s.scanned ?? 0, ...(s.error ? { error: s.error } : {}) })),
    })
    const iso = new Date().toISOString()
    await db.prepare('CREATE TABLE IF NOT EXISTS system_kv (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)').run()
    const res = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(value, iso, 'enforce_invariants_last_run')
    if (!Number(res?.changes ?? res?.rowCount ?? 0)) {
      await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run('enforce_invariants_last_run', value, iso)
    }
  } catch { /* observability is best-effort — never fail the boot sweep */ }

  return { steps, ran: steps.length, failed, totalRepaired }
}

function _parseBoolEnv(value) {
  if (value === null || value === undefined) return null
  const v = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false
  return null
}

export const __testables = {
  PROTECTED_PIPELINE_STATUSES,
  PROTECTED_NAME_PATTERN,
  PURGEABLE_DISCOVERY_STATUSES,
  RELEVANCE_FLOOR,
  RELEVANCE_FLOOR_FALLBACK,
  INDIVIDUAL_AMOUNT_CEILING_DEFAULT,
  enforceProfileScopedPipeline,
  enforceProfileIncomeReconciliation,
  enforceIndividualOrgSectionConflict,
  enforceIndividualAmountCeiling,
  enforceStudentAidEligibility,
  enforceProfileEligibility,
  enforceFunderBackfill,
  enforceGrantAmountBackfill,
  enforceNoDanglingMatches,
  enforcePersistedMatchDecisionIntegrity,
  enforceImportedStatusHonesty,
  enforceGrantCatalogLink,
  enforceAmountEnrichment,
  enforceGrantDirectAmountEnrichment,
  enforceDeadUrlRepair,
  enforceSourceUrlSelfRepair,
  enforceLiveCrawlVerifiedAtHonesty,
  VERIFIED_AT_HONESTY_BOOT_LIMIT_DEFAULT,
  resolveIndividualAmountCeiling,
  isIndividualProfileType,
  parseIncomeValue,
  STUDENT_AID_DEMOTE_SCORE,
  enforceHamiltonTaskSelfHeal,
  enforceStaleMissingFieldResolution,
  enforceHamiltonStopRecheck,
  resolveSelfHealRequeueCap,
  SELF_HEAL_REQUEUE_CAP_DEFAULT,
  enforceAdminReinterviewSuppression,
  enforceLeadContactPlausibility,
  enforceJohnDraftPlausibility,
}
