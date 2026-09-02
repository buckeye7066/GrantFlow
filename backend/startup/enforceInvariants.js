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
import {
  AMOUNT_ADAPTER_REGISTRY_VERSION,
  findAmountAdapter,
} from '../services/sources/amountAdapters.js'
import {
  normalizePersistedMatchDecisionIntegrity,
  isBelowReviewResourceMatch,
} from '../services/matching/matchDecisionIntegrity.js'
import { buildPersistedMatchExplain } from '../services/matching/matchExplainPersistence.js'
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
 * INVARIANT: INDIVIDUAL/ORG SECTION CONFLICT (the Demo HCBS Support Persona class, found
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
      // mirror image of Demo HCBS Support Persona. Many farmers tick `occupation.farmer`
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
 * grant/application_task with a DESIGNATED-PROFILE SLUG (e.g. 'profile-demo-veteran-community')
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

/**
 * Columns `funding_opportunities` actually has here. Prod Postgres and the
 * SQLite schema have drifted before in BOTH directions (prod carries a bare
 * `url` the SQLite schema lacks — #946/#954), so a sweep that reads optional
 * evidence columns must probe rather than assume. An empty set means the probe
 * itself failed; callers treat that as "assume present" and fall back to their
 * existing per-query error handling.
 */
async function listOpportunityColumns(db) {
  try {
    if ((db?.dialect || 'sqlite') === 'postgres') {
      const rows = await db
        .prepare(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'funding_opportunities'`,
        )
        .all()
      return new Set((rows || []).map((r) => String(r.column_name)))
    }
    const cols = await db.prepare('PRAGMA table_info(funding_opportunities)').all()
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
 * Result: a senior widow (Demo Senior Medical Persona, `individual`, is_student=false) kept
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
 * A real student (Demo Tennessee STEM Student) and an aid-seeking adult are NEVER touched, so
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
 * RESOLVED EVERYWHERE (the Demo Student first-name class, owner report
 * 2026-07-27).
 *
 * Hamilton flags missing fields PER TASK (application_missing_info), but the
 * fix is PROFILE-WIDE: the owner adds first_name once. Prod carried 30+
 * unresolved "Profile is missing first name" rows across Demo Student's portal
 * tasks while basic_information.first_name = "Demo Student" sat right there —
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
    // `scanned` (not just the private `scannedProfiles`) is REQUIRED: it is the
    // only field `runEnforceInvariants` persists into
    // `system_kv enforce_invariants_last_run`, and `scanned === limit` is this
    // repo's one signature for a bound-truncated sweep (#944 / #1080). Reporting
    // nothing here persisted `scanned: 0` on every boot, so "hit the 50-profile
    // bound" and "found nothing" were byte-identical in the artifact.
    if (profiles.length === 0) return { repaired: 0, scanned: 0, scannedProfiles: 0, boundedBy: limit }
    if (!enforce) return { repaired: 0, scanned: profiles.length, scannedProfiles: profiles.length, boundedBy: limit, enforced: false }

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
    return {
      repaired: fieldsResolved,
      tasksResumed,
      scanned: profiles.length,
      scannedProfiles: profiles.length,
      boundedBy: limit,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A SYSTEM-SIDE TASK STOP THAT NO LONGER REPRODUCES IS CLEARED,
 * AND A TASK WHOSE FUNDING SOURCE WAS PURGED IS CLOSED (the Demo College Student Persona
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
      // Same contract as stale_missing_field_resolution above: `scanned` is the
      // only count the boot artifact keeps, and this sweep is bounded by
      // HAMILTON_STOP_RECHECK_LIMIT — without it, `scanned === bound` (the
      // #944/#1080 blindness signature) can never be observed for this step.
      scanned: Number(r.scannedTasks) || 0,
      scannedTasks: r.scannedTasks,
      boundedBy: limit,
      enforced: enforce,
    }
  })
}

/**
 * INVARIANT: URL-less pointer/directory/referral sources are research leads,
 * not application surfaces. The task-store creation choke point prevents new
 * rows; this bounded boot net conservatively blocks legacy tasks without
 * deleting packet, document, or submission evidence.
 *
 * ENFORCE_POINTER_TASK_RECLASS=0 keeps the scan count-only. Write and scan
 * bounds are independently configurable so a capped run reports deferred
 * repair work instead of implying the population was exhausted.
 */
export async function enforcePointerTaskReclassification(db, deps = {}) {
  return runInvariant('pointer_task_reclassification', async () => {
    let repairLegacyPointerApplicationTasks = deps.repairLegacyPointerApplicationTasks
    if (!repairLegacyPointerApplicationTasks) {
      try {
        ;({ repairLegacyPointerApplicationTasks } = await import('../services/hamilton/pointerTaskRepair.js'))
      } catch (err) {
        log.warn('pointer_task_reclassification: repair service unavailable (non-fatal)', {
          error: String(err?.message || err),
        })
        return { scanned: 0, repaired: 0, enforced: true, skipped: 'service_unavailable' }
      }
    }

    const enforced = _parseBoolEnv(process.env.ENFORCE_POINTER_TASK_RECLASS) !== false
    const limit = _boundedLimit('POINTER_TASK_RECLASS_LIMIT', 500)
    const scanLimit = _boundedLimit('POINTER_TASK_RECLASS_SCAN_LIMIT', 5000)
    const report = await repairLegacyPointerApplicationTasks(db, {
      limit,
      scanLimit,
      dryRun: !enforced,
      actorRole: 'system',
    })

    if ((report.repaired || report.would_repair) > 0) {
      log.info('pointer application-task invariant evaluated legacy research leads', {
        scanned: report.scanned,
        repaired: report.repaired,
        wouldRepair: report.would_repair,
        deferredByLimit: report.deferred_by_limit,
        enforced,
      })
    }
    return { ...report, enforced }
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
        // `resolved IS NOT TRUE` on purpose: the column is INTEGER on SQLite
        // but BOOLEAN on prod Postgres, where `resolved = 0` THROWS — this
        // catch then swallowed it, unresolvedItems stayed [], and the sweep
        // fell through to the legacy-message branch: prod re-queued tasks
        // while never resolving their missing-info rows (the task proceeded
        // AND kept showing the ask). The repo's own documented dialect trap.
        unresolvedItems = await db.prepare(
          'SELECT kind, key FROM application_missing_info WHERE task_id = ? AND resolved IS NOT TRUE',
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
 * Demo Student task, 2026-07). The producers are now fixed (school-card
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
 * INVARIANT: an APPLICATION TARGET is the award's own page, never a LISTING a
 * crowd of other awards shares (2026-08-23, the owner's Coolidge/Live Más
 * report on a real student profile).
 *
 * THE CLASS, measured in prod: "The Coolidge Scholarship" sat at ACCEPT 100
 * and "Live Más Scholarship" at ACCEPT 60 — both with application_url
 * `oregongoestocollege.org/pay/scholarships`, a scholarship LISTING page the
 * web lane read once and stamped onto every award it extracted (plus a "General
 * Manager" job posting). Clicking Apply on such a card opens a directory, not
 * the award; eligibility_text is NULL on all of them, so every downstream gate
 * honors MISSING = NEUTRAL and the rows read as fully-applyable direct grants.
 * Fleet-wide: ~500 URLs carry >= 5 distinct award titles each as their "apply"
 * link (grantwatch.com alone: 264 distinct titles on non-pointer rows).
 *
 * THE SIGNATURE IS IN THE DATA, not a keyword list: one URL shared as the
 * application target by MANY DISTINCT award identities is a hub/listing — the
 * same insight the canonical-identity u: tier already encodes ("a URL shared
 * by 2+ identities never decides identity"). Keyword detectors (isListingSurface)
 * cannot catch these: `/pay/scholarships` contains no listing token, deliberately,
 * because real award pages say "scholarship" too.
 *
 * REPAIR (the enforceNoSearchEngineApplicationTargets posture):
 *   - hub = a normalized application_url shared by >= SHARED_LISTING_MIN_TITLES
 *     (5) distinct titles. Threshold chosen from the measured distribution: the
 *     legitimate shared-host case (tn.gov/collegepays serving HOPE + Promise +
 *     Lottery) sits at 3 and is untouched.
 *   - POINTER-kind rows are exempt — a directory's URL honestly IS the listing.
 *   - TENANT-SLUG portal platforms (academicworks/NGWeb class) are exempt —
 *     those URLs are load-bearing for umbrella-application governance.
 *   - On a violating opportunity row: the URL moves to evidence_url (provenance
 *     preserved, never destroyed) and application_url goes NULL — the row loses
 *     its false apply signal, routes to resources at read time, and the
 *     existing URL-rescue net finds the award's REAL page by title+sponsor
 *     search with liveness verification.
 *   - On an EARLY-status pipeline grant carrying the same sham target: the URL
 *     columns are nulled (protected/progressed grants are never touched — the
 *     record of where a human actually applied must survive).
 *
 * OVERRIDE: ENFORCE_SHARED_LISTING_TARGETS=0 for count-only. Bounds:
 * SHARED_LISTING_MIN_TITLES (5), SHARED_LISTING_REPAIR_LIMIT (2000/boot).
 */
export async function enforceSharedListingApplicationTargets(db) {
  return runInvariant('shared_listing_application_targets', async () => {
    let TENANT_SLUG_PORTAL_PLATFORMS, isPointerKind
    try {
      ;({ TENANT_SLUG_PORTAL_PLATFORMS } = await import('../config/urlRules.js'))
      ;({ isPointerKind } = await import('../config/opportunityKindClasses.js'))
    } catch (err) {
      log.warn('shared_listing_targets: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const minTitles = Math.max(3, Number.parseInt(process.env.SHARED_LISTING_MIN_TITLES || '5', 10) || 5)
    const limit = _boundedLimit('SHARED_LISTING_REPAIR_LIMIT', 2000)
    const norm = "LOWER(RTRIM(application_url, '/'))"

    // 1. Hub discovery — a SQL aggregate, never a post-LIMIT filter (#944).
    let hubs
    try {
      hubs = await db
        .prepare(
          `SELECT ${norm} AS u, COUNT(DISTINCT LOWER(title)) AS titles
             FROM funding_opportunities
            WHERE application_url IS NOT NULL AND title IS NOT NULL
            GROUP BY ${norm}
           HAVING COUNT(DISTINCT LOWER(title)) >= ?`,
        )
        .all(minTitles)
    } catch (err) {
      log.warn('shared_listing_targets: hub query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    const isTenantPlatformUrl = (u) => {
      try {
        const host = new URL(u).hostname.toLowerCase()
        return (TENANT_SLUG_PORTAL_PLATFORMS || []).some((p) => host === p || host.endsWith(`.${p}`))
      } catch { return false }
    }
    const hubUrls = (hubs || []).map((h) => h.u).filter((u) => u && !isTenantPlatformUrl(u))
    if (hubUrls.length === 0) return { scanned: 0, repaired: 0, hubs: 0, enforced: true }

    const disabled = _parseBoolEnv(process.env.ENFORCE_SHARED_LISTING_TARGETS) === false
    let scanned = 0
    let repaired = 0
    let grantsRepaired = 0

    // 2. Opportunity rows carrying a hub URL as their apply target.
    const CHUNK = 100
    for (let i = 0; i < hubUrls.length && repaired < limit; i += CHUNK) {
      const slice = hubUrls.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      let rows
      try {
        rows = await db
          .prepare(
            `SELECT id, application_url, opportunity_kind FROM funding_opportunities
              WHERE ${norm} IN (${ph})`,
          )
          .all(...slice)
      } catch { rows = [] }
      for (const row of rows || []) {
        const kind = String(row.opportunity_kind ?? '').trim()
        if (kind && isPointerKind(kind)) continue // a directory's URL IS the listing
        scanned += 1
        if (disabled || repaired >= limit) continue
        try {
          const res = await db
            .prepare(
              `UPDATE funding_opportunities
                  SET evidence_url = COALESCE(evidence_url, application_url), application_url = NULL
                WHERE id = ?`,
            )
            .run(row.id)
          repaired += changesOf(res) || 1
        } catch (err) {
          log.warn('shared_listing_targets: opportunity repair failed (non-fatal)', { id: row.id, error: String(err?.message || err) })
        }
      }
    }

    // 3. Early-status pipeline grants carrying the same sham target. Protected
    // (user-progressed) grants are never touched.
    const grantCols = await listGrantColumns(db)
    const urlCols = ['application_url', 'url'].filter((c) => grantCols.has(c))
    if (urlCols.length > 0 && grantCols.has('status')) {
      const stPh = PURGEABLE_DISCOVERY_STATUSES.map(() => '?').join(', ')
      for (let i = 0; i < hubUrls.length; i += CHUNK) {
        const slice = hubUrls.slice(i, i + CHUNK)
        const ph = slice.map(() => '?').join(', ')
        for (const col of urlCols) {
          let rows
          try {
            rows = await db
              .prepare(
                `SELECT id FROM grants
                  WHERE LOWER(RTRIM(${col}, '/')) IN (${ph})
                    AND (status IS NULL OR status IN (${stPh}))`,
              )
              .all(...slice, ...PURGEABLE_DISCOVERY_STATUSES)
          } catch { rows = [] }
          for (const g of rows || []) {
            scanned += 1
            if (disabled) continue
            try {
              const res = await db.prepare(`UPDATE grants SET ${col} = NULL WHERE id = ?`).run(g.id)
              grantsRepaired += changesOf(res) || 1
            } catch { /* non-fatal */ }
          }
        }
      }
    }

    if (disabled) {
      if (scanned > 0) {
        log.warn('shared-listing application targets present (repair DISABLED via ENFORCE_SHARED_LISTING_TARGETS=0)', {
          scanned, hubs: hubUrls.length,
        })
      }
      return { scanned, repaired: 0, wouldRepair: scanned, hubs: hubUrls.length, enforced: false }
    }
    if (repaired > 0 || grantsRepaired > 0) {
      log.info('moved shared-listing application targets to evidence (the URL-rescue net finds the real award pages)', {
        repaired, grantsRepaired, hubs: hubUrls.length,
      })
    }
    return { scanned, repaired, grantsRepaired, hubs: hubUrls.length, enforced: true }
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
 * 271 dangling matches had accumulated; Demo Senior Accessibility Persona's matches view showed
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

/** Marker for the one-time, versioned adapter ownership reconciliation. */
export const AMOUNT_ADAPTER_RECONCILIATION_KV_KEY = 'amount_adapter_reconciliation_version'

/**
 * Reopen answerless rows that were permanently marked attempted before their
 * source gained a first-class adapter. A one-shot burn is a conclusion about
 * the strategy available at that time, not a permanent veto on future code.
 *
 * The registry version is advanced only after both answer stores are scanned
 * and all matching rows are reset. This makes a partial DB/schema failure retry
 * on the next boot instead of silently stranding the remainder. Once complete,
 * the marker makes the operation O(1) on every later boot; future adapter
 * additions converge globally by bumping AMOUNT_ADAPTER_REGISTRY_VERSION.
 */
export async function reconcileBurnedAmountAdapters(db) {
  if (!db?.prepare) return { scanned: 0, reopened: 0, skipped: 'db' }
  try {
    const marker = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(AMOUNT_ADAPTER_RECONCILIATION_KV_KEY)
    let appliedVersion = 0
    try {
      const parsed = marker?.value ? JSON.parse(marker.value) : null
      appliedVersion = Number(parsed?.version ?? parsed ?? 0) || 0
    } catch { appliedVersion = 0 }
    if (appliedVersion >= AMOUNT_ADAPTER_REGISTRY_VERSION) {
      return { scanned: 0, reopened: 0, version: appliedVersion, skipped: 'current' }
    }

    const catalogRows = await db.prepare(
      `SELECT id, title, source_url, application_url, evidence_url,
              source, source_id, record_origin
         FROM funding_opportunities
        WHERE amount_enrich_attempted_at IS NOT NULL
          AND COALESCE(amount_min, 0) <= 0
          AND COALESCE(amount_max, 0) <= 0
          AND (amount_status IS NULL OR amount_status = 'not_listed')
          AND amount_text IS NULL`,
    ).all()
    const grantRows = await db.prepare(
      `SELECT id, title, url, application_url
         FROM grants
        WHERE amount_enrich_attempted_at IS NOT NULL
          AND COALESCE(amount_min, 0) <= 0
          AND COALESCE(amount_max, 0) <= 0
          AND COALESCE(amount_requested, 0) <= 0
          AND (amount_status IS NULL OR amount_status = 'not_listed')
          AND (amount_text IS NULL OR amount_text = '')`,
    ).all()

    let reopened = 0
    for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
      if (!findAmountAdapter(row)) continue
      const wrote = await db.prepare(
        `UPDATE funding_opportunities
            SET amount_enrich_attempted_at = NULL,
                amount_enrich_attempts = 0,
                amount_enrich_env_attempts = 0,
                amount_enrich_last_reason = ?
          WHERE id = ?
            AND amount_enrich_attempted_at IS NOT NULL
            AND COALESCE(amount_min, 0) <= 0
            AND COALESCE(amount_max, 0) <= 0`,
      ).run(`adapter_registry_v${AMOUNT_ADAPTER_REGISTRY_VERSION}_reopened`, row.id)
      reopened += changesOf(wrote)
    }
    for (const row of Array.isArray(grantRows) ? grantRows : []) {
      // Adapter matchers consume the catalog URL vocabulary. Direct grants
      // store that same source identity in `grants.url`; normalize it before
      // deciding ownership so this registry revision cannot permanently skip
      // grants.gov, SAM FAL, or Federal Register rows and then advance its
      // one-shot marker.
      if (!findAmountAdapter({ ...row, source_url: row.source_url || row.url })) continue
      const wrote = await db.prepare(
        `UPDATE grants
            SET amount_enrich_attempted_at = NULL,
                amount_enrich_attempts = 0,
                amount_enrich_env_attempts = 0,
                amount_enrich_last_reason = ?
          WHERE id = ?
            AND amount_enrich_attempted_at IS NOT NULL
            AND COALESCE(amount_min, 0) <= 0
            AND COALESCE(amount_max, 0) <= 0
            AND COALESCE(amount_requested, 0) <= 0`,
      ).run(`adapter_registry_v${AMOUNT_ADAPTER_REGISTRY_VERSION}_reopened`, row.id)
      reopened += changesOf(wrote)
    }

    const now = new Date().toISOString()
    const value = JSON.stringify({
      version: AMOUNT_ADAPTER_REGISTRY_VERSION,
      reconciled_at: now,
      scanned: (catalogRows?.length ?? 0) + (grantRows?.length ?? 0),
      reopened,
    })
    const updated = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
      .run(value, now, AMOUNT_ADAPTER_RECONCILIATION_KV_KEY)
    if (!changesOf(updated)) {
      try {
        await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)')
          .run(AMOUNT_ADAPTER_RECONCILIATION_KV_KEY, value, now)
      } catch {
        // Another instance may have inserted the marker after our UPDATE.
        await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?')
          .run(value, now, AMOUNT_ADAPTER_RECONCILIATION_KV_KEY)
      }
    }
    if (reopened > 0) {
      log.info('amount adapter registry advanced — reopened legacy burned rows', {
        version: AMOUNT_ADAPTER_REGISTRY_VERSION,
        reopened,
      })
    }
    return {
      scanned: (catalogRows?.length ?? 0) + (grantRows?.length ?? 0),
      reopened,
      version: AMOUNT_ADAPTER_REGISTRY_VERSION,
    }
  } catch (err) {
    log.warn('amount adapter reconciliation deferred (non-fatal)', { error: String(err?.message || err) })
    return { scanned: 0, reopened: 0, skipped: 'query', error: String(err?.message || err) }
  }
}

export async function enforceAmountEnrichment(db, deps = {}) {
  return runInvariant('amount_enrichment', async () => {
    const disabled = _parseBoolEnv(process.env.ENFORCE_AMOUNT_ENRICHMENT) === false
    if (!disabled) await reconcileBurnedAmountAdapters(db)
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
        `SELECT g.id, g.title, g.url, g.application_url, COALESCE(g.amount_enrich_attempts, 0) AS attempts,
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
          {
            source_url: g.url ?? g.application_url ?? null,
            // Listing-page adapters (for example university scholarship
            // indexes) select the named award from a multi-award page. Omitting
            // the grant title makes a valid adapter look like a permanent
            // listing_title_not_found and can burn the one-shot row.
            title: g.title ?? null,
          },
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
// WRONG-CONTENT class (2026-08-15): the URL ANSWERS but the answer can never
// state an award — a JS shell (`thin_page`) or a 200 whose body failed the
// read (`fetch_failed:200`, e.g. a row pointing at a PDF report). Measured in
// prod: "Tennessee Reconnect" pointed at a college's alumna-SPOTLIGHT article,
// "FTA Grant Programs" at a GAO PDF — real programs whose stored URL is simply
// not the program's page, permanently red in the census's unanswered_unreadable
// bucket with no lane able to reach them (source_url_self_repair repairs
// REGISTRY sources; the dead-URL class above requires the URL to be DEAD).
// These rows go straight to the identity search: the alive-recovery shortcut
// must NOT apply (their URL being alive is the problem, and un-burning it for
// a re-read would re-burn nightly — a tug-of-war by construction).
const UNREADABLE_URL_REASON_PREDICATE = (alias) =>
  `(COALESCE(${alias}.amount_enrich_last_reason, '') LIKE 'thin_page%'
    OR COALESCE(${alias}.amount_enrich_last_reason, '') LIKE 'fetch_failed:200%')`

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
                  COALESCE(g.url, g.application_url) AS dead_url,
                  CASE WHEN ${DEAD_URL_REASON_PREDICATE('g')} THEN 'dead' ELSE 'unreadable' END AS klass
             FROM grants g
            WHERE g.status IN (${statuses})
              AND g.funding_opportunity_id IS NULL
              AND ${VAL} = 0
              AND (g.amount_status IS NULL OR g.amount_status = 'not_listed')
              AND (g.amount_text IS NULL OR g.amount_text = '')
              AND g.amount_enrich_attempted_at IS NOT NULL
              AND (${DEAD_URL_REASON_PREDICATE('g')} OR ${UNREADABLE_URL_REASON_PREDICATE('g')})
              AND COALESCE(g.url, g.application_url, '') <> ''
              AND ${NON_SYNTH}
            LIMIT ?`,
        )
        .all(LIMIT)
      // audit:allow dynamic-sql — statuses/predicates are frozen module constants.
      const catalogRows = await db
        .prepare(
          `SELECT 'fo' AS lane, fo.id, fo.title, fo.sponsor,
                  COALESCE(fo.source_url, fo.application_url) AS dead_url,
                  CASE WHEN ${DEAD_URL_REASON_PREDICATE('fo')} THEN 'dead' ELSE 'unreadable' END AS klass
             FROM funding_opportunities fo
            WHERE fo.is_active
              AND COALESCE(fo.amount_min, 0) <= 0
              AND COALESCE(fo.amount_max, 0) <= 0
              AND (fo.amount_status IS NULL OR fo.amount_status = 'not_listed')
              AND (fo.amount_text IS NULL OR fo.amount_text = '')
              AND LOWER(COALESCE(fo.opportunity_kind, '')) NOT IN ('directory', 'benefit')
              AND fo.amount_enrich_attempted_at IS NOT NULL
              AND (${DEAD_URL_REASON_PREDICATE('fo')} OR ${UNREADABLE_URL_REASON_PREDICATE('fo')})
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
        // 1. RE-PROVE deadness — DEAD class only. 'skipped' covers an
        //    unresolvable domain (the probe's own SSRF/DNS guard) — dead for
        //    our purposes; ok/redirect means the URL answers today and needs
        //    no repair, only a re-read. The UNREADABLE class must NEVER take
        //    this shortcut: its URL being alive is the very problem (a JS
        //    shell / wrong-content page answers every probe), and an un-burn
        //    here would re-read → re-burn nightly, a tug-of-war by
        //    construction. Those rows go straight to the identity search.
        if (cand.klass !== 'unreadable') {
          const probe = await checkUrlImpl(cand.dead_url, { timeoutMs: 8000 })
          if (probe && (probe.status === 'ok' || probe.status === 'redirect')) {
            await db.prepare(unburnSqlFor(cand.lane)).run('dead_url_recovered_alive', cand.id)
            recoveredAlive++
            delete state.entries[stateKey]
            continue
          }
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
          if (cand.klass === 'unreadable') {
            // The identity search found the SAME unreadable page: the official
            // page IS this page and it cannot state an award. A real dead end
            // — the attempt is spent (bounded by MAX_ATTEMPTS → exhausted) and
            // the burn stays, so the row can never re-enter a re-read loop.
            notFound++
            continue
          }
          await db.prepare(unburnSqlFor(cand.lane)).run('dead_url_recovered_alive', cand.id)
          recoveredAlive++
          delete state.entries[stateKey]
          continue
        }
        const wrote = await db.prepare(resetSqlFor(cand.lane)).run(found.url, cand.klass === 'unreadable' ? 'unreadable_url_repaired' : 'dead_url_repaired', cand.id)
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

// Application-task statuses that are already terminal — shared by every
// pipeline purge net below (pipeline_precision, profession_eligibility,
// non_grant_notice_pipeline) so "cancel the open tasks" means one thing.
const TERMINAL_TASK_STATUSES = Object.freeze([
  'submitted', 'completed', 'complete', 'done',
  'cancelled', 'canceled', 'archived', 'rejected', 'closed',
])

/**
 * INVARIANT: every pipeline row MEETS A DECLARED NEED, comes from a REAL,
 * RELATABLE source, and is one the profile QUALIFIES for (owner order
 * 2026-08-21, verbatim: "no funding source that does not meet the needs of the
 * profile, come from real relatable sources, that the profile qualifies for,
 * will make it to that profile's pipeline. All such funding sources that are
 * currently on a pipeline will be removed.").
 *
 * The per-call gate is `opportunityMatcher.admitToPipeline` (source allowlist,
 * tombstones, junk chain, NEED_COVERAGE, decision engine — which carries the
 * applicant-type, stage-of-life, geography, eligibility and aid-preference
 * gates). This is the NET over rows every pre-gate writer left behind. It runs
 * Robert's four-gate verifier (services/robert/robertPipelineAudit.js —
 * RELATABLE / QUALIFIES / COVERS_NEED / REAL) over EVERY profile's pipeline on
 * every boot, with ONE difference from Robert's manual tool: the REAL gate is
 * its DETERMINISTIC half only (title-stated sunset, long-past deadline, no URL).
 * A boot never spends minutes on HEAD requests, and a funder's bad afternoon
 * must never read as "dead" (the `unverifiable` rule).
 *
 * REMOVAL / RE-LABEL (the owner's two halves):
 *   - An early/discovery-status row that fails a gate is TOMBSTONED
 *     (pipelineDismissals.recordDismissal — sticky, reversible by a manual
 *     re-add) and DELETED; its open application tasks are CANCELLED.
 *   - A PROTECTED row (user-progressed status, protected MTSU/portal name,
 *     recorded award) is RE-LABELED, never deleted: `eligibility_status =
 *     'ineligible'` and the failing gate+reason appended to
 *     `ineligibility_reasons` (columns permitting).
 *   - The Sasquatch PromoPilot profile is skipped (standing owner instruction).
 *
 * ACCOUNTING IS ASSERTED: `scanned === kept + removed + relabeled + failed`
 * throws (→ ok:false) if it does not hold. Counts are reported PER GATE and
 * PER REASON, plus the two neutral-silence classes of the need gate
 * (`needNeutralProfile` — the profile declares no needs; `needNeutralRow` —
 * the row states no need vocabulary), so a "kept" row can never hide an
 * unreadable one.
 *
 * NO DRY RUN and no disable switch, by owner order (2026-08-13, permanent).
 * Bound: PIPELINE_PRECISION_LIMIT (2000) limits WRITES per boot, never
 * discovery — a truncated boot is reported (`truncated: true`).
 */
export async function enforcePipelinePrecision(db) {
  return runInvariant('pipeline_precision', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('profile_id') || !grantCols.has('title') || !grantCols.has('status')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    const oppCols = await listOpportunityColumns(db)
    // Robert's row loader joins the catalog for the eligibility evidence the
    // gates need. Without these columns the gates would see bare titles and
    // report "kept" for everything — the exact blind-sweep class
    // (pipelineEligibilitySweep, 2026-08-21). Say so instead.
    const REQUIRED_OPP_COLS = ['entity_types_allowed', 'need_types_supported', 'categories', 'opportunity_kind', 'source_url']
    const missingOpp = REQUIRED_OPP_COLS.filter((c) => !oppCols.has(c))
    if (missingOpp.length > 0) {
      log.warn('pipeline_precision: funding_opportunities lacks gate evidence columns — sweep skipped, NOT green', { missing: missingOpp })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema', missingColumns: missingOpp }
    }

    let audit
    try {
      audit = await import('../services/robert/robertPipelineAudit.js')
    } catch (err) {
      log.warn('pipeline_precision: verifier unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const { loadProfileFacts, loadPipelineRows, gateRelatable, gateQualifies, gateCoversNeed, gateRealOffline, GATES } = audit
    let cancelApplicationTask = null
    let recordDismissalFn = null
    try { ({ cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')) } catch { cancelApplicationTask = null }
    try { ({ recordDismissal: recordDismissalFn } = await import('../services/pipelineDismissals.js')) } catch { recordDismissalFn = null }

    const limit = _boundedLimit('PIPELINE_PRECISION_LIMIT', 2000)
    const hasAwarded = grantCols.has('amount_awarded')
    const hasEligStatus = grantCols.has('eligibility_status')
    const hasIneligReasons = grantCols.has('ineligibility_reasons')
    const now = new Date()

    let profileIds = []
    try {
      const rows = await db
        .prepare("SELECT id FROM profiles WHERE (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted')")
        .all()
      profileIds = (rows || []).map((r) => String(r.id))
    } catch {
      try {
        const rows = await db.prepare('SELECT id FROM profiles').all()
        profileIds = (rows || []).map((r) => String(r.id))
      } catch { profileIds = [] }
    }

    let hasTasks = false
    try { await db.prepare('SELECT id FROM application_tasks LIMIT 1').get(); hasTasks = true } catch { hasTasks = false }

    const counts = {
      scanned: 0, kept: 0, removed: 0, relabeled: 0, failed: 0, tasksCancelled: 0, matchesRemoved: 0,
      protectedProfilesSkipped: 0, needNeutralProfile: 0, needNeutralRow: 0,
      harvestFirst: 0, truncated: false, loadFailures: 0, firstLoadError: null,
    }
    const byGate = { [GATES.RELATABLE]: 0, [GATES.QUALIFIES]: 0, [GATES.COVERS_NEED]: 0, [GATES.REAL]: 0 }
    const byReason = {}
    const affectedProfiles = new Set()
    const examples = []
    let writes = 0

    // Robert's row loader does not select amount_awarded (the column is absent
    // on some test schemas); read it per profile only when it exists.
    const awardedByGrant = async (profileId) => {
      if (!hasAwarded) return new Map()
      try {
        const rows = await db.prepare('SELECT id, amount_awarded FROM grants WHERE profile_id = ?').all(profileId)
        return new Map((rows || []).map((r) => [String(r.id), Number(r.amount_awarded) || 0]))
      } catch { return new Map() }
    }
    // Pipeline-precision-specific protected statuses: irreversible outcomes only.
    const PIPELINE_PRECISION_PROTECTED = new Set([
      'submitted', 'awarded', 'declined', 'follow_up', 'in_review', 'under_review', 'archived',
    ])
    const isProtectedRow = (row, awarded) => {
      const status = row.grant_status === null || row.grant_status === undefined ? null : String(row.grant_status).toLowerCase()
      if (status && PIPELINE_PRECISION_PROTECTED.has(status)) return true
      if ((awarded.get(String(row.grant_id)) || 0) > 0) return true
      return false
    }

    for (const profileId of profileIds) {
      let facts
      try { facts = await loadProfileFacts(db, profileId) } catch (err) {
        log.warn('pipeline_precision: profile facts failed (non-fatal)', { profileId, error: String(err?.message || err) })
        continue
      }
      if (facts.protectedProfile) { counts.protectedProfilesSkipped += 1; continue }
      let rows
      try { rows = await loadPipelineRows(db, profileId) } catch (err) {
        counts.loadFailures += 1
        if (!counts.firstLoadError) counts.firstLoadError = String(err?.message || err)
        log.warn('pipeline_precision: pipeline rows failed', { profileId, error: String(err?.message || err) })
        continue
      }
      if (!rows || rows.length === 0) continue
      const awarded = await awardedByGrant(profileId)
      const profileDeclaresNoNeeds = !Array.isArray(facts.needs) || facts.needs.length === 0

      for (const row of rows) {
        counts.scanned += 1
        let verdict = null
        let failedGate = null
        try {
          verdict = gateRelatable(row, { now })
          if (!verdict.pass) failedGate = GATES.RELATABLE
          if (!failedGate) {
            verdict = gateQualifies(row, facts)
            if (!verdict.pass) failedGate = GATES.QUALIFIES
          }
          if (!failedGate) {
            verdict = gateCoversNeed(row, facts)
            if (!verdict.pass) failedGate = GATES.COVERS_NEED
            else if (profileDeclaresNoNeeds) counts.needNeutralProfile += 1
            else if (verdict?.evidence?.detail === 'opportunity_states_no_need_vocabulary') counts.needNeutralRow += 1
          }
          if (!failedGate) {
            const real = gateRealOffline(row, { now })
            if (real && !real.pass) { verdict = real; failedGate = GATES.REAL }
          }
        } catch (err) {
          counts.failed += 1
          log.warn('pipeline_precision: gate threw (non-fatal)', { grant: row.grant_id, error: String(err?.message || err) })
          continue
        }
        if (!failedGate) { counts.kept += 1; continue }

        const reasonKey = `${failedGate}:${verdict?.reason ?? 'failed'}`
        const detail = verdict?.evidence?.detail ?? verdict?.evidence?.gate ?? null
        if (verdict?.harvest_first) counts.harvestFirst += 1

        if (writes >= limit) {
          counts.truncated = true
          counts.kept += 1 // still in the pipeline this boot — honestly counted as such
          continue
        }

        if (isProtectedRow(row, awarded)) {
          try {
            if (hasEligStatus && hasIneligReasons) {
              let existing = []
              try {
                const cur = await db.prepare('SELECT ineligibility_reasons FROM grants WHERE id = ?').get(row.grant_id)
                const raw = cur?.ineligibility_reasons
                existing = typeof raw === 'string' ? JSON.parse(raw || '[]') : (Array.isArray(raw) ? raw : [])
              } catch { existing = [] }
              if (!Array.isArray(existing)) existing = []
              const tag = `pipeline_precision:${reasonKey}${detail ? `:${detail}` : ''}`
              if (!existing.includes(tag)) existing.push(tag)
              await db
                .prepare('UPDATE grants SET eligibility_status = ?, ineligibility_reasons = ? WHERE id = ?')
                .run('ineligible', JSON.stringify(existing), row.grant_id)
            } else if (hasEligStatus) {
              await db.prepare('UPDATE grants SET eligibility_status = ? WHERE id = ?').run('ineligible', row.grant_id)
            } else {
              throw new Error('grants.eligibility_status column absent — protected row cannot be re-labeled')
            }
            writes += 1
            counts.relabeled += 1
            byGate[failedGate] = (byGate[failedGate] || 0) + 1
            byReason[reasonKey] = (byReason[reasonKey] || 0) + 1
            affectedProfiles.add(profileId)
            // Cancel any non-terminal Hamilton tasks backing this protected-but-failing row.
            if (hasTasks && cancelApplicationTask) {
              try {
                const ph = TERMINAL_TASK_STATUSES.map(() => '?').join(', ')
                const taskRows = await db
                  .prepare(`SELECT id FROM application_tasks WHERE profile_id = ? AND grant_id = ? AND (status IS NULL OR status NOT IN (${ph}))`)
                  .all(profileId, row.grant_id, ...TERMINAL_TASK_STATUSES)
                for (const t of taskRows || []) {
                  try {
                    await cancelApplicationTask(db, t.id, { actorRole: 'system', reason: `Pipeline precision — ${reasonKey}` })
                    counts.tasksCancelled += 1
                  } catch (err) {
                    log.warn('pipeline_precision: task cancel failed (non-fatal)', { task: t.id, error: String(err?.message || err) })
                  }
                }
              } catch { /* best-effort across schema drift */ }
            }
            // Suppress resurrecting matches so Hamilton does not re-pick this source.
            try {
              if (row.funding_opportunity_id) {
                const del = await db
                  .prepare('DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?')
                  .run(profileId, row.funding_opportunity_id)
                counts.matchesRemoved += changesOf(del) || 0
              }
            } catch { /* match table may be absent */ }
          } catch (err) {
            counts.failed += 1
            log.warn('pipeline_precision: re-label failed (non-fatal)', { grant: row.grant_id, error: String(err?.message || err) })
          }
          continue
        }

        // Early/discovery row: cancel open tasks, tombstone, delete.
        try {
          if (hasTasks && cancelApplicationTask) {
            let taskRows = []
            try {
              const ph = TERMINAL_TASK_STATUSES.map(() => '?').join(', ')
              taskRows = await db
                .prepare(`SELECT id FROM application_tasks WHERE profile_id = ? AND grant_id = ? AND (status IS NULL OR status NOT IN (${ph}))`)
                .all(profileId, row.grant_id, ...TERMINAL_TASK_STATUSES)
            } catch { taskRows = [] }
            for (const t of taskRows || []) {
              try {
                await cancelApplicationTask(db, t.id, { actorRole: 'system', reason: `Pipeline precision — ${reasonKey}` })
                counts.tasksCancelled += 1
              } catch (err) {
                log.warn('pipeline_precision: task cancel failed (non-fatal)', { task: t.id, error: String(err?.message || err) })
              }
            }
          }
          if (recordDismissalFn) {
            await recordDismissalFn(db, {
              profileId,
              userId: 'system_pipeline_precision',
              reason: `pipeline_precision:${reasonKey}`,
              grantRow: {
                id: row.grant_id,
                title: row.title,
                funder: row.sponsor,
                deadline: row.deadline,
                application_url: row.application_url,
                source_url: row.source_url,
                funding_opportunity_id: row.funding_opportunity_id,
              },
            })
          }
          const res = await db.prepare('DELETE FROM grants WHERE id = ?').run(row.grant_id)
          if (changesOf(res) < 1) throw new Error('delete affected 0 rows')
          writes += 1
          counts.removed += 1
          byGate[failedGate] = (byGate[failedGate] || 0) + 1
          byReason[reasonKey] = (byReason[reasonKey] || 0) + 1
          affectedProfiles.add(profileId)
          if (examples.length < 5) examples.push(`${row.title} [${reasonKey}]`)
          // Also remove any persisted surfaced match rows for this pair.
          try {
            if (row.funding_opportunity_id) {
              const del = await db
                .prepare('DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?')
                .run(profileId, row.funding_opportunity_id)
              counts.matchesRemoved += changesOf(del) || 0
            }
          } catch { /* optional across schema drift */ }
        } catch (err) {
          counts.failed += 1
          log.warn('pipeline_precision: removal failed (non-fatal)', { grant: row.grant_id, error: String(err?.message || err) })
        }
      }
    }

    const accounted = counts.kept + counts.removed + counts.relabeled + counts.failed
    if (accounted !== counts.scanned) {
      throw new Error(
        `pipeline_precision accounting broken: scanned=${counts.scanned} but kept+removed+relabeled+failed=${accounted}`,
      )
    }
    if (counts.loadFailures > 0 && counts.scanned === 0) {
      // Every profile's row load threw — a broken SELECT reading as a clean
      // "scanned 0" is the exact blind-sweep class this net exists to end.
      throw new Error(
        `pipeline_precision could not load any pipeline rows (${counts.loadFailures} profile loads failed): ${counts.firstLoadError}`,
      )
    }
    if (counts.scanned === 0) {
      log.warn('pipeline_precision: no pipeline rows scanned', { profiles: profileIds.length })
    } else if (counts.removed === 0 && counts.relabeled === 0) {
      log.warn('pipeline_precision: removed nothing', { scanned: counts.scanned, kept: counts.kept, profiles: profileIds.length })
    } else {
      log.info('pipeline_precision: converged profile pipelines', {
        ...counts, byGate, byReason, profilesAffected: affectedProfiles.size, examples, timestamp: new Date().toISOString(),
      })
    }
    // Persist a lightweight last-run summary for deployment visibility on every run.
    try {
      await db.prepare(
        `INSERT INTO system_kv (key, value, updated_at)
         VALUES ('pipeline_precision_last_run', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(JSON.stringify({
        scanned: counts.scanned,
        removed: counts.removed,
        relabeled: counts.relabeled,
        tasksCancelled: counts.tasksCancelled,
        matchesRemoved: counts.matchesRemoved,
        failed: counts.failed,
        profilesAffected: affectedProfiles.size,
        byGate,
        truncated: counts.truncated,
        timestamp: new Date().toISOString(),
      }), new Date().toISOString())
    } catch { /* kv table may not exist on minimal schemas */ }
    return {
      ...counts,
      repaired: counts.removed + counts.relabeled,
      byGate,
      byReason,
      profiles: profileIds.length,
      profilesAffected: affectedProfiles.size,
      enforced: true,
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
    let detectServiceCommitmentLock, assessServiceCommitmentEligibility, hasDeclaredMilitaryAffiliation
    let cancelApplicationTask = null
    let recordDismissalFn = null
    try {
      ;({
        professionSignalTextFromSections, resolveProfileProfessions,
        opportunityLockText, assessProfessionEligibility,
      } = await import('../services/eligibility/professionEligibility.js'))
      ;({
        detectServiceCommitmentLock, assessServiceCommitmentEligibility, hasDeclaredMilitaryAffiliation,
      } = await import('../services/eligibility/serviceCommitmentEligibility.js'))
    } catch (err) {
      log.warn('profession_eligibility: predicate unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    try { ({ cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')) } catch { cancelApplicationTask = null }
    try { ({ recordDismissal: recordDismissalFn } = await import('../services/pipelineDismissals.js')) } catch { recordDismissalFn = null }

    const hasFunder = grantCols.has('funder')
    const hasAwarded = grantCols.has('amount_awarded')
    const hasEligStatus = grantCols.has('eligibility_status')

    const hasOppLink = grantCols.has('funding_opportunity_id')
    const rows = await db
      .prepare(
        `SELECT id, profile_id, title, ${hasFunder ? 'funder' : 'NULL AS funder'}, status${hasAwarded ? ', amount_awarded' : ''}${hasOppLink ? ', funding_opportunity_id' : ''}
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
    async function sectionsByKeyFor(profileId) {
      const sectionsByKey = {}
      const secs = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
      for (const s of secs || []) sectionsByKey[s.section_key] = s.data
      return sectionsByKey
    }
    async function professionsFor(profileId) {
      if (typeof resolveSignals === 'function') {
        return resolveProfileProfessions(await resolveSignals(profileId))
      }
      let sectionsByKey = {}
      try { sectionsByKey = await sectionsByKeyFor(profileId) } catch { sectionsByKey = {} }
      return resolveProfileProfessions(professionSignalTextFromSections(sectionsByKey))
    }
    // Military declaration for the service-commitment lock (owner ruling
    // 2026-08-23: ROTC/academy/enlistment awards REQUIRE a positive declared
    // affiliation). Returns true/false from a successful sections read; null
    // when the profile could not be read — an unreadable profile adjudicates
    // NOTHING (MISSING = NEUTRAL applies to the READ, not the declaration).
    async function militaryDeclaredFor(profileId) {
      try {
        return hasDeclaredMilitaryAffiliation(await sectionsByKeyFor(profileId))
      } catch {
        return null
      }
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
      // Lazy per-profile military read — resolved only when a grant carries a
      // service-commitment lock, so profiles with none pay nothing.
      let militaryDeclared

      for (const g of grants) {
        const itemText = opportunityLockText(g)
        let verdict = null
        // Profession lock: fires only when the profile's field is recognised
        // (the both-sides rule — unknown field never rejects).
        if (professions && professions.size > 0) {
          const pv = assessProfessionEligibility({ itemText, professions })
          if (pv.ineligible) verdict = pv
        }
        // Service-commitment lock (ROTC / academies / enlistment): a POSITIVE
        // declared military affiliation is required — owner ruling 2026-08-23.
        if (!verdict && detectServiceCommitmentLock(itemText)) {
          if (militaryDeclared === undefined) militaryDeclared = await militaryDeclaredFor(profileId)
          if (militaryDeclared === false) {
            const sv = assessServiceCommitmentEligibility({ itemText, declared: false })
            if (sv.ineligible) verdict = sv
          }
        }
        if (!verdict) continue
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
        // 3) The stored MATCH row for the same pair makes the identical false
        // claim ("you can apply to this") on the Funding Sources view and is
        // replayed verbatim by the persisted-truth policy — remove it with the
        // pipeline repair so the two surfaces cannot disagree.
        if (hasOppLink && g.funding_opportunity_id) {
          try {
            await db.prepare('DELETE FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?')
              .run(profileId, g.funding_opportunity_id)
          } catch { /* match table may be absent in minimal test DBs */ }
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
        // The decision write is UNCONDITIONAL, not COALESCE: every candidate
        // here had match_score IS NULL, so any pre-existing match_decision is a
        // cosmetic migration stamp (063/064/0056/0057 wrote 'review' over
        // never-scored rows), never an engine or human verdict — keeping it via
        // COALESCE froze a stamped 'review' forever even when the fresh
        // canonical decision is REJECT (the prod "general funding support"
        // class, 2026-08-04). matched_needs is repaired ONLY when it carries
        // exactly that migration stamp; any other stored value is left alone.
        await db
          .prepare(
            `UPDATE grants SET match_score = ?, match_decision = ?,
                    matcher_version = COALESCE(matcher_version, 'score-backfill'),
                    matched_needs = CASE WHEN matched_needs = '["general funding support"]' THEN ? ELSE matched_needs END
             WHERE id = ?`,
          )
          .run(score, String(decision?.decision ?? 'REVIEW'), JSON.stringify(decision?.matchedNeeds ?? []), g.id)
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
/**
 * INVARIANT: EVERY SAVED PORTAL SESSION KNOWS WHEN A HUMAN AUTHENTICATED IT
 * (2026-08-01, the "durable for most portals" honesty class).
 *
 * `portalSessionLifetime` measures a host's real session lifetime as
 *   age = observedAt − session_established_at
 * where `session_established_at` is when a HUMAN last signed in. A row without
 * it is STRUCTURALLY INVISIBLE to the ledger: `recordSessionObservation`
 * refuses `no_established_at` rather than invent a clock, so that host can
 * never accumulate evidence no matter how often it is probed — the same
 * "unreachable by construction" shape as a grant with a NULL
 * `funding_opportunity_id`.
 *
 * Every row in prod is in exactly that state (5 valid sessions, 2026-08-01),
 * because the column that used to look like the answer is not one:
 * `hamilton_saved_sessions.established_at` is REWRITTEN to now() by
 * `importSession` on every keep-alive cookie refresh. Session 9d9f6b55 read
 * `created_at 2026-07-21T02:55` against `established_at 2026-08-01T03:23` —
 * 11 days of drift from 11 refreshes. Reading lifetimes off that column would
 * report every host's sessions as hours old and permanently healthy.
 *
 * REPAIR: stamp `metadata_json.session_established_at` from the row's OWN
 * `created_at` (the moment the row — and therefore the first human capture —
 * came into being) wherever it is missing. NEVER invents a time and never
 * overwrites an existing stamp: a row whose established time is genuinely
 * unknowable (no created_at) is left alone and counted as `unstamped`, staying
 * visible rather than being fabricated into the ledger.
 *
 * Write-side first line of defense: `importSession` pins
 * `session_established_at` at capture and carries it across refreshes
 * (only a real human authentication resets it).
 *
 * Bounded (`PORTAL_SESSION_STAMP_LIMIT`, default 500) and idempotent — a
 * stamped row leaves the candidate set. `ENFORCE_PORTAL_SESSION_LIFETIME=0`
 * makes it count-only.
 */
export async function enforcePortalSessionLifetimeStamp(db) {
  return runInvariant('portal_session_lifetime_stamp', async () => {
    const limit = Math.max(1, Number(process.env.PORTAL_SESSION_STAMP_LIMIT) || 500)
    const countOnly = String(process.env.ENFORCE_PORTAL_SESSION_LIFETIME || '') === '0'

    let rows = []
    try {
      rows = await db.prepare(
        `SELECT id, created_at, established_at, metadata_json
           FROM hamilton_saved_sessions
          ORDER BY created_at DESC`,
      ).all()
    } catch {
      // Table absent (fresh/foreign deploy) — nothing to enforce.
      return { scanned: 0, repaired: 0, skipped: 'schema' }
    }

    const candidates = []
    for (const row of rows || []) {
      let meta = row?.metadata_json
      if (typeof meta === 'string') { try { meta = JSON.parse(meta) } catch { meta = {} } }
      if (!meta || typeof meta !== 'object') meta = {}
      if (meta.session_established_at) continue // already stamped — never overwrite
      candidates.push({ id: row.id, createdAt: row.created_at, meta })
    }

    let repaired = 0
    let unstamped = 0
    if (countOnly) {
      for (const c of candidates) {
        if (c.createdAt) repaired += 1; else unstamped += 1
      }
      return { scanned: candidates.length, repaired: 0, wouldRepair: repaired, unstamped, countOnly: true }
    }

    const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
    for (const c of candidates.slice(0, limit)) {
      if (!c.createdAt) { unstamped += 1; continue } // never invent a time
      const stamped = { ...c.meta, session_established_at: new Date(c.createdAt).toISOString() }
      try {
        await db.prepare(
          `UPDATE hamilton_saved_sessions SET metadata_json = ?, updated_at = ${nowFn} WHERE id = ?`,
        ).run(JSON.stringify(stamped), c.id)
        repaired += 1
      } catch { /* per-row best effort; a failure leaves the row a candidate */ }
    }
    return { scanned: candidates.length, repaired, unstamped }
  })
}

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

/* ────────────────────────────────────────────────────────────────────────────
 * GEOGRAPHIC + AWARD-SCALE SCOPE OF A SURFACED MATCH  (2026-08-01, the GeneMac
 * report: "the Funding Sources list shows the SAME sources that appear for
 * unrelated profiles, and NO legitimate matches for what the profile is")
 *
 * Three producer-side gates now exist (services/matchEngine.js makeDecision +
 * services/crawlerOsPersistenceCore.js osOppToLiveRow). They stop NEW bad rows.
 * The owner sees the rows that are ALREADY THERE, and the match store is a
 * ROLLING SNAPSHOT rebuilt per run — so without these sweeps the fix would only
 * take effect for a profile after its next crawl, and the catalog-side geo
 * damage would never be repaired at all. These three sweep EVERY profile.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Per-boot bound for the declared-geo-scope catalog repair. */
const DECLARED_GEO_SCOPE_LIMIT_DEFAULT = 500
/** Per-boot bound for each match-store scope purge. */
const MATCH_SCOPE_PURGE_LIMIT_DEFAULT = 2000

function _boundedLimit(envName, fallback) {
  const v = Number.parseInt(process.env[envName] || '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * INVARIANT: a catalog row that NAMES ITS OWN STATE is not nationwide.
 *
 * County/city locator rows are minted per-place with the place only in the title
 * ("Polk County, TN — Local assistance programs near you (findhelp)") and no
 * geography columns, so they persist `state = NULL, is_national = 1,
 * geo_county = NULL, geo_zip = NULL`. The geo gate compares `opp.state` and
 * short-circuits on empty; the geo TIER reads `is_national` and awards the full
 * nationwide subscale. Every profile is therefore "geographically eligible" for
 * every other profile's county. Prod 2026-08-01: 89 active rows in this shape,
 * 373 match rows across 37 of 39 profiles, 213 provably out-of-state.
 *
 * The repair reads the state the row already declares about itself — no new
 * information, no guessing. Touches ONLY rows with NO stored state AND
 * is_national truthy, so it can never override a scope the source supplied, and
 * a repaired row leaves the candidate set (idempotent). Writer-side twin:
 * `correctedGeoScopeFromTitle` in osOppToLiveRow.
 *
 * Bounded by DECLARED_GEO_SCOPE_LIMIT (500/boot); ENFORCE_DECLARED_GEO_SCOPE=0
 * for count-only.
 */
export async function enforceDeclaredGeoScope(db) {
  return runInvariant('declared_geo_scope', async () => {
    let correctedGeoScopeFromTitle, DECLARED_STATE_TITLE_LIKE_PATTERNS
    try {
      ;({ correctedGeoScopeFromTitle, DECLARED_STATE_TITLE_LIKE_PATTERNS } = await import(
        '../config/opportunityJurisdiction.js'
      ))
    } catch (err) {
      log.warn('declared_geo_scope: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('DECLARED_GEO_SCOPE_LIMIT', DECLARED_GEO_SCOPE_LIMIT_DEFAULT)

    // The title-shape narrowing is a SQL PREDICATE, never a post-LIMIT JS
    // filter: an unscoped catalog holds thousands of state-less rows, and
    // filtering after the LIMIT would let rows that declare nothing permanently
    // starve the ones that do (the #944 "green while doing nothing" class).
    const likeClause = DECLARED_STATE_TITLE_LIKE_PATTERNS.map(() => 'title LIKE ?').join(' OR ')
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT id, title, state, is_national
             FROM funding_opportunities
            WHERE (state IS NULL OR TRIM(state) = '')
              AND title IS NOT NULL
              AND (${likeClause})
            LIMIT ?`,
        )
        .all(...DECLARED_STATE_TITLE_LIKE_PATTERNS, limit)
    } catch (err) {
      log.warn('declared_geo_scope: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const fixes = []
    for (const row of rows || []) {
      const corrected = correctedGeoScopeFromTitle(row)
      if (corrected) fixes.push({ id: row.id, ...corrected })
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_DECLARED_GEO_SCOPE) === false
    if (disabled) {
      if (fixes.length > 0) {
        log.warn('catalog rows declare a state in their title but are stored NATIONAL (repair DISABLED via ENFORCE_DECLARED_GEO_SCOPE=0)', {
          wouldRepair: fixes.length,
          scanned: rows?.length || 0,
        })
      }
      return { scanned: rows?.length || 0, repaired: 0, wouldRepair: fixes.length, enforced: false }
    }
    if (fixes.length === 0) return { scanned: rows?.length || 0, repaired: 0, enforced: true }

    let repaired = 0
    for (const fix of fixes) {
      const res = await db
        .prepare('UPDATE funding_opportunities SET state = ?, is_national = 0 WHERE id = ?')
        .run(fix.state, fix.id)
      repaired += changesOf(res) || 1
    }
    log.info('re-scoped catalog rows from their own declared state (were stored as nationwide)', {
      repaired,
      scanned: rows?.length || 0,
    })
    return { scanned: rows?.length || 0, repaired, enforced: true }
  })
}

/**
 * INVARIANT: a per-state housing finance agency row IS state-scoped
 * (2026-08-03, the Demo College Student Persona out-of-state-HFA class).
 *
 * The `state_housing_finance_agency` lane is ONE national registry row whose
 * adapter resolves the profile's OWN agency from STATE_REGISTRY — but the
 * adapter dropped the state it had just resolved, so every minted row ("West
 * Virginia Housing Development Fund — homeowner & renter housing programs")
 * inherited the national source's geography: `state NULL, is_national 1`, with
 * the true state visible only in the title as a FULL NAME — a shape
 * `declaredStateFromTitle` (the `"<Place>, XX — "` rule) deliberately cannot
 * read. Measured in prod 2026-08-03: 18 catalog rows, ALL `state NULL /
 * is_national true`, carrying 333 match rows — a TENNESSEE student surfaced
 * West Virginia / Indiana / Michigan / Alabama / Arkansas / Ohio agencies.
 *
 * The repair reads NOTHING new: the sponsor IS the registry's own
 * `housingName` (the adapter minted it from there), so resolution is an exact
 * curated-vocabulary lookup — never a fuzzy state-name grep (a bare full-name
 * rule would call "New York Life Insurance" a geography). The generic fallback
 * row ("State housing agency — homeowner & renter programs") resolves to
 * nothing and honestly stays national. After the catalog repair, match rows on
 * a state-resolved agency row are purged for profiles whose own declared
 * states do not include it — MISSING = NEUTRAL: a profile with no resolvable
 * state loses nothing.
 *
 * Writer-side twin: stateHousingAgencyAdapter now emits
 * `geography: { national: false, states: [st] }` for a resolved agency.
 * Bounded by STATE_AGENCY_GEO_LIMIT (500) / MATCH_SCOPE_PURGE_LIMIT;
 * ENFORCE_STATE_AGENCY_GEO_SCOPE=0 for count-only.
 */
export async function enforceStateAgencyGeoScope(db) {
  return runInvariant('state_agency_geo_scope', async () => {
    let STATE_REGISTRY, STATE_HOUSING_AGENCY_SOURCE_ID, normalizeState
    try {
      ;({ STATE_REGISTRY } = await import('../services/shared/data/stateRegistry.js'))
      ;({ STATE_HOUSING_AGENCY_SOURCE_ID } = await import('../crawler-os/sourceRegistry.js'))
      ;({ normalizeState } = await import('../utils/stateNormalization.js'))
    } catch (err) {
      log.warn('state_agency_geo_scope: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const disabled = _parseBoolEnv(process.env.ENFORCE_STATE_AGENCY_GEO_SCOPE) === false
    const catalogLimit = _boundedLimit('STATE_AGENCY_GEO_LIMIT', DECLARED_GEO_SCOPE_LIMIT_DEFAULT)
    const purgeLimit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    // Curated lookup: the registry's own housingName, lower-cased, → state code.
    const stateOfAgencyName = new Map()
    for (const [code, entry] of Object.entries(STATE_REGISTRY || {})) {
      const name = String(entry?.housingName || '').trim().toLowerCase()
      if (name) stateOfAgencyName.set(name, code)
    }

    // ── Catalog repair. SQL predicate (source id), never a post-LIMIT filter.
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT id, title, sponsor, state, is_national
             FROM funding_opportunities
            WHERE source = ?
              AND (state IS NULL OR TRIM(state) = '')
            LIMIT ?`,
        )
        .all(STATE_HOUSING_AGENCY_SOURCE_ID, catalogLimit)
    } catch (err) {
      log.warn('state_agency_geo_scope: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const fixes = []
    for (const row of rows || []) {
      const sponsor = String(row.sponsor || '').trim().toLowerCase()
      const title = String(row.title || '').trim().toLowerCase()
      let code = stateOfAgencyName.get(sponsor) || null
      if (!code) {
        // The minted title is exactly `${housingName} — …` — same curated string.
        for (const [name, st] of stateOfAgencyName) {
          if (title.startsWith(`${name} —`) || title.startsWith(`${name} -`)) { code = st; break }
        }
      }
      if (code) fixes.push({ id: row.id, state: code })
    }

    let repaired = 0
    if (!disabled) {
      for (const fix of fixes) {
        const res = await db
          .prepare('UPDATE funding_opportunities SET state = ?, is_national = 0 WHERE id = ?')
          .run(fix.state, fix.id)
        repaired += changesOf(res) || 1
      }
    }

    // ── Match purge: a state-resolved agency row matched to a profile in a
    // DIFFERENT state. Runs on the post-repair state column so rows repaired
    // this same boot are already adjudicable. SQL predicate: source id + a
    // non-empty state.
    let matchRows
    try {
      matchRows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, o.state AS opp_state, o.title
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
            WHERE o.source = ?
              AND o.state IS NOT NULL AND TRIM(o.state) <> ''
            LIMIT ?`,
        )
        .all(STATE_HOUSING_AGENCY_SOURCE_ID, purgeLimit)
    } catch {
      matchRows = []
    }
    const profileStates = await loadProfileStates(db, normalizeState)
    const violating = []
    for (const row of matchRows || []) {
      const states = profileStates.get(row.profile_id)
      if (!states || states.size === 0) continue // UNKNOWN profile state is NEUTRAL
      const oppState = normalizeState(row.opp_state)
      if (oppState && !states.has(oppState)) violating.push(row)
    }

    if (disabled) {
      if (fixes.length > 0 || violating.length > 0) {
        log.warn('per-state housing agency rows are mis-scoped as national (repair DISABLED via ENFORCE_STATE_AGENCY_GEO_SCOPE=0)', {
          wouldRepair: fixes.length,
          wouldPurge: violating.length,
          scanned: rows?.length || 0,
        })
      }
      return {
        scanned: (rows?.length || 0) + (matchRows?.length || 0),
        repaired: 0,
        wouldRepair: fixes.length,
        wouldPurge: violating.length,
        enforced: false,
      }
    }

    let purged = 0
    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      purged += changesOf(res) || slice.length
    }
    if (repaired > 0 || purged > 0) {
      log.info('re-scoped per-state housing agency rows and removed out-of-state agency matches', {
        repaired,
        purged,
        profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
        examples: violating.slice(0, 3).map((v) => v.title),
      })
    }
    return {
      scanned: (rows?.length || 0) + (matchRows?.length || 0),
      repaired,
      purged,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: a CROSS-PROFILE match row exists only on the engine's ACCEPT
 * (2026-08-03, the Demo College Student Persona report — the global door).
 *
 * The xmatch lane ("match every newly stored opportunity against ALL known
 * profiles") scores every catalog row of every run against every OTHER
 * profile's thesis STUB — no sections, no signals — and stored every
 * non-REJECT verdict. A cross-profile REVIEW is uncertainty against a stub,
 * not eligibility, and because `qualifiesForDisplay` lets any DIRECTORY at or
 * above the review band surface, those rows went straight to the owner's
 * Funding Sources list. Measured in prod 2026-08-03: 4,792 xmatch rows across
 * 38 profiles, of which 4,577 (95.5%) were REVIEW — another state's housing
 * finance agency, disease directories on profiles with no declared condition,
 * "Goldwater Scholarship" at score 2 on churches and biolabs.
 *
 * A DIRECTORY can never reach ACCEPT (the engine downgrades it by design), so
 * under this rule NO cross-profile locator is ever stored — a locator lane is
 * the profile's OWN planner's per-profile decision (servesDeclaredCondition /
 * servesGeo), and the profile's own crawl still stores its own REVIEW
 * locators. This does NOT touch `isRecommendable` or the locator/REVIEW
 * admission (the two forbidden ends of the locator defect).
 *
 * Writer-side twin: persistRunCore's xmatch branch now skips every non-ACCEPT;
 * the resource-preserving snapshot (crawlerOsPersistence.js) holds the same
 * bar so a reconcile can no longer restore them. Bounded by
 * MATCH_SCOPE_PURGE_LIMIT (2000/boot; the nightly Robert cycle's xmatch reset
 * clears any tail the first night); ENFORCE_XMATCH_PRECISION=0 for count-only.
 */
export async function enforceCrossProfileMatchPrecision(db) {
  return runInvariant('cross_profile_match_precision', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('matcher_version') || !matchCols.has('match_decision')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT id, profile_id FROM profile_opportunity_matches
            WHERE matcher_version = 'crawler-os-xmatch'
              AND LOWER(COALESCE(match_decision, '')) <> 'accept'
            LIMIT ?`,
        )
        .all(limit)
    } catch (err) {
      log.warn('cross_profile_match_precision: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    if ((rows || []).length === 0) return { scanned: 0, repaired: 0, enforced: true }

    const disabled = _parseBoolEnv(process.env.ENFORCE_XMATCH_PRECISION) === false
    if (disabled) {
      log.warn('non-ACCEPT cross-profile match rows present (purge DISABLED via ENFORCE_XMATCH_PRECISION=0)', {
        wouldRepair: rows.length,
        profilesAffected: new Set(rows.map((r) => r.profile_id)).size,
      })
      return { scanned: rows.length, repaired: 0, wouldRepair: rows.length, enforced: false }
    }

    const ids = rows.map((r) => r.id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed non-ACCEPT cross-profile match rows (a cross-match is a match only on ACCEPT)', {
      repaired,
      profilesAffected: new Set(rows.map((r) => r.profile_id)).size,
    })
    return {
      scanned: rows.length,
      repaired,
      profilesAffected: new Set(rows.map((r) => r.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: a DISEASE-SPECIFIC lane's rows reach only a profile that DECLARES
 * the condition (2026-08-03 — the match-store half of #1102's lane-selection
 * gate, and the door the planner gate could not close).
 *
 * `servesDeclaredCondition` (crawler-os/planner.js, 2026-08-02) stops a
 * profile's OWN crawl from ASKING a condition lane — but the rows already in
 * the match store predate it, and they are STRUCTURALLY IMMORTAL: the
 * resource-preserving reconcile (crawlerOsPersistence.js) restores every
 * DIRECTORY match the run did not explicitly re-score as REJECT, and the
 * planner gate guarantees those lanes are never re-scored for that profile
 * again. Demo College Student Persona's amputee/arthritis/autism/HLAA/Reeve/BIAA rows were
 * evaluated 2026-08-02T04:10Z (pre-gate) and survived his 2026-08-03 crawl
 * exactly this way. Measured fleet-wide 2026-08-03: 291 'crawler-os' rows
 * across 27 profiles + 126 xmatch rows across 28 profiles on disease-specific
 * sources.
 *
 * SAME facts, SAME vocabulary as the planner gate — nothing re-derived:
 * `DISEASE_SPECIFIC_SOURCE_IDS` + `sourceServesDeclaredCondition`
 * (config/sourceLanes.js) against the thesis's `declared_health_terms`
 * (`buildThesisForProfile`, the union of `signals.health_conditions` and
 * `health_support` — Demo Health Education Persona's `arthritis` lives in SUPPORT and
 * keeps his arthritis lane). MISSING = NEUTRAL: a profile whose thesis cannot
 * be built, or that carries no `declared_health_terms` ARRAY, loses nothing;
 * an EMPTY array is a read that found nothing and purges (the planner gate's
 * exact semantics). Bounded by MATCH_SCOPE_PURGE_LIMIT;
 * ENFORCE_CONDITION_LANE_SCOPE=0 for count-only.
 */
export async function enforceConditionLaneMatchScope(db, { resolveThesis = null } = {}) {
  return runInvariant('condition_lane_match_scope', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let DISEASE_SPECIFIC_SOURCE_IDS, sourceServesDeclaredCondition, getSource, buildThesisForProfile
    try {
      ;({ DISEASE_SPECIFIC_SOURCE_IDS, sourceServesDeclaredCondition } = await import('../config/sourceLanes.js'))
      ;({ getSource } = await import('../crawler-os/sourceRegistry.js'))
      if (!resolveThesis) ({ buildThesisForProfile } = await import('../services/crawlerOsService.js'))
    } catch (err) {
      log.warn('condition_lane_match_scope: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const thesisOf = resolveThesis || ((d, pid) => buildThesisForProfile(d, pid))
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    // Registry-generated SQL predicate (#944): only disease-lane rows are ever
    // candidates, so the rest of the store cannot starve them out of the bound.
    const ph = DISEASE_SPECIFIC_SOURCE_IDS.map(() => '?').join(', ')
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, o.source AS source_id, o.title
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
            WHERE o.source IN (${ph})
            LIMIT ?`,
        )
        .all(...DISEASE_SPECIFIC_SOURCE_IDS, limit)
    } catch (err) {
      log.warn('condition_lane_match_scope: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    if ((rows || []).length === 0) return { scanned: 0, repaired: 0, enforced: true }

    const byProfile = new Map()
    for (const r of rows) {
      if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
      byProfile.get(r.profile_id).push(r)
    }

    const violating = []
    let profilesSkipped = 0
    for (const [profileId, profileRows] of byProfile) {
      let thesis = null
      try {
        thesis = await thesisOf(db, profileId)
      } catch {
        thesis = null
      }
      // MISSING = NEUTRAL: an unreadable profile, or one whose thesis carries
      // no declared_health_terms ARRAY, adjudicates nothing this boot.
      if (!thesis || !Array.isArray(thesis.declared_health_terms)) {
        profilesSkipped += 1
        continue
      }
      const terms = thesis.declared_health_terms
      for (const row of profileRows) {
        const source = getSource(row.source_id)
        if (!source) continue // unknown source — cannot adjudicate, leave alone
        if (!sourceServesDeclaredCondition(source, terms)) violating.push(row)
      }
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_CONDITION_LANE_SCOPE) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('disease-lane rows are matched to profiles that declare no such condition (purge DISABLED via ENFORCE_CONDITION_LANE_SCOPE=0)', {
          wouldRepair: violating.length,
          scanned: rows.length,
          examples: violating.slice(0, 3).map((v) => v.title),
        })
      }
      return { scanned: rows.length, repaired: 0, wouldRepair: violating.length, profilesSkipped, enforced: false }
    }
    if (violating.length === 0) return { scanned: rows.length, repaired: 0, profilesSkipped, enforced: true }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph2 = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph2})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed disease-lane matches from profiles that declare no such condition', {
      repaired,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map((v) => v.title),
    })
    return {
      scanned: rows.length,
      repaired,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      profilesSkipped,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: a MISSION-SPECIFIC lane's rows reach only a profile that DECLARES
 * the mission (2026-08-22 — the match-store half of the planner's
 * `servesDeclaredMission` gate, and the door that gate cannot close).
 *
 * Measured on the four real prod profiles 2026-08-22: "PetSmart Charities
 * grant programs" is rank 7 in AXIOM BIOLABS' (a biotech lab's) top 10 — the
 * exact verbatim junk the 2026-08-02 audit named for a church roof. Rows
 * already in the match store predate the planner gate and are STRUCTURALLY
 * IMMORTAL through the same restore/planner-gate interaction the condition
 * sweep documents: the resource-preserving reconcile restores every DIRECTORY
 * match a run did not explicitly re-score as REJECT, and the gate guarantees
 * a refused lane is never re-scored for that profile again.
 *
 * SAME facts, SAME vocabulary as the planner gate — nothing re-derived:
 * `MISSION_SPECIFIC_SOURCE_REQUIREMENTS` + `sourceServesDeclaredMission`
 * (config/sourceLanes.js) against the thesis's `needs`/`needs_defaulted`/
 * `applicant_types`. MISSING = NEUTRAL: a profile whose thesis cannot be
 * built, or that carries no `needs` ARRAY, adjudicates nothing this boot.
 * Bounded by MATCH_SCOPE_PURGE_LIMIT; ENFORCE_MISSION_LANE_SCOPE=0 for
 * count-only. Only MATCH rows are deleted — the catalog is never touched.
 */
export async function enforceMissionLaneMatchScope(db, { resolveThesis = null } = {}) {
  return runInvariant('mission_lane_match_scope', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let MISSION_SPECIFIC_SOURCE_REQUIREMENTS, sourceServesDeclaredMission, getSource, buildThesisForProfile
    try {
      ;({ MISSION_SPECIFIC_SOURCE_REQUIREMENTS, sourceServesDeclaredMission } = await import('../config/sourceLanes.js'))
      ;({ getSource } = await import('../crawler-os/sourceRegistry.js'))
      if (!resolveThesis) ({ buildThesisForProfile } = await import('../services/crawlerOsService.js'))
    } catch (err) {
      log.warn('mission_lane_match_scope: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const thesisOf = resolveThesis || ((d, pid) => buildThesisForProfile(d, pid))
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    // Registry-generated SQL predicate (#944): only mission-lane rows are ever
    // candidates, so the rest of the store cannot starve them out of the bound.
    const missionIds = Object.keys(MISSION_SPECIFIC_SOURCE_REQUIREMENTS)
    if (missionIds.length === 0) return { scanned: 0, repaired: 0, enforced: true }
    const ph = missionIds.map(() => '?').join(', ')
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, o.source AS source_id, o.title
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
            WHERE o.source IN (${ph})
            LIMIT ?`,
        )
        .all(...missionIds, limit)
    } catch (err) {
      log.warn('mission_lane_match_scope: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    if ((rows || []).length === 0) return { scanned: 0, repaired: 0, enforced: true }

    const byProfile = new Map()
    for (const r of rows) {
      if (!byProfile.has(r.profile_id)) byProfile.set(r.profile_id, [])
      byProfile.get(r.profile_id).push(r)
    }

    const violating = []
    let profilesSkipped = 0
    for (const [profileId, profileRows] of byProfile) {
      let thesis = null
      try {
        thesis = await thesisOf(db, profileId)
      } catch {
        thesis = null
      }
      // MISSING = NEUTRAL: an unreadable profile, or one whose thesis carries
      // no `needs` ARRAY, adjudicates nothing this boot.
      if (!thesis || !Array.isArray(thesis.needs)) {
        profilesSkipped += 1
        continue
      }
      for (const row of profileRows) {
        const source = getSource(row.source_id)
        if (!source) continue // unknown source — cannot adjudicate, leave alone
        if (!sourceServesDeclaredMission(source, thesis)) violating.push(row)
      }
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_MISSION_LANE_SCOPE) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('mission-lane rows are matched to profiles that declare no such mission (purge DISABLED via ENFORCE_MISSION_LANE_SCOPE=0)', {
          wouldRepair: violating.length,
          scanned: rows.length,
          examples: violating.slice(0, 3).map((v) => v.title),
        })
      }
      return { scanned: rows.length, repaired: 0, wouldRepair: violating.length, profilesSkipped, enforced: false }
    }
    if (violating.length === 0) return { scanned: rows.length, repaired: 0, profilesSkipped, enforced: true }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph2 = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph2})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed mission-lane matches from profiles that declare no such mission', {
      repaired,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map((v) => v.title),
    })
    return {
      scanned: rows.length,
      repaired,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      profilesSkipped,
      enforced: true,
    }
  })
}

/**
 * Every US state / CA province code a profile declares, from its own sections.
 * `profiles` carries no state column in prod, so the truth lives in
 * `profile_sections` (`basic_information.state`, `location_focus.focus_state`).
 * An empty set means UNKNOWN, which every caller must treat as NEUTRAL.
 */
async function loadProfileStates(db, normalizeState) {
  const byProfile = new Map()
  let rows
  try {
    rows = await db
      .prepare(
        `SELECT profile_id, section_key, data FROM profile_sections
          WHERE section_key IN ('basic_information', 'location_focus')`,
      )
      .all()
  } catch {
    return byProfile // section table absent on a minimal schema — everyone UNKNOWN
  }
  for (const row of rows || []) {
    let parsed = row?.data
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed) } catch { parsed = null }
    }
    if (!parsed || typeof parsed !== 'object') continue
    for (const key of ['state', 'focus_state']) {
      const code = normalizeState(parsed[key])
      if (!code) continue
      if (!byProfile.has(row.profile_id)) byProfile.set(row.profile_id, new Set())
      byProfile.get(row.profile_id).add(code)
    }
  }
  return byProfile
}

/**
 * INVARIANT: a locator that NAMES its own place is not surfaced to a profile
 * somewhere else.
 *
 * `enforceDeclaredGeoScope()` above repairs the CATALOG so the engine can judge
 * these rows, and `makeDecision` now REJECTs an out-of-area place-declaring row
 * — but the match store is only rebuilt when a profile next crawls, and the
 * owner is looking at it now. Prod 2026-08-01: 1,069 match rows point at a
 * place-declaring locator; 684 of them, across 25 of 39 profiles, name a state
 * the profile is not in. That is the top of the owner's GeneMac list — an
 * Indiana senior shown Polk County TN, Raleigh County WV, Bergen County NJ.
 *
 * MISSING = NEUTRAL, exactly as the engine treats it: a profile with no
 * resolvable state loses nothing, and the profile's OWN county/city locators are
 * untouched (they declare the state the profile is in). Bounded by
 * MATCH_SCOPE_PURGE_LIMIT; ENFORCE_DECLARED_PLACE_SCOPE=0 for count-only.
 */
export async function enforceDeclaredPlaceScopeMatches(db) {
  return runInvariant('declared_place_scope_matches', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let declaredStateFromTitle, DECLARED_STATE_TITLE_LIKE_PATTERNS, normalizeState
    try {
      ;({ declaredStateFromTitle, DECLARED_STATE_TITLE_LIKE_PATTERNS } = await import(
        '../config/opportunityJurisdiction.js'
      ))
      ;({ normalizeState } = await import('../utils/stateNormalization.js'))
    } catch (err) {
      log.warn('declared_place_scope_matches: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    // SQL predicate, not a post-LIMIT filter (#944): only place-declaring titles
    // are ever candidates, so ordinary rows cannot starve them out of the bound.
    const likeClause = DECLARED_STATE_TITLE_LIKE_PATTERNS.map(() => 'o.title LIKE ?').join(' OR ')
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, o.title
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
            WHERE o.title IS NOT NULL AND (${likeClause})
            LIMIT ?`,
        )
        .all(...DECLARED_STATE_TITLE_LIKE_PATTERNS, limit)
    } catch (err) {
      log.warn('declared_place_scope_matches: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    if ((rows || []).length === 0) return { scanned: 0, repaired: 0, enforced: true }

    const profileStates = await loadProfileStates(db, normalizeState)
    const violating = []
    for (const row of rows) {
      const declared = declaredStateFromTitle(row)
      if (!declared) continue
      const states = profileStates.get(row.profile_id)
      if (!states || states.size === 0) continue // UNKNOWN profile state is NEUTRAL
      if (!states.has(declared)) violating.push({ ...row, declared })
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_DECLARED_PLACE_SCOPE) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('out-of-area place-declaring locators are matched to profiles (purge DISABLED via ENFORCE_DECLARED_PLACE_SCOPE=0)', {
          wouldRepair: violating.length,
          scanned: rows.length,
          examples: violating.slice(0, 3).map((v) => v.title),
        })
      }
      return { scanned: rows.length, repaired: 0, wouldRepair: violating.length, enforced: false }
    }
    if (violating.length === 0) return { scanned: rows.length, repaired: 0, enforced: true }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed out-of-area locators from profiles that are somewhere else', {
      repaired,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map((v) => v.title),
    })
    return {
      scanned: rows.length,
      repaired,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: no surfaced match points at a FOREIGN-JURISDICTION program.
 *
 * The geography gate only ever compared a US state code, so a program
 * administered by another government (Ireland's Housing Adaptation Grant on
 * citizensinformation.ie, gov.uk, sassa.gov.za, dda.gov.in …) has `state NULL`,
 * skips the gate entirely, and — having no state — was ALSO stamped
 * `is_national`, which makes the geo tier score it as a fully-eligible
 * nationwide US program. Prod 2026-08-01: 146 active foreign catalog rows, 55
 * live match rows across 6 profiles.
 *
 * Evidence is the row's own url (`detectForeignJurisdiction`), never sponsor or
 * title prose — a phrase like "Local Authorities" is how a class fix decays into
 * a denylist. The CATALOG row is left alone (it is a true record of a real
 * program); only the profile↔opportunity MATCH is removed, because that is the
 * claim "you can apply to this". Converges: makeDecision now REJECTs the pair,
 * and the persist path never stores a REJECT.
 *
 * Bounded by MATCH_SCOPE_PURGE_LIMIT (2000/boot);
 * ENFORCE_FOREIGN_JURISDICTION_SCOPE=0 for count-only.
 */
export async function enforceForeignJurisdictionMatches(db) {
  return runInvariant('foreign_jurisdiction_matches', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let detectForeignOpportunity, foreignUrlSqlPredicate, foreignFunderNameSqlPredicate
    try {
      ;({ detectForeignOpportunity, foreignUrlSqlPredicate, foreignFunderNameSqlPredicate } = await import(
        '../config/opportunityJurisdiction.js'
      ))
    } catch (err) {
      log.warn('foreign_jurisdiction_matches: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    // FOREIGNNESS IS A PROPERTY OF THE OPPORTUNITY, NOT OF THE MATCH — so the
    // candidate set is the CATALOG, narrowed by a SQL predicate, and the delete
    // is then targeted by opportunity_id.
    //
    // The first version selected MATCH rows with no WHERE clause and decided
    // foreign-ness in JS after `LIMIT ?`. Prod boot 2026-08-01 recorded
    // `{"foreign_jurisdiction_matches","repaired":1,"scanned":2000}` — the bound
    // exactly — so 515 of 516 foreign rows were structurally unreachable however
    // often it ran (the #944 post-LIMIT class; the three sibling sweeps in the
    // same PR all had a predicate and all converged: 84/87, 494/875, 157/506).
    //
    // Scoping to the catalog also shrinks the candidate set by ~three orders of
    // magnitude (≈150 foreign rows vs ~11.5k matches), so the bound now limits
    // DELETES, never DISCOVERY.
    const hay =
      "lower(coalesce(o.source_url,'')) || ' ' || lower(coalesce(o.application_url,'')) || ' ' || " +
      "lower(coalesce(o.evidence_url,'')) || ' '"
    const { clause, params } = foreignUrlSqlPredicate(`(${hay})`)
    // 2026-08-03 owner QA: foreign FUNDERS on generic .org/.com hosts (Tata
    // Trusts, UK "LA Flex") evade the ccTLD predicate entirely — their evidence
    // is the row's own IDENTITY text, so the candidate superset must also scan
    // title+sponsor. Same posture: the LIKE list is a SUPERSET, the JS detector
    // adjudicates.
    const nameHay = "lower(coalesce(o.title,'')) || ' ' || lower(coalesce(o.sponsor,''))"
    const { clause: nameClause, params: nameParams } = foreignFunderNameSqlPredicate(`(${nameHay})`)

    let oppRows
    try {
      oppRows = await db
        .prepare(
          `SELECT o.id, o.title, o.sponsor, o.source_url, o.application_url, o.evidence_url
             FROM funding_opportunities o
            WHERE ${clause} OR ${nameClause}`,
        )
        .all(...params, ...nameParams)
    } catch (err) {
      log.warn('foreign_jurisdiction_matches: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    // The LIKE list is a SUPERSET; detectForeignOpportunity is the authority
    // (it re-parses the host, honours JURISDICTION_NEUTRAL_HOSTS, and holds the
    // funder-name evidence to word-bounded identity patterns).
    const foreignOpps = new Map()
    for (const row of oppRows || []) {
      const verdict = detectForeignOpportunity(row)
      if (verdict.foreign) {
        foreignOpps.set(row.id, { ...row, cctld: verdict.cctld, host: verdict.host ?? verdict.funder ?? null })
      }
    }
    if (foreignOpps.size === 0) return { scanned: oppRows?.length || 0, repaired: 0, enforced: true }

    // Now the matches pointing at them — bounded, but the bound can only cost us
    // DELETES this boot (the next boot finds the remainder), never visibility.
    const oppIds = [...foreignOpps.keys()]
    const violating = []
    const SELECT_CHUNK = 200
    for (let i = 0; i < oppIds.length && violating.length < limit; i += SELECT_CHUNK) {
      const slice = oppIds.slice(i, i + SELECT_CHUNK)
      const ph = slice.map(() => '?').join(', ')
      let rows
      try {
        rows = await db
          .prepare(
            `SELECT id AS match_id, profile_id, opportunity_id
               FROM profile_opportunity_matches
              WHERE opportunity_id IN (${ph})`,
          )
          .all(...slice)
      } catch (err) {
        log.warn('foreign_jurisdiction_matches: match lookup failed (non-fatal)', { error: String(err?.message || err) })
        return { scanned: oppRows?.length || 0, repaired: 0, enforced: true, skipped: 'query' }
      }
      for (const r of rows || []) {
        if (violating.length >= limit) break
        const opp = foreignOpps.get(r.opportunity_id) || {}
        violating.push({ ...r, title: opp.title, host: opp.host })
      }
    }

    const describe = (v) => `${v.title} (${v.host})`
    const disabled = _parseBoolEnv(process.env.ENFORCE_FOREIGN_JURISDICTION_SCOPE) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('foreign-jurisdiction programs are matched to profiles (purge DISABLED via ENFORCE_FOREIGN_JURISDICTION_SCOPE=0)', {
          wouldRepair: violating.length,
          foreignOpportunities: foreignOpps.size,
          scanned: oppRows?.length || 0,
          examples: violating.slice(0, 3).map(describe),
        })
      }
      return {
        scanned: oppRows?.length || 0,
        repaired: 0,
        wouldRepair: violating.length,
        foreignOpportunities: foreignOpps.size,
        enforced: false,
      }
    }
    if (violating.length === 0) {
      return { scanned: oppRows?.length || 0, repaired: 0, foreignOpportunities: foreignOpps.size, enforced: true }
    }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed matches to foreign-jurisdiction programs (a US applicant cannot apply)', {
      repaired,
      foreignOpportunities: foreignOpps.size,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map(describe),
    })
    return {
      scanned: oppRows?.length || 0,
      repaired,
      foreignOpportunities: foreignOpps.size,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: a regulatory/administrative NOTICE, a lead-gen "scholarship", or a
 * clearly-expired program is never a surfaced funding match (owner QA pass
 * across all 36 profiles, 2026-08-03).
 *
 * The engine's procedural gate (RE_PROCEDURAL_NOTICE_TITLE via makeDecision)
 * existed but (a) its pattern registry was narrower than the live junk — SEC
 * "Self-Regulatory Organization; Notice of Filing of Proposed Rule Change",
 * IRS/OMB "Agency Information Collection Activities; Comment Request", a DOL
 * "Prohibited Transaction Exemption" for Meta Platforms, DOJ "Proposed Final
 * Judgment" antitrust filings — and (b) the match store is a rolling snapshot:
 * stored ACCEPT/REVIEW rows predate any gate and are replayed verbatim by the
 * funding-sources route's persisted-truth policy. The per-call gate is the
 * first line of defense; this sweep is the net that converges the store.
 *
 * Candidate discovery is a SQL LIKE SUPERSET over the row's OWN title
 * (`nonGrantTitleSqlPredicate` — predicates before LIMIT, #944/#1080 class);
 * the shared-chain classifiers adjudicate every candidate in JS. Only MATCH
 * rows are deleted ("you can apply to this" was the false claim); the CATALOG
 * row is never touched. A past FIRM DEADLINE alone never deletes here —
 * deadline data is often the crawler's fault, so that class only re-buckets at
 * presentation.
 *
 * `ENFORCE_NON_GRANT_NOTICE_SCOPE=0` → count-only. Bound: MATCH_SCOPE_PURGE_LIMIT.
 */
export async function enforceNonGrantNoticeMatches(db) {
  return runInvariant('non_grant_notice_matches', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let classifyRegulatoryNotice, isLeadGenScholarship, isClearlyExpiredProgram, isSiteSectionPage, nonGrantTitleSqlPredicate
    try {
      ;({
        classifyRegulatoryNotice,
        isLeadGenScholarship,
        isClearlyExpiredProgram,
        isSiteSectionPage,
        nonGrantTitleSqlPredicate,
      } = await import('../config/fundingResultFilters.js'))
    } catch (err) {
      log.warn('non_grant_notice_matches: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    const { clause, params } = nonGrantTitleSqlPredicate("lower(coalesce(o.title,''))")
    let oppRows
    try {
      oppRows = await db
        .prepare(
          `SELECT o.id, o.title, o.sponsor, o.deadline, o.deadline_type, o.source, o.source_id
             FROM funding_opportunities o
            WHERE ${clause}`,
        )
        .all(...params)
    } catch (err) {
      log.warn('non_grant_notice_matches: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    // Adjudicate the superset. POSITIVE junk evidence only:
    //   - regulatory TITLE (the canonical procedural regex — the row's own words),
    //   - lead-gen funder identity,
    //   - clearly-expired program SHAPE (COVID rapid response / past PY year).
    // A Federal-Register SOURCE alone re-buckets at presentation but never
    // deletes here, and `deadline_long_past` is deliberately excluded.
    const junkOpps = new Map()
    for (const row of oppRows || []) {
      const regulatory = classifyRegulatoryNotice({ title: row.title })
      if (regulatory === 'regulatory_notice_title') {
        junkOpps.set(row.id, { ...row, reason: regulatory })
        continue
      }
      const leadGen = isLeadGenScholarship(row)
      if (leadGen) {
        junkOpps.set(row.id, { ...row, reason: `lead_gen:${leadGen}` })
        continue
      }
      // A program site's own navigation/administrative page (the TennCare
      // 'Member Benefit Table' class) — positive junk evidence by the row's
      // own title, same authority the read path uses.
      const siteSection = isSiteSectionPage(row)
      if (siteSection) {
        junkOpps.set(row.id, { ...row, reason: `site_section:${siteSection}` })
        continue
      }
      const expired = isClearlyExpiredProgram(row)
      if (expired && expired !== 'deadline_long_past') {
        junkOpps.set(row.id, { ...row, reason: `expired:${expired}` })
      }
    }
    if (junkOpps.size === 0) return { scanned: oppRows?.length || 0, repaired: 0, enforced: true }

    const oppIds = [...junkOpps.keys()]
    const violating = []
    const SELECT_CHUNK = 200
    for (let i = 0; i < oppIds.length && violating.length < limit; i += SELECT_CHUNK) {
      const slice = oppIds.slice(i, i + SELECT_CHUNK)
      const ph = slice.map(() => '?').join(', ')
      let rows
      try {
        rows = await db
          .prepare(
            `SELECT id AS match_id, profile_id, opportunity_id
               FROM profile_opportunity_matches
              WHERE opportunity_id IN (${ph})`,
          )
          .all(...slice)
      } catch (err) {
        log.warn('non_grant_notice_matches: match lookup failed (non-fatal)', { error: String(err?.message || err) })
        return { scanned: oppRows?.length || 0, repaired: 0, enforced: true, skipped: 'query' }
      }
      for (const r of rows || []) {
        if (violating.length >= limit) break
        const opp = junkOpps.get(r.opportunity_id) || {}
        violating.push({ ...r, title: opp.title, reason: opp.reason })
      }
    }

    const describe = (v) => `${v.title} [${v.reason}]`
    const disabled = _parseBoolEnv(process.env.ENFORCE_NON_GRANT_NOTICE_SCOPE) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('non-grant notices are matched to profiles (purge DISABLED via ENFORCE_NON_GRANT_NOTICE_SCOPE=0)', {
          wouldRepair: violating.length,
          junkOpportunities: junkOpps.size,
          scanned: oppRows?.length || 0,
          examples: violating.slice(0, 3).map(describe),
        })
      }
      return {
        scanned: oppRows?.length || 0,
        repaired: 0,
        wouldRepair: violating.length,
        junkOpportunities: junkOpps.size,
        enforced: false,
      }
    }
    if (violating.length === 0) {
      return { scanned: oppRows?.length || 0, repaired: 0, junkOpportunities: junkOpps.size, enforced: true }
    }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed matches to non-grant notices (regulatory/lead-gen/clearly-expired)', {
      repaired,
      junkOpportunities: junkOpps.size,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map(describe),
    })
    return {
      scanned: oppRows?.length || 0,
      repaired,
      junkOpportunities: junkOpps.size,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: a non-grant notice is never a profile PIPELINE row.
 *
 * `enforceNonGrantNoticeMatches` above converges the MATCH store, but the
 * `grants` table — the pipeline the owner actually works — had no equivalent
 * net, and the per-call junk gate landed in `admitToPipeline` only on
 * 2026-08-04: every non-canonical writer that ran before it (manual creates,
 * imports, the admin-schema-repair migrations) left regulatory notices sitting
 * in pipelines as work items. Prod 2026-08-04: an HRSA "Agency Information
 * Collection … Public Comment Request" (score 82) and an EPA Federal-Register
 * "Notice of Availability" (76) on Axiom BioLabs' pipeline, both with
 * ready_to_start application tasks.
 *
 * Candidate discovery is a SQL LIKE SUPERSET (`nonGrantCandidateSqlPredicate`:
 * title patterns + Federal-Register provenance over the grant's OWN urls —
 * predicates before LIMIT, #944/#1080 class); `classifyFundingResult`
 * adjudicates every candidate in JS.
 *
 * REPAIR (mirrors enforceProfileEligibility's conservatism):
 *   - PURGE (tombstone via pipelineDismissals, then delete) ONLY on the same
 *     positive evidence the matches net purges on — regulatory TITLE, lead-gen
 *     identity, clearly-expired program SHAPE — and only rows in an
 *     early/discovery status with no protected name and no recorded award.
 *   - A Federal-Register SOURCE alone (benign title) is FLAGGED, never purged
 *     here — an FR url can be a real NOFO's announcement link; those rows are
 *     counted (`frSourceFlagged`) for the owner-gated repair script.
 *   - A protected/user-progressed junk row is marked
 *     eligibility_status='ineligible', never deleted.
 *   - Non-terminal application tasks on purged grants are CANCELLED.
 *
 * `ENFORCE_NON_GRANT_PIPELINE=0` → count-only. Bound: NON_GRANT_PIPELINE_LIMIT
 * (500) limits DELETES, never discovery.
 */
export async function enforceNonGrantNoticePipeline(db) {
  return runInvariant('non_grant_notice_pipeline', async () => {
    const grantCols = await listGrantColumns(db)
    if (!grantCols.has('profile_id') || !grantCols.has('title')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let classifyFundingResult, RESULT_BUCKETS, nonGrantCandidateSqlPredicate
    try {
      ;({ classifyFundingResult, RESULT_BUCKETS, nonGrantCandidateSqlPredicate } =
        await import('../config/fundingResultFilters.js'))
    } catch (err) {
      log.warn('non_grant_notice_pipeline: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    let cancelApplicationTask = null
    let recordDismissalFn = null
    try { ({ cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')) } catch { cancelApplicationTask = null }
    try { ({ recordDismissal: recordDismissalFn } = await import('../services/pipelineDismissals.js')) } catch { recordDismissalFn = null }

    const limit = _boundedLimit('NON_GRANT_PIPELINE_LIMIT', 500)
    const hasFunder = grantCols.has('funder')
    const hasAwarded = grantCols.has('amount_awarded')
    const hasEligStatus = grantCols.has('eligibility_status')
    const hasUrl = grantCols.has('url')

    const urlExprs = ["lower(coalesce(g.application_url,''))"]
    if (hasUrl) urlExprs.push("lower(coalesce(g.url,''))")
    const { clause, params } = nonGrantCandidateSqlPredicate({
      hayExpr: "lower(coalesce(g.title,''))",
      urlExprs,
    })

    let rows
    try {
      rows = await db
        .prepare(
          `SELECT g.id, g.profile_id, g.title, ${hasFunder ? 'g.funder' : 'NULL AS funder'}, g.status,
                  g.deadline, g.application_url${hasUrl ? ', g.url' : ''}${hasAwarded ? ', g.amount_awarded' : ''}
             FROM grants g
            WHERE g.profile_id IS NOT NULL AND ${clause}`,
        )
        .all(...params)
    } catch (err) {
      log.warn('non_grant_notice_pipeline: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    if (!rows || rows.length === 0) return { scanned: 0, repaired: 0, enforced: true }

    // Adjudicate the superset. `sponsor` is the classifier's field name; the
    // pipeline column is `funder` (#725 naming drift).
    const PURGE_REASON_RX = /^(regulatory_notice_title|lead_gen:|site_section:|expired:(?!deadline_long_past))/
    const purgeable = []
    let frSourceFlagged = 0
    for (const g of rows) {
      const verdictRow = { ...g, sponsor: g.funder }
      const verdict = classifyFundingResult(verdictRow)
      if (verdict.bucket !== RESULT_BUCKETS.NOT_A_GRANT) continue
      const positive = verdict.reasons.some((r) => PURGE_REASON_RX.test(r))
      if (!positive) {
        // federal_register_source-only (or unresolvable_funder-only) — flag for
        // the owner-gated repair, never auto-purge.
        frSourceFlagged += 1
        continue
      }
      purgeable.push({ ...g, reasons: verdict.reasons })
    }
    if (purgeable.length === 0 && frSourceFlagged === 0) {
      return { scanned: rows.length, repaired: 0, enforced: true }
    }

    const disabled = _parseBoolEnv(process.env.ENFORCE_NON_GRANT_PIPELINE) === false
    const describe = (v) => `${v.title} [${(v.reasons || []).join(',')}]`
    if (disabled) {
      if (purgeable.length > 0 || frSourceFlagged > 0) {
        log.warn('non-grant notices present in profile pipelines (purge DISABLED via ENFORCE_NON_GRANT_PIPELINE=0)', {
          wouldRepair: purgeable.length,
          frSourceFlagged,
          scanned: rows.length,
          examples: purgeable.slice(0, 3).map(describe),
        })
      }
      return { scanned: rows.length, repaired: 0, wouldRepair: purgeable.length, frSourceFlagged, enforced: false }
    }

    let hasTasks = false
    try { await db.prepare('SELECT id FROM application_tasks LIMIT 1').get(); hasTasks = true } catch { hasTasks = false }

    let purged = 0
    let flaggedProtected = 0
    let tasksCancelled = 0
    const affectedProfiles = new Set()
    for (const g of purgeable) {
      if (purged >= limit) break
      const status = g.status === null || g.status === undefined ? null : String(g.status)
      const isEarly = status === null || PURGEABLE_DISCOVERY_STATUSES.includes(status)
      const protectedName = PROTECTED_NAME_PATTERN.test(`${g.title ?? ''} ${g.funder ?? ''}`)
      const hasAward = hasAwarded && Number(g.amount_awarded) > 0

      if (isEarly && !protectedName && !hasAward) {
        if (hasTasks && cancelApplicationTask) {
          let taskRows = []
          try {
            const ph = TERMINAL_TASK_STATUSES.map(() => '?').join(', ')
            taskRows = await db
              .prepare(`SELECT id FROM application_tasks WHERE profile_id = ? AND grant_id = ? AND (status IS NULL OR status NOT IN (${ph}))`)
              .all(g.profile_id, g.id, ...TERMINAL_TASK_STATUSES)
          } catch { taskRows = [] }
          for (const t of taskRows || []) {
            try {
              await cancelApplicationTask(db, t.id, { actorRole: 'system', reason: `Not a fundable opportunity — ${(g.reasons || []).join('; ')}` })
              tasksCancelled += 1
            } catch (err) {
              log.warn('non_grant_notice_pipeline: task cancel failed (non-fatal)', { task: t.id, error: String(err?.message || err) })
            }
          }
        }
        if (recordDismissalFn) {
          try { await recordDismissalFn(db, { profileId: g.profile_id, grantRow: g, reason: `non_grant_notice: ${(g.reasons || []).join('; ')}` }) } catch { /* tombstone best-effort */ }
        }
        try {
          const res = await db.prepare('DELETE FROM grants WHERE id = ?').run(g.id)
          purged += changesOf(res) || 1
          affectedProfiles.add(g.profile_id)
        } catch (err) {
          log.warn('non_grant_notice_pipeline: grant delete failed (non-fatal)', { grant: g.id, error: String(err?.message || err) })
        }
      } else if (hasEligStatus) {
        try {
          await db.prepare('UPDATE grants SET eligibility_status = ? WHERE id = ?').run('ineligible', g.id)
          flaggedProtected += 1
          affectedProfiles.add(g.profile_id)
        } catch { /* audit-only */ }
      }
    }

    if (purged > 0 || flaggedProtected > 0 || frSourceFlagged > 0) {
      log.info('converged non-grant notices out of profile pipelines', {
        purged,
        flaggedProtected,
        frSourceFlagged,
        tasksCancelled,
        profilesAffected: affectedProfiles.size,
        examples: purgeable.slice(0, 3).map(describe),
      })
    }
    return {
      scanned: rows.length,
      repaired: purged + flaggedProtected,
      purged,
      flaggedProtected,
      frSourceFlagged,
      tasksCancelled,
      profilesAffected: affectedProfiles.size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: an INDIVIDUAL's surfaced matches obey the same award ceiling their
 * pipeline already does.
 *
 * `enforceIndividualAmountCeiling()` has purged above-ceiling rows from a
 * person's `grants` pipeline since the ">$3M potential" class. It reaches
 * `grants` only — the MATCH store that feeds the owner-facing Funding Sources
 * list was never held to the same bar, so the exact institutional money the
 * pipeline refuses is displayed as a match. Prod 2026-08-01: 174 match rows
 * across 28 of 39 profiles — NSF Oceanographic Facilities ($47.5M), HUD PRO
 * Housing ($10M), USDA AFRI ($10M), Title X ($22M), and the HUD Fair Housing
 * Initiatives Program ($1.25M) the owner reported as "Individual applicant".
 *
 * Why an AMOUNT and not eligibility text: `applicantTypeGate` decides from
 * eligibility prose and these rows carry none (FHIP in prod: `eligibility_text`
 * NULL, `eligibility_bullets` [], `entity_types_allowed` []). A text gate can
 * never reach them; the stated per-award ceiling is a structural fact the row
 * does publish. Silence is never a violation — a row with no amount is exempt.
 * Orgs/businesses are never touched, and an unknown profile type is treated as
 * NOT an individual (conservative in the direction that preserves rows).
 *
 * Bounded by MATCH_SCOPE_PURGE_LIMIT (2000/boot);
 * ENFORCE_INDIVIDUAL_MATCH_CEILING=0 for count-only.
 */
export async function enforceIndividualMatchAwardCeiling(db) {
  return runInvariant('individual_match_award_ceiling', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let resolveIndividualAwardCeiling, exceedsIndividualAwardCeiling
    try {
      ;({ resolveIndividualAwardCeiling, exceedsIndividualAwardCeiling } = await import(
        '../config/individualAwardCeiling.js'
      ))
    } catch (err) {
      log.warn('individual_match_award_ceiling: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const ceiling = resolveIndividualAwardCeiling()
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)

    const profileCols = await listProfileColumns(db)
    const typeCols = ['applicant_type', 'primary_type'].filter((c) => profileCols.has(c))
    if (typeCols.length === 0) {
      return { scanned: 0, repaired: 0, enforced: true, ceiling, skipped: 'schema' }
    }
    const typeSelect = typeCols.map((c) => `p.${c} AS ${c}`).join(', ')

    let rows
    try {
      rows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, o.title, o.amount_min, o.amount_max, ${typeSelect}
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
             JOIN profiles p ON p.id = m.profile_id
            WHERE (o.amount_max IS NOT NULL AND o.amount_max > ?)
               OR (o.amount_min IS NOT NULL AND o.amount_min > ?)
            LIMIT ?`,
        )
        .all(ceiling, ceiling, limit)
    } catch (err) {
      log.warn('individual_match_award_ceiling: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, ceiling, skipped: 'query' }
    }

    const violating = (rows || []).filter((r) => {
      if (!isIndividualProfileType(r.applicant_type || r.primary_type)) return false
      return exceedsIndividualAwardCeiling(r, ceiling)
    })

    const disabled = _parseBoolEnv(process.env.ENFORCE_INDIVIDUAL_MATCH_CEILING) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('institutional-scale awards are matched to individual profiles (purge DISABLED via ENFORCE_INDIVIDUAL_MATCH_CEILING=0)', {
          wouldRepair: violating.length,
          scanned: rows?.length || 0,
          ceiling,
          examples: violating.slice(0, 3).map((v) => `${v.title} ($${v.amount_max ?? v.amount_min})`),
        })
      }
      return { scanned: rows?.length || 0, repaired: 0, wouldRepair: violating.length, ceiling, enforced: false }
    }
    if (violating.length === 0) return { scanned: rows?.length || 0, repaired: 0, ceiling, enforced: true }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed institutional-scale awards from individual profiles’ matches', {
      repaired,
      ceiling,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map((v) => `${v.title} ($${v.amount_max ?? v.amount_min})`),
    })
    return {
      scanned: rows?.length || 0,
      repaired,
      ceiling,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

const UNCONFIGURED_PROFILE_PURGE_LIMIT_DEFAULT = 2000

/**
 * Load every profile's UNCONFIGURED verdict, using the canonical detector.
 *
 * CANDIDATE DISCOVERY IS A SQL PREDICATE. `PLACEHOLDER_SECTION_LIKE_PATTERNS`
 * narrows `profile_sections` to rows whose text could possibly carry placeholder
 * evidence, so the sweep's bound can only ever limit DELETES, never DISCOVERY —
 * the #944 post-`LIMIT` class whose signature (`scanned == bound`) this repo has
 * paid for four times. The LIKE list is a deliberate SUPERSET; the JS detector
 * re-adjudicates every candidate and is the authority.
 */
async function loadUnconfiguredProfiles(db) {
  const out = new Map()
  let assessProfileConfiguration, PLACEHOLDER_SECTION_LIKE_PATTERNS
  try {
    ;({ assessProfileConfiguration } = await import('../services/profile/profileConfiguration.js'))
    ;({ PLACEHOLDER_SECTION_LIKE_PATTERNS } = await import('../config/placeholderProfileSignals.js'))
  } catch (err) {
    log.warn('unconfigured_profile_matches: deps unavailable (non-fatal)', { error: String(err?.message || err) })
    return { verdicts: out, skipped: 'deps', candidates: 0 }
  }

  const likeClause = PLACEHOLDER_SECTION_LIKE_PATTERNS.map(() => 'ps.data LIKE ?').join(' OR ')
  let candidateIds
  try {
    const rows = await db
      .prepare(
        `SELECT DISTINCT ps.profile_id AS id
           FROM profile_sections ps
          WHERE ps.data IS NOT NULL AND (${likeClause})`,
      )
      .all(...PLACEHOLDER_SECTION_LIKE_PATTERNS)
    candidateIds = (rows || []).map((r) => r.id).filter(Boolean)
  } catch (err) {
    log.warn('unconfigured_profile_matches: candidate query failed (non-fatal)', { error: String(err?.message || err) })
    return { verdicts: out, skipped: 'query', candidates: 0 }
  }
  if (candidateIds.length === 0) return { verdicts: out, candidates: 0 }

  for (const id of candidateIds) {
    // `_loadProfileContextForInvariant` already refuses deleted/archived rows,
    // so a retired demo profile is never touched.
    const ctx = await _loadProfileContextForInvariant(db, id)
    if (!ctx?.profile) continue
    let verdict = null
    try { verdict = assessProfileConfiguration(ctx) } catch { verdict = null }
    if (verdict?.unconfigured) out.set(id, verdict)
  }
  return { verdicts: out, candidates: candidateIds.length }
}

/**
 * INVARIANT: a profile that was NEVER FILLED IN is not shown fabricated
 * geography (2026-08-02).
 *
 * `profile-demo-general-support` is not a person. Its address is
 * `{ street:'123 Main St', city:'Anytown', state:'USA', zip_code:'12345' }`,
 * its email is `@example.com`, its phone is `555-1234`, and its own notes say
 * "Designated roster profile. Add the owner login email here…". It declares no
 * need, no health condition, no occupation, no school, no income. Measured
 * read-only in prod 2026-08-02T02:40Z it nonetheless carried 27 surfaced
 * matches, ALL `DIRECTORY`, whose geography the system INVENTED:
 * `Anytown, SA` (a state code fabricated from the string "USA" — root-caused
 * and fixed in `utils/inferLocationFromAddress.js`), plus Anchorage County AK,
 * Wayne County MI, Dona Ana County NM and Escambia County FL.
 *
 * TWO PROVABLE CLASSES, and only these two:
 *
 *  1. FABRICATED PLACE — the catalog row's title names a placeholder place
 *     token ("Anytown"). Such a row cannot apply to ANY profile, so its matches
 *     are removed fleet-wide, not just on placeholder profiles.
 *  2. UNSUPPORTABLE PLACE — a place-EXCLUSIVE row (a county/city locator, or a
 *     non-national row carrying a state) surfaced to an UNCONFIGURED profile. A
 *     county directory is exclusive by construction (the #1080 rule), so it
 *     requires POSITIVE evidence the applicant is in that place. An
 *     unconfigured profile can never supply that evidence: its declared
 *     location is a placeholder, not merely absent.
 *
 * This is NOT the "MISSING = NEUTRAL" case and must not be confused with it.
 * `enforceDeclaredPlaceScopeMatches` deliberately leaves a profile with no
 * resolvable state alone — silence is not a denial. Here the profile is not
 * silent: it positively declares junk, corroborated across three independent
 * evidence families, with no declared need or eligibility fact anywhere.
 *
 * THE CATALOG ROW IS NEVER DELETED and NO PROFILE CONTENT IS EVER TOUCHED —
 * only the MATCH, which is the claim "you can apply to this". Converges:
 * `makeDecision` now REJECTs a fabricated-place row and the county/city adapter
 * no longer mints one.
 *
 * Bounded by UNCONFIGURED_PROFILE_PURGE_LIMIT (2000/boot);
 * ENFORCE_UNCONFIGURED_PROFILE_SCOPE=0 for count-only.
 */
export async function enforceUnconfiguredProfileGeoMatches(db) {
  return runInvariant('unconfigured_profile_matches', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let isPlaceholderPlaceLabel, placePrefixOfTitle, declaredStateFromTitle
    try {
      ;({ isPlaceholderPlaceLabel, placePrefixOfTitle } = await import('../config/placeholderProfileSignals.js'))
      ;({ declaredStateFromTitle } = await import('../config/opportunityJurisdiction.js'))
    } catch (err) {
      log.warn('unconfigured_profile_matches: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('UNCONFIGURED_PROFILE_PURGE_LIMIT', UNCONFIGURED_PROFILE_PURGE_LIMIT_DEFAULT)

    const { verdicts, skipped, candidates } = await loadUnconfiguredProfiles(db)
    if (skipped) return { scanned: 0, repaired: 0, enforced: true, skipped }

    // A place-DECLARING catalog row. SQL narrows to rows that could possibly
    // declare a place (a title with an em/en-dash place prefix, OR a stored
    // non-national state, OR a county) — never a post-LIMIT JS filter.
    let rows
    try {
      rows = await db
        .prepare(
          `SELECT m.id AS match_id, m.profile_id, o.title, o.state, o.geo_county, o.is_national
             FROM profile_opportunity_matches m
             JOIN funding_opportunities o ON o.id = m.opportunity_id
            WHERE (o.title LIKE '% — %' OR o.title LIKE '% – %' OR o.title LIKE '% -- %')
               OR o.geo_county IS NOT NULL
               OR (o.state IS NOT NULL AND LOWER(o.state) <> 'nationwide')`,
        )
        .all()
    } catch (err) {
      log.warn('unconfigured_profile_matches: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    // PLACE-EXCLUSIVE, deliberately NARROW: a row that names its OWN locality
    // (a county/city directory) or carries a county. A merely STATE-scoped
    // PROGRAM (Iowa Tuition Grant, Washington College Grant) is NOT included —
    // the engine's honest verdict for those against an unknown-state profile is
    // REVIEW ("confirm residency"), and overruling that here would delete real,
    // possibly-applicable awards on a geography argument that does not hold.
    // Measured against prod 2026-08-02T03:32Z: including the bare state column
    // would have swept 22 such programs off these two profiles.
    const declaresPlace = (row) => {
      if (declaredStateFromTitle(row)) return 'title_state'
      if (row.geo_county) return 'geo_county'
      return null
    }

    const violating = []
    for (const row of rows || []) {
      if (violating.length >= limit) break
      const prefix = placePrefixOfTitle(row.title)
      if (prefix && isPlaceholderPlaceLabel(prefix)) {
        violating.push({ ...row, why: 'fabricated_place', place: prefix })
        continue
      }
      if (!verdicts.has(row.profile_id)) continue
      const why = declaresPlace(row)
      if (!why) continue
      violating.push({ ...row, why: `unsupportable_place:${why}`, place: prefix || row.state })
    }

    const describe = (v) => `${v.title} [${v.why}]`
    const disabled = _parseBoolEnv(process.env.ENFORCE_UNCONFIGURED_PROFILE_SCOPE) === false
    if (disabled) {
      if (violating.length > 0) {
        log.warn('unconfigured profiles carry fabricated geography (purge DISABLED via ENFORCE_UNCONFIGURED_PROFILE_SCOPE=0)', {
          wouldRepair: violating.length,
          unconfiguredProfiles: verdicts.size,
          placeholderCandidates: candidates,
          scanned: rows?.length || 0,
          examples: violating.slice(0, 3).map(describe),
        })
      }
      return {
        scanned: rows?.length || 0,
        repaired: 0,
        wouldRepair: violating.length,
        unconfiguredProfiles: verdicts.size,
        placeholderCandidates: candidates,
        enforced: false,
      }
    }

    // "This profile was never filled in" is a STANDING fact, not a one-time log
    // line on the night it was noticed — report it every boot, with the named
    // prerequisites, even when there is nothing left to remove.
    for (const [profileId, verdict] of verdicts) {
      log.warn('profile is UNCONFIGURED — it declares nothing that can be searched for', {
        profileId,
        reason: verdict.reason,
        missing_prerequisites: verdict.missing_prerequisites,
      })
    }

    if (violating.length === 0) {
      return {
        scanned: rows?.length || 0,
        repaired: 0,
        unconfiguredProfiles: verdicts.size,
        placeholderCandidates: candidates,
        enforced: true,
      }
    }

    const ids = violating.map((v) => v.match_id)
    const CHUNK = 200
    let repaired = 0
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed fabricated/unsupportable geography from unconfigured profiles', {
      repaired,
      unconfiguredProfiles: verdicts.size,
      fabricatedPlace: violating.filter((v) => v.why === 'fabricated_place').length,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map(describe),
    })
    return {
      scanned: rows?.length || 0,
      repaired,
      unconfiguredProfiles: verdicts.size,
      placeholderCandidates: candidates,
      fabricatedPlace: violating.filter((v) => v.why === 'fabricated_place').length,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A STUDENT'S OWN SCHOOL'S AID REACHES THAT STUDENT
 * (2026-08-01, `institution_recall_miss` — Amy's only finding that was RED on
 * 21 of 21 cohort days, 290 occurrences).
 *
 * MEASURED READ-ONLY IN PROD, and the numbers are the whole argument:
 *  - 52 ACTIVE `Middle Tennessee State University` catalog rows (Peggy Perry
 *    Belcher Scholarship Fund, MTSU Guaranteed Scholarship, Buchanan
 *    Fellowship, …) carry **ZERO** match rows, for ANY profile — while
 *    Demo Tennessee STEM Student's `education.current_institution` IS
 *    "Middle Tennessee State University".
 *  - The same student's only university-sponsored matches are SEVEN
 *    `Wayne County Community College District` / `Wayne State University`
 *    (MICHIGAN) rows at scores 3–4, cross-matched onto **28 profiles**
 *    fleet-wide including nonprofits and a biolab. Both ends of one defect.
 *
 * THE ENGINE IS NOT THE DROP POINT. Replaying the REAL canonical engine on the
 * real pair (`services/matchEngine.computeMatchDecision`, Demo Student + "Peggy
 * Perry Belcher Scholarship Fund", her live profile row + all live sections)
 * returns **ACCEPT, score 100** — "Matches 70 of the profile's 70 data points",
 * "Geography: State match". The pair is simply never SCORED.
 *
 * WHY IT IS NEVER SCORED: `profile_opportunity_matches` is a ROLLING SNAPSHOT.
 * `crawlerOsPersistenceCore.persistRun` DELETEs a profile's
 * `crawler-os`/`crawler-os-xmatch` rows and re-inserts ONLY what THAT run
 * re-found. An institution scholarship is reachable ONLY through the open-web
 * lane keyed on the school's NAME (no registry source lists one school's
 * endowed funds), so the FIRST run of that profile that is registry-only — web
 * lane off, rate-limited, or simply no hits — erases the entire institution set
 * and nothing ever looks at the surviving catalog row again. Demo Student's 35
 * live `crawler-os` rows are ALL registry lanes (`benefits_gov`, `hrsa_*`,
 * `tn_benefits`, `findhelp_*`) and not one is from the web lane. Fleet-wide,
 * same measurement: `source='web_search'` holds **7,645 active catalog rows of
 * which 172 have EVER carried a match row (2.2%)**.
 *
 * THE FIX IS A LINK, NOT A LOWERED BAR. The ATTENDANCE gate
 * (`config/profileInstitutions.js`) only authorizes the engine to LOOK at a
 * pair; `services/matchEngine.js` remains the sole decision authority and a
 * REJECT is still dropped. Two narrowings keep this from becoming the
 * false-positive flood it is meant to cure:
 *   1. ATTENDANCE, NOT ASPIRATION — only `current_institution` /
 *      `current_school` / a COMMITTED university application / `schools.name`.
 *      `target_colleges` is deliberately excluded: Demo Student lists NINETEEN,
 *      and nineteen schools' aid is the flood. Aspiration still seeds discovery
 *      QUERIES; it just never authorizes a match.
 *   2. THE WHOLE NAME, NOT ONE WORD — bidirectional distinctive-token EQUALITY
 *      on the SPONSOR. "Wayne State University" and "Wayne County Community
 *      College District" share `wayne` and must not match; "Ohio University"
 *      and "Ohio State University" are different real schools.
 *
 * Rows are written as `matcher_version='institution-link'`, which the crawler-os
 * reconcile DELETE deliberately does not touch — the same reason `web-llm`
 * exists — so a registry-only crawl can no longer erase a student's own school.
 * ON CONFLICT DO NOTHING, so a profile's own `crawler-os` match always wins.
 *
 * Candidate discovery is a SQL PREDICATE (`LOWER(sponsor) LIKE` the
 * institution's longest distinctive token — a deliberate SUPERSET the JS gate
 * then adjudicates), never a post-LIMIT filter (#944 / the #1080 repeat).
 * Bounded: `INSTITUTION_AID_LINK_LIMIT` (500 writes/boot),
 * `INSTITUTION_AID_CANDIDATE_LIMIT` (500 catalog rows per institution).
 * `ENFORCE_INSTITUTION_AID_LINK=0` for count-only.
 *
 * CONVERGENCE: a profile whose school changed has its stale `institution-link`
 * rows removed — but ONLY when that profile's whole candidate set was processed
 * without hitting the write bound, so a truncated boot can never thrash.
 */
export async function enforceInstitutionAidLinkage(db) {
  return runInvariant('institution_aid_linkage', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let resolveAttendedInstitutions, opportunitySponsoredByInstitution, institutionSponsorLikePattern
    try {
      ;({ resolveAttendedInstitutions, opportunitySponsoredByInstitution, institutionSponsorLikePattern } =
        await import('../config/profileInstitutions.js'))
    } catch (err) {
      log.warn('institution_aid_linkage: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    // PREDICATE-narrowed profile set: only profiles that carry a section which
    // can name a school are ever candidates.
    let sectionRows
    try {
      sectionRows = await db
        .prepare(
          `SELECT profile_id, section_key, data
             FROM profile_sections
            WHERE section_key IN ('education', 'basic_information', 'university_applications')`,
        )
        .all()
    } catch (err) {
      log.warn('institution_aid_linkage: section query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }
    const sectionsByProfile = new Map()
    for (const row of sectionRows || []) {
      if (!row?.profile_id) continue
      if (!sectionsByProfile.has(row.profile_id)) sectionsByProfile.set(row.profile_id, {})
      let parsed = row.data
      if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed || '{}') } catch { parsed = {} } }
      sectionsByProfile.get(row.profile_id)[row.section_key] = parsed || {}
    }

    const attendedByProfile = new Map()
    for (const [profileId, sections] of sectionsByProfile) {
      const schools = resolveAttendedInstitutions(sections)
      if (schools.length > 0) attendedByProfile.set(profileId, schools)
    }
    if (attendedByProfile.size === 0) {
      return { scanned: 0, repaired: 0, profilesWithInstitution: 0, enforced: true }
    }

    const writeLimit = _boundedLimit('INSTITUTION_AID_LINK_LIMIT', 500)
    const candidateLimit = _boundedLimit('INSTITUTION_AID_CANDIDATE_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_INSTITUTION_AID_LINK) === false

    const { computeMatchDecision } = await import('../services/matchEngine.js')
    const nowFn = (db?.dialect || 'sqlite') === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let unscorable = 0
    let truncated = false
    const wouldLink = []
    const examples = []
    const eligibleByProfile = new Map()

    for (const [profileId, schools] of attendedByProfile) {
      if (linked + wouldLink.length >= writeLimit) { truncated = true; break }
      const ctx = await _loadProfileContextForInvariant(db, profileId)
      if (!ctx) continue
      const eligible = new Set()
      eligibleByProfile.set(profileId, eligible)

      for (const school of schools) {
        const pattern = institutionSponsorLikePattern(school)
        if (!pattern) continue
        let candidates
        try {
          candidates = await db
            .prepare(
              `SELECT * FROM funding_opportunities
                WHERE sponsor IS NOT NULL AND LOWER(sponsor) LIKE ?
                  AND (is_active IS NULL OR is_active = ${db?.dialect === 'postgres' ? 'TRUE' : '1'})
                LIMIT ?`,
            )
            .all(pattern.toLowerCase(), candidateLimit)
        } catch (err) {
          log.warn('institution_aid_linkage: candidate query failed (non-fatal)', { error: String(err?.message || err) })
          continue
        }
        for (const opp of candidates || []) {
          if (!opportunitySponsoredByInstitution(school, opp)) continue
          scanned += 1
          let decision
          try {
            decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
          } catch (err) {
            unscorable += 1
            log.warn('institution_aid_linkage: scoring failed (non-fatal)', {
              profile: profileId, opportunity: opp.id, error: String(err?.message || err),
            })
            continue
          }
          const verdict = String(decision?.decision ?? '').toUpperCase()
          // The engine stays the sole authority — a REJECT is a REJECT.
          if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
          eligible.add(opp.id)
          const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
          if (score === null) { unscorable += 1; continue }

          if (countOnly) {
            wouldLink.push({ profileId, opportunityId: opp.id })
            if (examples.length < 3) examples.push(`${opp.title} (${school}, ${verdict} ${score})`)
            if (wouldLink.length >= writeLimit) { truncated = true; break }
            continue
          }
          if (linked >= writeLimit) { truncated = true; break }
          try {
            const res = await db
              .prepare(
                `INSERT INTO profile_opportunity_matches
                   (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                    match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                    computed_at, updated_at, evaluated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'institution-link', ${nowFn}, ${nowFn}, ${nowFn})
                 ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
              )
              .run(
                `il:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
                decision?.explanation ?? null,
                JSON.stringify(decision?.matchedNeeds ?? []),
                JSON.stringify(buildPersistedMatchExplain(decision, { institution: school, gate: 'attendance' })),
                null, 'institution_attendance_link',
              )
            const wrote = changesOf(res)
            if (wrote > 0) {
              linked += 1
              if (examples.length < 3) examples.push(`${opp.title} (${school}, ${verdict} ${score})`)
            }
          } catch (err) {
            log.warn('institution_aid_linkage: insert failed (non-fatal)', {
              profile: profileId, opportunity: opp.id, error: String(err?.message || err),
            })
          }
        }
        if (truncated) break
      }
      if (truncated) break
    }

    // CONVERGENCE: drop institution-link rows the attendance gate no longer
    // authorizes (the student changed schools). Skipped entirely on a truncated
    // boot, so a bound-limited pass can never delete rows it never re-derived.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, eligible] of eligibleByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT id, opportunity_id FROM profile_opportunity_matches
                WHERE profile_id = ? AND matcher_version = 'institution-link'`,
            )
            .all(profileId)
          const doomed = (existing || []).filter((r) => !eligible.has(r.opportunity_id)).map((r) => r.id)
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence pass is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn("a student's own school's aid is not reaching them (linking DISABLED via ENFORCE_INSTITUTION_AID_LINK=0)", {
          wouldLink: wouldLink.length, scanned, examples,
        })
      }
      return {
        scanned,
        repaired: 0,
        wouldRepair: wouldLink.length,
        profilesWithInstitution: attendedByProfile.size,
        rejectedByEngine,
        truncated,
        enforced: false,
      }
    }
    if (linked > 0 || stale > 0) {
      log.info("linked students to their OWN institution's aid", {
        linked, stale, scanned, rejectedByEngine, unscorable, examples,
      })
    }
    return {
      scanned,
      repaired: linked,
      stale,
      profilesWithInstitution: attendedByProfile.size,
      rejectedByEngine,
      unscorable,
      truncated,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A CATALOG ROW THAT RECORDS THE PROFILE IT WAS DISCOVERED FOR IS
 * OFFERED TO THAT PROFILE (the rolling-snapshot erasure, fleet-wide edition).
 *
 * THE DEFECT. `profile_opportunity_matches` is a ROLLING SNAPSHOT:
 * `crawlerOsPersistenceCore.persistRun` DELETEs a profile's
 * `crawler-os`/`crawler-os-xmatch` rows and re-inserts only what THAT run
 * re-found. #1089 fixed the institution instance. Measured read-only in prod
 * 2026-08-01, the same shape holds fleet-wide and the decay is visible in the
 * data: of active `source='web_search'` catalog rows, those created in AUGUST
 * are 37% matched (73 of 197), July 3.2% (220 of 6,871) and June 3.9% (26 of
 * 661). Rows are scored once at discovery and then erased by the next run.
 *
 * WHY THIS SWEEP LINKS ONLY WHAT PROVENANCE NAMES. There is no recoverable
 * per-row record of WHICH profile a `web_search` row was found for:
 * `opportunity_sources` stores only `source_id='web_search'`, `raw_source_payload`
 * is NULL on all 7,729 rows, and the `source_query` that DID record the need
 * ("medical grants for individual Cleveland, TN") lives on the match row the
 * reconcile deleted. Every broader key was measured against the REAL engine in
 * prod and floods:
 *   - declared geography (state OR national) over `verified_real`: 7,581 pairs,
 *     5,393 links — e.g. "Georgia Senior Property Tax Exemptions" ACCEPTed for a
 *     Puerto Rico small-business owner.
 *   - canonical NEED intersection + geography over `web_search`: 23,422 pairs,
 *     14,822 links across 2,404 rows — e.g. "SBIR Phase II Cooperative
 *     Agreements" ACCEPT 33 for the same profile.
 *   - the same key over `school_portal`: 1,115 links, i.e. every school in the
 *     catalog offered to every student.
 * So the key here is the ONE fact the row itself records:
 * `funding_opportunities.profile_id`. 174 active prod rows carry it (113
 * `school_portal`, 61 `web_search`), each naming exactly one profile.
 *
 * THE ASPIRATION GUARD, and why it is not optional. 107 of those 113
 * `school_portal` rows were minted from ONE student's nineteen
 * `education.target_colleges` (Harvard, Oberlin, Michigan, Penn State …).
 * Linking on provenance alone would have re-admitted, through a different door,
 * exactly the aspiration set #1089 deliberately excluded. The guard reuses the
 * SAME registry (`config/profileInstitutions.js`) as that fix, so the two doors
 * cannot drift: a row an ASPIRATION school sponsors, that no ATTENDANCE school
 * also sponsors, is refused.
 *
 * The engine stays the sole authority — this only authorizes it to LOOK at a
 * pair the row's own provenance names, and a REJECT is never written. No score
 * bar is added or lowered; `config/matchSurfacing.qualifiesForDisplay` remains
 * the display rule.
 *
 * Candidate discovery is a SQL PREDICATE — the "already linked" exclusion is a
 * `NOT EXISTS` inside the query, never a post-LIMIT JS filter (#944 / #1080:
 * the signature of that bug is `scanned === LIMIT` forever).
 *
 * Bounded (`PROFILE_DISCOVERY_LINK_LIMIT`, default 500);
 * `ENFORCE_PROFILE_DISCOVERY_LINK=0` for count-only.
 */
export async function enforceProfileDiscoveredCatalogLinkage(db) {
  return runInvariant('profile_discovered_catalog_linkage', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let resolveAttendedInstitutions, resolveAspirationalInstitutions, opportunitySponsoredByInstitution
    try {
      ;({ resolveAttendedInstitutions, resolveAspirationalInstitutions, opportunitySponsoredByInstitution } =
        await import('../config/profileInstitutions.js'))
    } catch (err) {
      log.warn('profile_discovered_catalog_linkage: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    const trueLit = isPg ? 'TRUE' : '1'
    const writeLimit = _boundedLimit('PROFILE_DISCOVERY_LINK_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_PROFILE_DISCOVERY_LINK) === false

    // SQL PREDICATE: rows that RECORD a profile, are still active, and are not
    // already linked to that profile. The exclusion lives inside the query so a
    // bounded pass always advances instead of re-scanning its own bound.
    let candidates
    try {
      candidates = await db
        .prepare(
          `SELECT fo.* FROM funding_opportunities fo
            WHERE fo.profile_id IS NOT NULL
              AND (fo.is_active IS NULL OR fo.is_active = ${trueLit})
              AND NOT EXISTS (
                SELECT 1 FROM profile_opportunity_matches m
                 WHERE m.profile_id = fo.profile_id AND m.opportunity_id = fo.id
              )
            ORDER BY fo.created_at
            LIMIT ?`,
        )
        .all(writeLimit)
    } catch (err) {
      log.warn('profile_discovered_catalog_linkage: candidate query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const { computeMatchDecision } = await import('../services/matchEngine.js')
    const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let aspirationRefused = 0
    let orphanProfile = 0
    let unscorable = 0
    const truncated = (candidates?.length ?? 0) >= writeLimit
    const wouldLink = []
    const examples = []
    const ctxCache = new Map()
    const eligibleByProfile = new Map()

    for (const opp of candidates || []) {
      const profileId = opp.profile_id
      if (!ctxCache.has(profileId)) ctxCache.set(profileId, await _loadProfileContextForInvariant(db, profileId))
      const ctx = ctxCache.get(profileId)
      // A row naming a profile that no longer exists is counted, never guessed
      // onto some other profile.
      if (!ctx) { orphanProfile += 1; continue }
      if (!eligibleByProfile.has(profileId)) eligibleByProfile.set(profileId, new Set())

      // ASPIRATION NEVER AUTHORIZES (the #1089 rule, same registry).
      const attended = resolveAttendedInstitutions(ctx.sections)
      const aspirational = resolveAspirationalInstitutions(ctx.sections)
      const byAspiration = aspirational.some((s) => opportunitySponsoredByInstitution(s, opp))
      if (byAspiration && !attended.some((s) => opportunitySponsoredByInstitution(s, opp))) {
        aspirationRefused += 1
        continue
      }

      scanned += 1
      let decision
      try {
        decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
      } catch (err) {
        unscorable += 1
        log.warn('profile_discovered_catalog_linkage: scoring failed (non-fatal)', {
          profile: profileId, opportunity: opp.id, error: String(err?.message || err),
        })
        continue
      }
      const verdict = String(decision?.decision ?? '').toUpperCase()
      // The engine stays the sole authority — a REJECT is a REJECT.
      if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
      eligibleByProfile.get(profileId).add(opp.id)
      const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
      if (score === null) { unscorable += 1; continue }

      if (countOnly) {
        wouldLink.push({ profileId, opportunityId: opp.id })
        if (examples.length < 3) examples.push(`${opp.title} (${opp.source}, ${verdict} ${score})`)
        continue
      }
      try {
        const res = await db
          .prepare(
            `INSERT INTO profile_opportunity_matches
               (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                computed_at, updated_at, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'profile-discovery-link', ${nowFn}, ${nowFn}, ${nowFn})
             ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
          )
          .run(
            `pd:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
            decision?.explanation ?? null,
            JSON.stringify(decision?.matchedNeeds ?? []),
            JSON.stringify(buildPersistedMatchExplain(decision, { gate: 'recorded_discovery_provenance', source: opp.source ?? null })),
            null, 'profile_discovery_provenance',
          )
        const wrote = changesOf(res)
        if (wrote > 0) {
          linked += 1
          if (examples.length < 3) examples.push(`${opp.title} (${opp.source}, ${verdict} ${score})`)
        }
      } catch (err) {
        log.warn('profile_discovered_catalog_linkage: insert failed (non-fatal)', {
          profile: profileId, opportunity: opp.id, error: String(err?.message || err),
        })
      }
    }

    // CONVERGENCE: drop rows this gate no longer authorizes (the catalog row was
    // deactivated, its provenance was re-pointed, or an institution the profile
    // only ASPIRES to now sponsors it). Skipped entirely on a truncated boot so
    // a bound-limited pass can never delete rows it never re-derived, and only
    // for profiles this pass actually re-derived.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, eligible] of eligibleByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT m.id, m.opportunity_id
                 FROM profile_opportunity_matches m
                 LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'profile-discovery-link'
                  AND (fo.id IS NULL OR fo.profile_id IS NULL OR fo.profile_id <> m.profile_id
                       OR NOT (fo.is_active IS NULL OR fo.is_active = ${trueLit}))`,
            )
            .all(profileId)
          const doomed = (existing || []).filter((r) => !eligible.has(r.opportunity_id)).map((r) => r.id)
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence pass is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn('catalog rows that RECORD their profile are not reaching it (linking DISABLED via ENFORCE_PROFILE_DISCOVERY_LINK=0)', {
          wouldLink: wouldLink.length, scanned, aspirationRefused, examples,
        })
      }
      return {
        scanned,
        repaired: 0,
        wouldRepair: wouldLink.length,
        rejectedByEngine,
        aspirationRefused,
        orphanProfile,
        truncated,
        enforced: false,
      }
    }
    if (linked > 0 || stale > 0) {
      log.info('linked profiles to the catalog rows discovered FOR them', {
        linked, stale, scanned, rejectedByEngine, aspirationRefused, orphanProfile, unscorable, examples,
      })
    }
    return {
      scanned,
      repaired: linked,
      stale,
      rejectedByEngine,
      aspirationRefused,
      orphanProfile,
      unscorable,
      truncated,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A PROFILE'S DECLARED FIELD OF STUDY REACHES THE CATALOG ROWS THAT
 * NAME IT.
 *
 * THE DEFECT (2026-08-02, the owner's north-star rule: "It will determine the
 * need, run the correct crawlers, and use the profile information in finding the
 * funding source"). Demo Tennessee STEM Student's `education.intended_major` is "Forensic
 * Science". Measured read-only in prod:
 *
 *   forensic rows in the catalog       13 active — 1 carried a match row for her
 *   criminal-justice rows              12 active — 1
 *
 * and replaying the REAL `services/matchEngine.computeMatchDecision` on the
 * pairs nobody had ever scored returns **ACCEPT 83 for "AFTE Forensic Science
 * Scholarship"** and ACCEPT 79 for two more. The engine was never the drop
 * point — same finding as #1089/#1090. There was simply NO KEY that could reach
 * a topically-relevant row: `profile_opportunity_matches` is a rolling snapshot,
 * and every existing linkage gate keys on an INSTITUTION (#1089), on the row's
 * recorded provenance (#1090), or on what this run's web lane happened to
 * re-find. A subject a person declared they study was not a key at all.
 *
 * THE KEY IS A DECLARED FIELD, AND EVERY BROADER ONE WAS MEASURED AND FLOODS.
 * Replaying the real engine over real prod profiles + rows, 2026-08-02:
 *
 *   - in-state geography alone (row.state = profile.state, non-national):
 *     8,215 pairs -> 6,210 links across 18 profiles. Demo Student alone gains 632,
 *     including "Route 55 - DONELSON/DELL STATION OUTBOUND (shelter)" and
 *     "Nashville Chess Center (community centre)". REJECTED.
 *   - in-state + a student-aid title + the aid taxonomy: 240 pairs -> 217 links.
 *     Genuinely reaches TN HOPE (ACCEPT 100) and the Bradley County Bar
 *     Association Scholarship (ACCEPT 91) — but ALSO hands a high-school senior
 *     "Vanderbilt School of Medicine Merit Scholarship" (84), "Osher Reentry
 *     Scholarship" (84, for adults returning after a break) and "UAB Blazer
 *     Graduate Research Fellowship". NOT SHIPPED: the engine accepts those, so
 *     the missing gate is a STAGE-OF-LIFE eligibility rule inside the engine,
 *     not a recall key. `deriveStageOfLife` now supplies the fact that gate
 *     would need; the gate itself is a separate change with fleet-wide blast
 *     radius. Do not re-attempt this key without it.
 *   - mined `programs_services.keywords` as recall terms: 613 pairs -> 471
 *     links, dominated by one profile's "human services" matching 211 rows.
 *     REJECTED — a machine's paraphrase of prose is a search seed, not evidence.
 *
 * So the key is the narrow one the applicant TYPED about themselves:
 * `DERIVED_FACT_FIELDS` entries marked `recallSafe` (`education.intended_major`,
 * `education.major`, `student_portal_plan.major`, `education.interests`),
 * multi-word only, place-names and generic academic vocabulary excluded, matched
 * by TOKEN-BOUNDARY phrase containment against the row's TITLE and SPONSOR —
 * the curated identity fields. `description` is deliberately excluded: it is
 * unbounded prose, and it is what made "Bold.org — Housing & Living Expense
 * Scholarships" register as a forensic row (the #1089 "evidence is the SPONSOR
 * only" rule, one door over).
 *
 * MEASURED COST OF THIS KEY, fleet-wide on real prod data: 5 of 33 real profiles
 * declare such a term at all; 8 candidate rows enter the SQL superset; 6 survive
 * token-boundary adjudication; the engine ACCEPTs 4 and REJECTs 2. Four links.
 * That is the point — precision over volume, and the owner's bar is "a family
 * recognizes this as something that applies to them."
 *
 * The engine stays the sole authority: this only authorizes it to LOOK, and a
 * REJECT is never written. No score bar is added or lowered.
 *
 * Candidate discovery is a SQL PREDICATE (LIKE superset over title+sponsor),
 * never a post-`LIMIT` JS filter — `titleStatesTerm` adjudicates the returned
 * rows (#944 / #1080: the signature of that bug is `scanned === bound` forever).
 *
 * Bounded (`FIELD_OF_STUDY_LINK_LIMIT`, default 500);
 * `ENFORCE_FIELD_OF_STUDY_LINK=0` for count-only.
 */
export async function enforceDeclaredFieldOfStudyRecall(db) {
  return runInvariant('declared_field_of_study_recall', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let deriveProfileFacts, titleStatesTerm, termLikePattern
    try {
      ;({ deriveProfileFacts, titleStatesTerm, termLikePattern } =
        await import('../config/profileDerivedFacts.js'))
    } catch (err) {
      log.warn('declared_field_of_study_recall: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    const trueLit = isPg ? 'TRUE' : '1'
    const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
    const writeLimit = _boundedLimit('FIELD_OF_STUDY_LINK_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_FIELD_OF_STUDY_LINK) === false

    // ALL profiles — the match store is a rolling snapshot, so a producer-side
    // fix alone lands only after each profile's next crawl.
    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('declared_field_of_study_recall: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const { computeMatchDecision } = await import('../services/matchEngine.js')

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let adjudicatedOut = 0
    let unscorable = 0
    let profilesWithTerms = 0
    let truncated = false
    const wouldLink = []
    const examples = []
    // EVERY profile this pass examined, with the terms it CURRENTLY declares —
    // including profiles that now declare NONE. Convergence must re-adjudicate
    // existing links against these terms, NOT against the candidate set: the
    // candidate query excludes already-linked rows by design, so diffing
    // against it would delete every link on the very next boot.
    const termsByProfile = new Map()

    for (const row of profileIds || []) {
      if (linked + wouldLink.length >= writeLimit) { truncated = true; break }
      const profileId = row.id
      const ctx = await _loadProfileContextForInvariant(db, profileId)
      if (!ctx) continue
      let facts
      try { facts = deriveProfileFacts(ctx.profile, ctx.sections) } catch { continue }
      const terms = facts?.recallTerms ?? []
      termsByProfile.set(profileId, terms)
      if (terms.length === 0) continue
      profilesWithTerms += 1

      // SQL PREDICATE: a deliberate SUPERSET (substring LIKE over the two
      // curated identity fields), with the already-linked exclusion INSIDE the
      // query so a bounded pass always advances instead of re-scanning its bound.
      const patterns = terms.map((t) => termLikePattern(t.term)).filter(Boolean)
      if (patterns.length === 0) continue
      const orClauses = patterns
        .map(() => "(LOWER(fo.title) LIKE ? OR LOWER(COALESCE(fo.sponsor, '')) LIKE ?)")
        .join(' OR ')
      const params = []
      for (const p of patterns) params.push(p, p)
      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT fo.* FROM funding_opportunities fo
              WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND (${orClauses})
                AND NOT EXISTS (
                  SELECT 1 FROM profile_opportunity_matches m
                   WHERE m.profile_id = ? AND m.opportunity_id = fo.id
                )
              ORDER BY fo.created_at
              LIMIT ?`,
          )
          .all(...params, profileId, writeLimit)
      } catch (err) {
        log.warn('declared_field_of_study_recall: candidate query failed (non-fatal)', {
          profile: profileId, error: String(err?.message || err),
        })
        continue
      }

      for (const opp of candidates || []) {
        // TOKEN-BOUNDARY adjudication of the LIKE superset. `renal` must not hit
        // inside `adrenal` — the same rule the condition-coverage floor uses.
        const hay = `${opp.title ?? ''} ${opp.sponsor ?? ''}`
        const hit = terms.find((t) => titleStatesTerm(t.term, hay))
        if (!hit) { adjudicatedOut += 1; continue }
        scanned += 1
        let decision
        try {
          decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
        } catch (err) {
          unscorable += 1
          log.warn('declared_field_of_study_recall: scoring failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
          continue
        }
        const verdict = String(decision?.decision ?? '').toUpperCase()
        // The engine stays the sole authority — a REJECT is a REJECT.
        if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { unscorable += 1; continue }

        if (countOnly) {
          wouldLink.push({ profileId, opportunityId: opp.id })
          if (examples.length < 3) examples.push(`${opp.title} (${hit.term} <- ${hit.evidence}, ${verdict} ${score})`)
          continue
        }
        try {
          const res = await db
            .prepare(
              `INSERT INTO profile_opportunity_matches
                 (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                  match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                  computed_at, updated_at, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'field-of-study-link', ${nowFn}, ${nowFn}, ${nowFn})
               ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
            )
            .run(
              `fs:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
              decision?.explanation ?? null,
              JSON.stringify(decision?.matchedNeeds ?? []),
              // PROVENANCE: which profile field authorized this look.
              JSON.stringify(buildPersistedMatchExplain(decision, { gate: 'declared_field_of_study', term: hit.term, evidence: hit.evidence })),
              null, 'declared_field_of_study',
            )
          const wrote = changesOf(res)
          if (wrote > 0) {
            linked += 1
            if (examples.length < 3) examples.push(`${opp.title} (${hit.term} <- ${hit.evidence}, ${verdict} ${score})`)
          }
        } catch (err) {
          log.warn('declared_field_of_study_recall: insert failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
        }
      }
    }

    // CONVERGENCE: drop links this gate no longer authorizes — the student
    // changed major, dropped an interest, or the catalog row was deactivated.
    // Each surviving link is RE-ADJUDICATED against the profile's CURRENT terms
    // (not against the candidate set, which excludes already-linked rows), so a
    // steady state neither re-writes nor deletes anything. Skipped on a
    // truncated pass so a bound-limited boot can never delete rows it never
    // re-derived.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, terms] of termsByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT m.id, m.opportunity_id, fo.title, fo.sponsor, fo.is_active
                 FROM profile_opportunity_matches m
                 LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'field-of-study-link'`,
            )
            .all(profileId)
          const doomed = (existing || [])
            .filter((r) => {
              // Row gone or deactivated → the gate cannot authorize it.
              if (r.title === null && r.sponsor === null) return true
              if (!(r.is_active === null || r.is_active === undefined || r.is_active === 1 || r.is_active === true)) return true
              const hay = `${r.title ?? ''} ${r.sponsor ?? ''}`
              return !terms.some((t) => titleStatesTerm(t.term, hay))
            })
            .map((r) => r.id)
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence pass is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn("a profile's declared field of study is not reaching the catalog (linking DISABLED via ENFORCE_FIELD_OF_STUDY_LINK=0)", {
          wouldLink: wouldLink.length, scanned, profilesWithTerms, examples,
        })
      }
      return {
        scanned,
        repaired: 0,
        wouldRepair: wouldLink.length,
        profilesWithTerms,
        rejectedByEngine,
        adjudicatedOut,
        truncated,
        enforced: false,
      }
    }
    if (linked > 0 || stale > 0) {
      log.info('linked profiles to the funding their DECLARED field of study names', {
        linked, stale, scanned, profilesWithTerms, rejectedByEngine, adjudicatedOut, unscorable, examples,
      })
    }
    return {
      scanned,
      repaired: linked,
      stale,
      profilesWithTerms,
      rejectedByEngine,
      adjudicatedOut,
      unscorable,
      truncated,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: EVERY PROFILE IS MEASURED AGAINST ITS REQUESTED RESULT NUMBER, AND
 * A SHORTFALL BECOMES A STANDING INSTRUCTION TO SEARCH WIDER.
 *
 * THE OWNER RULE (2026-08-01, third clause of the crawler goal): "They will add
 * to the database returns that fall below the profile's requested result
 * number."
 *
 * THE DEFECT. A floor existed (`MIN_HEALTHY_SURFACED` = 3, judged on
 * `surfaced_actionable`) and an escalation loop existed (a `low_results` gap →
 * Anya brain → `buildWebQueries` broadening) and an actor existed (the nightly
 * `runProfileCoverageSweep` autoheal). All three keyed on a count that treats a
 * DIRECTORY as a result. Measured read-only in prod 2026-08-01 over all 33 real
 * profiles: 3,924 of 7,009 surfaced match rows are `directory`, every profile
 * reads 24–190 "results", and **0 of 33** fall below 3 — while, counting only
 * rows that name money the profile could receive:
 *
 *   min 0 · p25 7 · median 14 · p75 26 · max 86 — **11 of 33 below 10**
 *   Demo General Support Persona: 25 actionable, **0 awardable**  (and "healed" 2→4 that day)
 *   William:        24 actionable, **0 awardable**
 *
 * WHAT THIS SWEEP DOES, AND WHAT IT DELIBERATELY DOES NOT. It counts (no
 * network), resolves each profile's target from `config/profileResultFloor.js`,
 * and maintains the ledger that makes the backfill CONVERGE: attempts,
 * best-count-reached, a world fingerprint, and — once attempts are spent — an
 * EVIDENCED "exhausted" verdict that stops the nightly retry. It re-opens a
 * verdict when the catalog has materially grown or the cooldown has elapsed.
 *
 * It does NOT crawl. `runProfileDiscoveryLive` "legitimately runs for minutes"
 * (routes/realCrawlers.js) and the product's own user-facing route budgets 21s
 * and expects to lose that race; a boot invariant is the wrong place for it.
 * The ACTOR is the nightly sweep's heal queue, which this ledger gates and
 * orders — and a guard test asserts that consumer exists, because CLAUDE.md
 * records two separate write-only queues in this codebase already.
 *
 * IT CAN NEVER PAD. Nothing here admits a row, moves a score, or widens a gate:
 * a shortfall only ever causes more SEARCHING, and every hit still faces the
 * full reality-gate → match-engine stack. An honest 12 is reported as 12.
 *
 * Bounded (`RESULT_FLOOR_PROFILE_LIMIT`, default 500);
 * `ENFORCE_PROFILE_RESULT_FLOOR=0` for count-only (assess + log, no ledger write).
 */
export async function enforceProfileResultFloor(db) {
  return runInvariant('profile_result_floor', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }

    let ledgerApi
    let auditApi
    let floorCfg
    try {
      ledgerApi = await import('../services/coverageAudit/profileResultFloorLedger.js')
      auditApi = await import('../services/coverageAudit/profileResultCoverageAudit.js')
      floorCfg = await import('../config/profileResultFloor.js')
    } catch (err) {
      log.warn('profile_result_floor: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    // Read through the shared bound helper, but keep one literal reference to
    // `process.env.RESULT_FLOOR_PROFILE_LIMIT` in the file: the env-example
    // generator scans for that exact shape, and a dynamic `process.env[name]`
    // lookup alone leaves the bound undocumented in the checked-in templates.
    void process.env.RESULT_FLOOR_PROFILE_LIMIT
    const limit = _boundedLimit('RESULT_FLOOR_PROFILE_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_PROFILE_RESULT_FLOOR) === false

    let ledger = await ledgerApi.readFloorLedger(db)
    const activeCatalogCount = await ledgerApi.countActiveCatalogRows(db)

    // ALL real profiles — the audit's own profile query already excludes Amy
    // synthetics and deleted/inactive rows, and there is no LIMIT on the match
    // rows it counts, so this is a full census rather than a bounded scan.
    const { audits } = await auditApi.auditAllProfilesResultCoverage(db, { limit, ledger })

    let below = 0
    let exhaustedCount = 0
    let reopened = 0
    let servedClearing = 0
    let unconfigured = 0
    const shortfalls = []
    const unconfiguredProfiles = []

    for (const a of audits) {
      // A profile that was NEVER FILLED IN is not a shortfall to chase (2026-08-02).
      // It cannot be satisfied by any amount of crawling, so leaving it in the
      // below-target set would queue it for endless backfill — manufacturing
      // junk to hit a quota. Report it as its own class, with prerequisites.
      if (a.unconfigured) {
        unconfigured += 1
        if (unconfiguredProfiles.length < 10) {
          unconfiguredProfiles.push(
            `${a.display_name ?? a.profile_id}: ${(a.missing_prerequisites || []).slice(0, 3).join('; ')}`,
          )
        }
        continue
      }
      const assessment = ledgerApi.assessProfileFloor({
        profileId: a.profile_id,
        awardable: a.surfaced_awardable ?? 0,
        ledger,
        activeCatalogCount,
      })
      const prevEntry = ledger.profiles?.[a.profile_id] ?? null
      if (prevEntry?.exhausted_at && assessment.eligible) reopened += 1
      if (prevEntry?.exhausted_at && !assessment.below) servedClearing += 1
      if (assessment.below) {
        below += 1
        if (!assessment.eligible) exhaustedCount += 1
        if (shortfalls.length < 10) {
          shortfalls.push(
            `${a.display_name ?? a.profile_id}: ${assessment.awardable}/${assessment.target}` +
            (assessment.eligible ? '' : ` (${assessment.reason})`),
          )
        }
      }
      if (!countOnly) {
        ledger = ledgerApi.refreshFloorObservation(ledger, a.profile_id, {
          target: assessment.target,
          awardable: a.surfaced_awardable ?? 0,
          fingerprint: assessment.fingerprint,
        })
      }
    }

    if (countOnly) {
      if (below > 0) {
        log.warn('profiles are BELOW their requested result number (ledger write DISABLED via ENFORCE_PROFILE_RESULT_FLOOR=0)', {
          below, scanned: audits.length, examples: shortfalls,
        })
      }
      return {
        scanned: audits.length,
        repaired: 0,
        wouldRepair: below,
        belowTarget: below,
        unconfigured,
        fleetTarget: floorCfg.resolveFleetResultTarget(),
        enforced: false,
      }
    }

    const wrote = await ledgerApi.writeFloorLedger(db, ledger)
    if (unconfigured > 0) {
      // A standing fact, reported every boot: these profiles are BLOCKED on a
      // human, not on the crawlers. Silence here means every profile is
      // configured, never "we quietly stopped counting some of them".
      log.warn('profiles are UNCONFIGURED — excluded from the result floor until a human fills them in', {
        unconfigured, scanned: audits.length, examples: unconfiguredProfiles,
      })
    }
    if (below > 0) {
      log.info('result floor: profiles below their requested result number', {
        below, exhausted: exhaustedCount, reopened, scanned: audits.length,
        fleetTarget: floorCfg.resolveFleetResultTarget(), examples: shortfalls,
      })
    }
    return {
      scanned: audits.length,
      // `repaired` is the number of ledger entries refreshed — the unit of work
      // this sweep actually performs. It is NOT a count of results added; the
      // nightly heal queue is what adds those, and it reports them separately.
      repaired: wrote ? audits.length : 0,
      belowTarget: below,
      unconfigured,
      exhausted: exhaustedCount,
      reopened,
      servedClearing,
      fleetTarget: floorCfg.resolveFleetResultTarget(),
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A SURFACED MATCH IS AN AWARD THE PROFILE'S ACADEMIC STAGE CAN
 * ACTUALLY RECEIVE (2026-08-02).
 *
 * `makeDecision` now refuses a stage-barred pair per call, but the match store
 * is a ROLLING SNAPSHOT written by several producers, and the cross-profile
 * (xmatch) lane scores against a thesis stub that carries no sections at all —
 * so it derives no stage and the per-call gate correctly says nothing. A row
 * already persisted, or written by a context-less lane, is only reachable from
 * a sweep. Prod 2026-08-02, before this shipped: 3 live match rows across the
 * fleet ("Non-Traditional Lottery Scholarship" 80, "Tennessee Education Lottery
 * Scholarships for Non-Traditional Students" 79, "Graduate Assistantships" 34)
 * all on ONE 17-year-old dual-enrolled high-school senior.
 *
 * The MATCH is deleted, never the catalog row: a graduate fellowship is a real
 * opportunity for somebody, just not for this applicant. Silence is never a
 * denial — a row that states no stage is untouched, an unknown/absent profile
 * stage is neutral, and only stages that PROVABLY cannot occupy the declared
 * one are barred (`STAGE_REQUIREMENT_CLASSES[].barredStages`).
 *
 * Bounded by MATCH_SCOPE_PURGE_LIMIT (2000/boot);
 * ENFORCE_STAGE_OF_LIFE_SCOPE=0 for count-only.
 */
export async function enforceStageOfLifeMatchScope(db) {
  return runInvariant('stage_of_life_match_scope', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let deriveStageOfLife, stageOfLifeConflictForSections
    try {
      ;({ deriveStageOfLife } = await import('../config/profileDerivedFacts.js'))
      ;({ stageOfLifeConflictForSections } = await import(
        '../config/stageOfLifeEligibility.js'
      ))
    } catch (err) {
      log.warn('stage_of_life_match_scope: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_STAGE_OF_LIFE_SCOPE) === false

    // ALL profiles — the match store is a rolling snapshot, so a producer-side
    // gate alone lands only after each profile's next crawl.
    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('stage_of_life_match_scope: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    // The evidence columns this DB actually has. `title` is the only one that
    // is universal; the rest are probed so a schema that lacks one degrades to
    // "fewer fragments", never to a query error that silently no-ops the whole
    // sweep while it reads green (the #946/#954 schema-drift class).
    const oppCols = await listOpportunityColumns(db)
    const EVIDENCE_COLS = ['title', 'sponsor', 'description', 'eligibility_text', 'eligibility_bullets']
      .filter((c) => oppCols.size === 0 || oppCols.has(c))
    if (!EVIDENCE_COLS.includes('title')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    // Only the TEXT columns are LIKE-able; eligibility_bullets is a JSON array
    // string, which LIKE still matches usefully as a superset.
    let scanned = 0
    const violating = []
    let profilesWithStage = 0
    for (const row of profileIds || []) {
      if (violating.length >= limit) break
      const ctx = await _loadProfileContextForInvariant(db, row.id)
      if (!ctx) continue
      let stage = null
      try { stage = deriveStageOfLife(ctx.sections ?? {})?.value ?? null } catch { /* purpose still applies */ }
      if (stage && stage !== 'unclassified') profilesWithStage += 1
      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT m.id AS match_id, m.profile_id, m.opportunity_id, ${EVIDENCE_COLS.map((c) => `o.${c}`).join(', ')}
               FROM profile_opportunity_matches m
               JOIN funding_opportunities o ON o.id = m.opportunity_id
              WHERE m.profile_id = ?
              LIMIT ?`,
          )
          .all(row.id, limit)
      } catch (err) {
        log.warn('stage_of_life_match_scope: candidate query failed (non-fatal)', {
          profile: row.id, error: String(err?.message || err),
        })
        continue
      }
      for (const c of candidates || []) {
        scanned += 1
        const conflict = stageOfLifeConflictForSections(ctx.sections ?? {}, c)
        if (conflict) violating.push({ ...c, stage, conflict })
      }
    }

    const describe = (v) => `${v.title} (${v.conflict.classId}: "${v.conflict.phrase}" in ${v.conflict.field}; profile is ${v.stage})`
    if (countOnly) {
      if (violating.length > 0) {
        log.warn('awards the profile\'s academic stage cannot receive are surfaced (purge DISABLED via ENFORCE_STAGE_OF_LIFE_SCOPE=0)', {
          wouldRepair: violating.length, scanned, profilesWithStage, examples: violating.slice(0, 3).map(describe),
        })
      }
      return { scanned, repaired: 0, wouldRepair: violating.length, profilesWithStage, enforced: false }
    }
    if (violating.length === 0) return { scanned, repaired: 0, profilesWithStage, enforced: true }

    // A persisted mismatch must also leave Hamilton's active queue. Completed,
    // submitted and cancelled work is historical evidence and remains intact.
    let tasksCancelled = 0
    const reconciled = []
    try {
      const { cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')
      const terminal = ['submitted', 'completed', 'cancelled']
      for (const v of violating) {
        try {
          const ph = terminal.map(() => '?').join(', ')
          // Include grant-only legacy tasks whose grant links to this catalog
          // opportunity; ensureApplicationTask intentionally preserves these.
          let tasks = []
          try {
            tasks = await db.prepare(`SELECT DISTINCT t.id
              FROM application_tasks t
              LEFT JOIN grants g ON g.id = t.grant_id AND g.profile_id = t.profile_id
              WHERE t.profile_id = ?
                AND (t.opportunity_id = ? OR g.funding_opportunity_id = ?)
                AND t.status NOT IN (${ph})`).all(v.profile_id, v.opportunity_id, v.opportunity_id, ...terminal)
          } catch (selectErr) {
            // A deployment with NO application_tasks relation (or a schema
            // predating the joined columns) has no Hamilton queue to reconcile
            // against. That is "zero tasks to cancel", not a failed
            // reconciliation, and the match must still be repaired — retaining
            // it made the sweep report `repaired: 0` on every such database
            // (caught by stageOfLifeEligibility.test.js when this hardening was
            // rebased onto main, 2026-08-21). A failure DURING cancellation,
            // below, is a different fact and still retains the match.
            const msg = String(selectErr?.message || selectErr).toLowerCase()
            if (!(msg.includes('no such table') || msg.includes('no such column') || msg.includes('does not exist'))) throw selectErr
            tasks = []
          }
          for (const task of tasks || []) {
            await cancelApplicationTask(db, task.id, { actorRole: 'system', reason: v.conflict.reason })
            tasksCancelled += 1
          }
          reconciled.push(v)
        } catch (err) {
          // Retain this match as the durable retry handle. Other violations are
          // isolated and can still reconcile during the same boot.
          log.warn('stage_of_life_match_scope: task reconciliation failed; retaining match', {
            matchId: v.match_id, error: String(err?.message || err),
          })
        }
      }
    } catch (err) {
      log.warn('stage_of_life_match_scope: task reconciliation unavailable (non-fatal)', { error: String(err?.message || err) })
    }
    const ids = reconciled.map((v) => v.match_id)
    let repaired = 0
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed matches to awards the profile\'s academic stage cannot receive', {
      repaired,
      tasksCancelled,
      scanned,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map(describe),
    })
    return {
      scanned,
      repaired,
      profilesWithStage,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A SURFACED AWARD MATCHES THE PROFILE'S FIELD OF STUDY
 * (2026-08-23 — the field-of-study twin of enforceStageOfLifeMatchScope).
 *
 * The per-call gate `fieldOfStudyConflict` lives in `makeDecision`, but the
 * match store is a ROLLING SNAPSHOT, so a producer-side gate alone lands only
 * after each profile's next crawl. This net purges the already-stored matches to
 * awards a profile's DECLARED major provably cannot receive (a "Nursing
 * Scholarship" for a Paramedic major). Measured on the 12 crawled profiles
 * 2026-08-23: 18 such matches, every one a correct removal (Robert the paramedic
 * carried Engineering/Nursing/Physician/CS/Teaching/Aviation awards; the 10
 * profiles with no declared vocational major were untouched). Silence is neutral
 * on both sides; only a provable specific-vs-specific mismatch is removed.
 */
export async function enforceFieldOfStudyMatchScope(db) {
  return runInvariant('field_of_study_match_scope', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    // SCOPE-AWARE (Stage-2 slice 1): the boot net uses the same applicant-scoped
    // check as makeDecision, so it never purges a match whose field word is only
    // in the SPONSOR's name (the #1360 over-rejection).
    let fieldOfStudyConflict
    try {
      ;({ fieldOfStudyApplicantConflict: fieldOfStudyConflict } = await import('../config/sourceClaims/core.js'))
    } catch (err) {
      log.warn('field_of_study_match_scope: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const limit = _boundedLimit('MATCH_SCOPE_PURGE_LIMIT', MATCH_SCOPE_PURGE_LIMIT_DEFAULT)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_FIELD_OF_STUDY_SCOPE) === false

    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('field_of_study_match_scope: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const oppCols = await listOpportunityColumns(db)
    // Only title + sponsor carry the field requirement (identity fields); the
    // gate reads no others, so the sweep need not fetch more.
    const EVIDENCE_COLS = ['title', 'sponsor'].filter((c) => oppCols.size === 0 || oppCols.has(c))
    if (!EVIDENCE_COLS.includes('title')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let scanned = 0
    const violating = []
    let profilesWithField = 0
    for (const row of profileIds || []) {
      if (violating.length >= limit) break
      const ctx = await _loadProfileContextForInvariant(db, row.id)
      if (!ctx) continue
      let hasField = false
      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT m.id AS match_id, m.profile_id, m.opportunity_id, ${EVIDENCE_COLS.map((c) => `o.${c}`).join(', ')}
               FROM profile_opportunity_matches m
               JOIN funding_opportunities o ON o.id = m.opportunity_id
              WHERE m.profile_id = ?
              LIMIT ?`,
          )
          .all(row.id, limit)
      } catch (err) {
        log.warn('field_of_study_match_scope: candidate query failed (non-fatal)', {
          profile: row.id, error: String(err?.message || err),
        })
        continue
      }
      for (const c of candidates || []) {
        scanned += 1
        const conflict = fieldOfStudyConflict(ctx.sections ?? {}, c)
        if (conflict) { violating.push({ ...c, conflict }); hasField = true }
      }
      if (hasField) profilesWithField += 1
    }

    const describe = (v) => `${v.title} (${v.conflict.classId}: "${v.conflict.phrase}" in ${v.conflict.field})`
    if (countOnly) {
      if (violating.length > 0) {
        log.warn('awards outside the profile\'s declared field of study are surfaced (purge DISABLED via ENFORCE_FIELD_OF_STUDY_SCOPE=0)', {
          wouldRepair: violating.length, scanned, examples: violating.slice(0, 3).map(describe),
        })
      }
      return { scanned, repaired: 0, wouldRepair: violating.length, enforced: false }
    }
    if (violating.length === 0) return { scanned, repaired: 0, enforced: true }

    let tasksCancelled = 0
    const reconciled = []
    try {
      const { cancelApplicationTask } = await import('../services/hamilton/applicationTaskStore.js')
      const terminal = ['submitted', 'completed', 'cancelled']
      for (const v of violating) {
        try {
          const ph = terminal.map(() => '?').join(', ')
          let tasks = []
          try {
            tasks = await db.prepare(`SELECT DISTINCT t.id
              FROM application_tasks t
              LEFT JOIN grants g ON g.id = t.grant_id AND g.profile_id = t.profile_id
              WHERE t.profile_id = ?
                AND (t.opportunity_id = ? OR g.funding_opportunity_id = ?)
                AND t.status NOT IN (${ph})`).all(v.profile_id, v.opportunity_id, v.opportunity_id, ...terminal)
          } catch (selectErr) {
            const msg = String(selectErr?.message || selectErr).toLowerCase()
            if (!(msg.includes('no such table') || msg.includes('no such column') || msg.includes('does not exist'))) throw selectErr
            tasks = []
          }
          for (const task of tasks || []) {
            await cancelApplicationTask(db, task.id, { actorRole: 'system', reason: v.conflict.reason })
            tasksCancelled += 1
          }
          reconciled.push(v)
        } catch (err) {
          log.warn('field_of_study_match_scope: task reconciliation failed; retaining match', {
            matchId: v.match_id, error: String(err?.message || err),
          })
        }
      }
    } catch (err) {
      log.warn('field_of_study_match_scope: task reconciliation unavailable (non-fatal)', { error: String(err?.message || err) })
    }
    const ids = reconciled.map((v) => v.match_id)
    let repaired = 0
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200)
      const ph = slice.map(() => '?').join(', ')
      const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
      repaired += changesOf(res) || slice.length
    }
    log.info('removed matches to awards outside the profile\'s declared field of study', {
      repaired, tasksCancelled, scanned,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      examples: violating.slice(0, 3).map(describe),
    })
    return {
      scanned,
      repaired,
      profilesWithField,
      profilesAffected: new Set(violating.map((v) => v.profile_id)).size,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: A STUDENT'S OWN STATE'S STUDENT AID REACHES THAT STUDENT
 * (2026-08-02 — the other half of the stage-gate work).
 *
 * MEASURED READ-ONLY IN PROD. Demo Tennessee STEM Student is a TN dual-enrolled high-school
 * senior. The catalog holds 21 active TN HOPE rows; she matched **ZERO**.
 * Replaying the REAL `computeMatchDecision` on the pair nobody had ever scored
 * returns **ACCEPT 100 — "Matches 70 of the profile's 70 data points"**. The
 * engine was never the drop point (the #1089/#1090/#1091 finding again): there
 * was no KEY that could reach her state's flagship award.
 *
 * WHY THIS COULD NOT SHIP BEFORE THE STAGE GATE. #1091 measured this exact key
 * and refused it: in-state + a student-aid title + the aid taxonomy reached TN
 * HOPE, but it ALSO handed a 17-year-old "Vanderbilt School of Medicine Merit
 * Scholarship" (ACCEPT 84) and "Osher Reentry Scholarship" (ACCEPT 84, for
 * returning adults) — and the engine accepted those too. The missing piece was
 * a stage-of-life eligibility gate INSIDE the engine, which now exists
 * (`config/stageOfLifeEligibility.js`), so this key's rejects are the engine's.
 *
 * THE ANCHOR IS A NAMED STATE, NOT A STATE COLUMN. Measured on real prod pairs
 * with the real engine, 2026-08-02:
 *
 *   bare in-state student-aid (`fo.state = profile state`)   → 208 links
 *   …plus: title or sponsor NAMES the state                  →  85 links
 *
 * The 123 links the anchor drops are the flood: `funding_opportunities.state`
 * is stamped by whichever profile's crawl found the row, so a TN student's
 * "in-state" set carried seven Cuyahoga Community College (Ohio) awards and
 * five from Cleveland University-KANSAS CITY. A row whose own title or sponsor
 * says "Tennessee" is making a claim about itself; a state column is making a
 * claim about a crawl. Demo Student's 13 anchored links are TN HOPE (ACCEPT 100),
 * TN Promise, the TN General Assembly Merit Scholarship, Education Freedom
 * Scholarship Act, TN STEP UP, and UT-Chattanooga awards.
 *
 * The gate authorizes a LOOK; `computeMatchDecision` still decides and a REJECT
 * is never written. Bounded by STUDENT_AID_INSTATE_LINK_LIMIT (500/boot);
 * ENFORCE_STUDENT_AID_INSTATE_LINK=0 for count-only.
 */
export async function enforceStudentAidInStateRecall(db) {
  return runInvariant('student_aid_instate_recall', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let deriveProfileFacts, titleStatesTerm, classifyAidType, STUDENT_AID_TITLE_LIKE_PATTERNS, STATE_REGISTRY
    try {
      ;({ deriveProfileFacts, titleStatesTerm } = await import('../config/profileDerivedFacts.js'))
      ;({ classifyAidType, STUDENT_AID_TITLE_LIKE_PATTERNS } = await import('../config/aidTypePreferences.js'))
      ;({ STATE_REGISTRY } = await import('../services/shared/data/stateRegistry.js'))
    } catch (err) {
      log.warn('student_aid_instate_recall: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    const trueLit = isPg ? 'TRUE' : '1'
    const falseLit = isPg ? 'FALSE' : '0'
    const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
    const writeLimit = _boundedLimit('STUDENT_AID_INSTATE_LINK_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_STUDENT_AID_INSTATE_LINK) === false

    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('student_aid_instate_recall: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const { computeMatchDecision } = await import('../services/matchEngine.js')

    // ACCEPTED aid classes for this key: the two the taxonomy calls an AWARD a
    // student competes for. 'grant' is deliberately excluded — measured, it
    // more than doubles the link count (208 → 423 unanchored) by admitting
    // every in-state programme grant whose title happens to contain the word.
    const ACCEPTED_AID = new Set(['scholarship', 'endowment'])

    const titleLike = STUDENT_AID_TITLE_LIKE_PATTERNS
      .map(() => "LOWER(COALESCE(fo.title,'')) LIKE ?").join(' OR ')

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let adjudicatedOut = 0
    let unscorable = 0
    let profilesEligible = 0
    let truncated = false
    const wouldLink = []
    const examples = []
    // Every profile examined, with the anchor it CURRENTLY has (null when the
    // profile no longer qualifies), so convergence re-adjudicates existing links
    // against the profile's own facts — NOT against the candidate set, which
    // excludes already-linked rows and would delete every link next boot
    // (the bug `declaredFieldOfStudyRecall.test.js`'s idempotence test caught).
    const anchorByProfile = new Map()

    for (const row of profileIds || []) {
      if (linked + wouldLink.length >= writeLimit) { truncated = true; break }
      const profileId = row.id
      const ctx = await _loadProfileContextForInvariant(db, profileId)
      if (!ctx) continue
      let facts
      try { facts = deriveProfileFacts(ctx.profile, ctx.sections) } catch { continue }
      const stage = facts?.stageOfLife?.value ?? null
      const state = String(facts?.place?.state || '').toUpperCase()
      const stateName = String(STATE_REGISTRY?.[state]?.name || '')
      // STUDENT AID needs a STUDENT: a profile that states no academic stage is
      // not given a student-aid key at all (silence buys nothing, in either
      // direction). A profile with no resolvable state loses nothing either.
      const qualifies = Boolean(stage) && stage !== 'unclassified' && Boolean(stateName)
      anchorByProfile.set(profileId, qualifies ? stateName : null)
      if (!qualifies) continue
      profilesEligible += 1

      const namePattern = `%${stateName.toLowerCase()}%`
      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT fo.* FROM funding_opportunities fo
              WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND UPPER(COALESCE(fo.state,'')) = ?
                AND (fo.is_national IS NULL OR fo.is_national = ${falseLit})
                AND (LOWER(COALESCE(fo.title,'')) LIKE ? OR LOWER(COALESCE(fo.sponsor,'')) LIKE ?)
                AND (${titleLike})
                AND NOT EXISTS (
                  SELECT 1 FROM profile_opportunity_matches m
                   WHERE m.profile_id = ? AND m.opportunity_id = fo.id
                )
              ORDER BY fo.created_at
              LIMIT ?`,
          )
          .all(state, namePattern, namePattern, ...STUDENT_AID_TITLE_LIKE_PATTERNS, profileId, writeLimit)
      } catch (err) {
        log.warn('student_aid_instate_recall: candidate query failed (non-fatal)', {
          profile: profileId, error: String(err?.message || err),
        })
        continue
      }

      for (const opp of candidates || []) {
        // TOKEN-BOUNDARY adjudication of the LIKE superset, and the aid
        // taxonomy read from the row's own IDENTITY fields only (title +
        // sponsor) — never description prose (#1086 / the aid-gate rule).
        const hay = `${opp.title ?? ''} ${opp.sponsor ?? ''}`
        if (!titleStatesTerm(stateName, hay)) { adjudicatedOut += 1; continue }
        if (!ACCEPTED_AID.has(classifyAidType({ title: opp.title, description: opp.sponsor }))) {
          adjudicatedOut += 1
          continue
        }
        scanned += 1
        let decision
        try {
          decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
        } catch (err) {
          unscorable += 1
          log.warn('student_aid_instate_recall: scoring failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
          continue
        }
        const verdict = String(decision?.decision ?? '').toUpperCase()
        if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { unscorable += 1; continue }

        if (countOnly) {
          wouldLink.push({ profileId, opportunityId: opp.id })
          if (examples.length < 3) examples.push(`${opp.title} (${stateName}, ${verdict} ${score})`)
          continue
        }
        try {
          const res = await db
            .prepare(
              `INSERT INTO profile_opportunity_matches
                 (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                  match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                  computed_at, updated_at, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'student-aid-instate-link', ${nowFn}, ${nowFn}, ${nowFn})
               ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
            )
            .run(
              `sa:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
              decision?.explanation ?? null,
              JSON.stringify(decision?.matchedNeeds ?? []),
              JSON.stringify(buildPersistedMatchExplain(decision, { gate: 'student_aid_instate', state: stateName, stage, evidence: 'basic_information.location' })),
              null, 'student_aid_instate',
            )
          const wrote = changesOf(res)
          if (wrote > 0) {
            linked += 1
            if (examples.length < 3) examples.push(`${opp.title} (${stateName}, ${verdict} ${score})`)
          }
        } catch (err) {
          log.warn('student_aid_instate_recall: insert failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
        }
      }
    }

    // CONVERGENCE: the student moved state, stopped being a student, or the row
    // was deactivated → the gate no longer authorizes the link. Skipped on a
    // truncated pass so a bound-limited boot never deletes what it never
    // re-derived.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, stateName] of anchorByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT m.id, fo.title, fo.sponsor, fo.is_active
                 FROM profile_opportunity_matches m
                 LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'student-aid-instate-link'`,
            )
            .all(profileId)
          const doomed = (existing || [])
            .filter((r) => {
              if (!stateName) return true
              if (r.title === null && r.sponsor === null) return true
              if (!(r.is_active === null || r.is_active === undefined || r.is_active === 1 || r.is_active === true)) return true
              return !titleStatesTerm(stateName, `${r.title ?? ''} ${r.sponsor ?? ''}`)
            })
            .map((r) => r.id)
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn("a student's own state's aid is not reaching them (linking DISABLED via ENFORCE_STUDENT_AID_INSTATE_LINK=0)", {
          wouldLink: wouldLink.length, scanned, profilesEligible, examples,
        })
      }
      return {
        scanned,
        repaired: 0,
        wouldRepair: wouldLink.length,
        profilesEligible,
        rejectedByEngine,
        adjudicatedOut,
        truncated,
        enforced: false,
      }
    }
    if (linked > 0 || stale > 0) {
      log.info("linked students to their own state's student aid", {
        linked, stale, scanned, profilesEligible, rejectedByEngine, adjudicatedOut, unscorable, examples,
      })
    }
    return {
      scanned,
      repaired: linked,
      stale,
      profilesEligible,
      rejectedByEngine,
      adjudicatedOut,
      unscorable,
      truncated,
      enforced: true,
    }
  })
}

/**
 * INVARIANT: LOCAL CRISIS HELP THAT ALREADY EXISTS REACHES THE HOUSEHOLD IN
 * THAT COUNTY ("found but never surfaced" — the other half of the persona
 * failure; #1095 adds the missing source LANES, this net surfaces the rows the
 * catalog already holds).
 *
 * Measured read-only in prod, 2026-08-02T04:59Z. 416 active eviction/rental
 * rows carry 16 match rows between them; homelessness 282→13, utilities
 * 252→22, food 176→9, foreclosure 95→30. The concrete pair: Demo Housing
 * Applicant (family, North Ridgeville OH 44039 = Lorain County, declared need
 * `housing`) vs "Love INC Lorain County – Emergency Housing & Rent Assistance".
 * The REAL `computeMatchDecision` returns **ACCEPT 100** and the match store
 * held NO ROW — NEVER SCORED, not scored-and-rejected. Seven more local
 * county's awardable rows sat in the same state (HEAP 69, CHIP 62, Catholic
 * Charities Housing Services 50, the county Children & Families Mini Grant 55).
 * What DID reach her were three findhelp / USA.gov / HUD DIRECTORY pointers.
 *
 * WHY NOTHING RE-FINDS THEM: `crawlerOsPersistenceCore.persistRun` DELETEs a
 * profile's `crawler-os` / `crawler-os-xmatch` rows every run and re-inserts
 * only what THAT run re-produced. A row discovered on another day, for another
 * profile in the same county, is never re-offered. Her three surviving matches
 * are all `crawler-os`. Do NOT "fix" that by making the reconcile keep rows —
 * the snapshot protects the matches view from stale/ineligible rows by design.
 * The fix is a linkage gate with its own matcher_version, which the reconcile's
 * DELETE does not name.
 *
 * THE KEY IS A REAL PLACE. Measured with the real engine on real prod pairs:
 *
 *   bare in-state (fo.state = profile state)      11,628 candidate rows
 *   county TOKEN + state                             369 scanned
 *   county PHRASE "<County> County" + state           280 scanned
 *   …+ row serves a need the profile DECLARES          41 scanned → 21 linked
 *
 * Bare in-state was measured at 5,393 / 6,210 / 218 links in three earlier
 * attempts and rejected every time. Three independent conditions make
 * cross-state leakage (the Raleigh County WV → Raleigh NC class) impossible:
 * the phrase is "<County> County" and a City-of-Raleigh grant never writes it;
 * `fo.state` must equal the profile's state; and a title declaring its own
 * state in the canonical `"<Place>, XX — "` shape must declare THIS state.
 *
 * PRECISION, NOT VOLUME. Only ACCEPT is written — a REVIEW is the locator band
 * and pointers already flood these households (`isPointerKind` rows are
 * excluded from the candidate set outright). A person facing eviction who
 * receives an Eldercare Locator is worse served than one who receives nothing.
 *
 * The gate authorizes a LOOK; `computeMatchDecision` still decides. Bounded by
 * COUNTY_CRISIS_LINK_LIMIT (500/boot); ENFORCE_COUNTY_CRISIS_RECALL=0 for
 * count-only.
 */
export async function enforceCountyCrisisNeedRecall(db) {
  return runInvariant('county_crisis_need_recall', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let deriveProfileFacts, crisis, normalizeOpportunity, isPointerKind
    let normalizeNeedCategory, NEED_ALIAS_MAP
    try {
      ;({ deriveProfileFacts } = await import('../config/profileDerivedFacts.js'))
      crisis = await import('../config/crisisNeedRecall.js')
      ;({ normalizeOpportunity } = await import('../services/matchEngine.js'))
      ;({ isPointerKind } = await import('../config/opportunityKindClasses.js'))
      ;({ normalizeNeedCategory, NEED_ALIAS_MAP } = await import('../services/profileNormalizer.js'))
    } catch (err) {
      log.warn('county_crisis_need_recall: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    const trueLit = isPg ? 'TRUE' : '1'
    const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
    const writeLimit = _boundedLimit('COUNTY_CRISIS_LINK_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_COUNTY_CRISIS_RECALL) === false

    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('county_crisis_need_recall: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const { computeMatchDecision } = await import('../services/matchEngine.js')

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let adjudicatedOut = 0
    let needMiss = 0
    let unscorable = 0
    let profilesEligible = 0
    let truncated = false
    const wouldLink = []
    const examples = []
    // Every profile examined, with the anchor it CURRENTLY has (null when the
    // profile no longer qualifies), so convergence re-adjudicates existing links
    // against the profile's own facts — NOT against the candidate set, which
    // excludes already-linked rows and would delete every link next boot.
    const anchorByProfile = new Map()

    for (const row of profileIds || []) {
      if (linked + wouldLink.length >= writeLimit) { truncated = true; break }
      const profileId = row.id
      const ctx = await _loadProfileContextForInvariant(db, profileId)
      if (!ctx) continue
      let anchor = null
      let crisisNeeds = new Set()
      try {
        const facts = deriveProfileFacts(ctx.profile, ctx.sections)
        anchor = crisis.resolveProfileCountyAnchor(facts?.place)
        // DECLARED, not inferred: `normalizeProfile().needCategories` returns a
        // type-shaped fallback for an EMPTY household profile, and
        // `signals.needs` mints a need from its own DENIAL (the #1095 class).
        crisisNeeds = crisis.declaredCrisisNeeds(ctx.profile, ctx.sections, normalizeNeedCategory, NEED_ALIAS_MAP)
      } catch { anchor = null }
      // A CRISIS need and a REAL county are BOTH required. A profile that
      // states neither loses nothing; a profile that states only a state gets
      // nothing from this gate (bare in-state is the measured flood).
      const qualifies = Boolean(anchor) && crisisNeeds.size > 0
      anchorByProfile.set(profileId, qualifies ? anchor : null)
      if (!qualifies) continue
      profilesEligible += 1

      const like = crisis.countyLikePattern(anchor.county)
      if (!like) continue
      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT fo.* FROM funding_opportunities fo
              WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND UPPER(COALESCE(fo.state,'')) = ?
                AND (LOWER(COALESCE(fo.title,'')) LIKE ? OR LOWER(COALESCE(fo.sponsor,'')) LIKE ?)
                AND NOT EXISTS (
                  SELECT 1 FROM profile_opportunity_matches m
                   WHERE m.profile_id = ? AND m.opportunity_id = fo.id
                )
              ORDER BY fo.created_at
              LIMIT ?`,
          )
          .all(anchor.state, like, like, profileId, writeLimit)
      } catch (err) {
        log.warn('county_crisis_need_recall: candidate query failed (non-fatal)', {
          profile: profileId, error: String(err?.message || err),
        })
        continue
      }

      for (const opp of candidates || []) {
        // TOKEN-BOUNDARY adjudication of the LIKE superset, read from the row's
        // own IDENTITY fields only (title + sponsor), plus the declared-state
        // refusal that makes the Raleigh WV / Raleigh NC leak impossible.
        if (!crisis.rowNamesProfileCounty(opp, anchor.county, anchor.state)) { adjudicatedOut += 1; continue }
        // A pointer promises a place to look, never an award, and these
        // households are already drowning in pointers.
        if (isPointerKind(opp.opportunity_kind)) { adjudicatedOut += 1; continue }
        let oppNorm = null
        try { oppNorm = normalizeOpportunity(opp) } catch { oppNorm = null }
        if (!crisis.rowServesCrisisNeed(oppNorm?.needTypesSupported, crisisNeeds)) { needMiss += 1; continue }
        scanned += 1
        let decision
        try {
          decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
        } catch (err) {
          unscorable += 1
          log.warn('county_crisis_need_recall: scoring failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
          continue
        }
        // ACCEPT ONLY. REVIEW is the locator/recommendation band and this gate
        // exists to surface AWARDABLE local help, not more things to look at.
        if (String(decision?.decision ?? '').toUpperCase() !== 'ACCEPT') { rejectedByEngine += 1; continue }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { unscorable += 1; continue }

        if (countOnly) {
          wouldLink.push({ profileId, opportunityId: opp.id })
          if (examples.length < 3) examples.push(`${opp.title} (${anchor.county} County ${anchor.state}, ACCEPT ${score})`)
          continue
        }
        try {
          const res = await db
            .prepare(
              `INSERT INTO profile_opportunity_matches
                 (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                  match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                  computed_at, updated_at, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'county-crisis-need-link', ${nowFn}, ${nowFn}, ${nowFn})
               ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
            )
            .run(
              `cc:${profileId}:${opp.id}`, profileId, opp.id, score, 'accept',
              decision?.explanation ?? null,
              JSON.stringify(decision?.matchedNeeds ?? []),
              JSON.stringify(buildPersistedMatchExplain(decision, {
                gate: 'county_crisis_need',
                county: anchor.county,
                state: anchor.state,
                anchor_via: anchor.via,
                needs: [...crisisNeeds],
                evidence: 'basic_information.location',
              })),
              null, 'county_crisis_need',
            )
          const wrote = changesOf(res)
          if (wrote > 0) {
            linked += 1
            if (examples.length < 3) examples.push(`${opp.title} (${anchor.county} County ${anchor.state}, ACCEPT ${score})`)
          }
        } catch (err) {
          log.warn('county_crisis_need_recall: insert failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
        }
      }
    }

    // CONVERGENCE: the household moved county, stopped declaring a crisis need,
    // or the row was deactivated → the gate no longer authorizes the link.
    // Skipped on a truncated pass so a bound-limited boot never deletes what it
    // never re-derived.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, anchor] of anchorByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT m.id, fo.title, fo.sponsor, fo.is_active
                 FROM profile_opportunity_matches m
                 LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'county-crisis-need-link'`,
            )
            .all(profileId)
          const doomed = (existing || [])
            .filter((r) => {
              if (!anchor) return true
              if (r.title === null && r.sponsor === null) return true
              if (!(r.is_active === null || r.is_active === undefined || r.is_active === 1 || r.is_active === true)) return true
              return !crisis.rowNamesProfileCounty(r, anchor.county, anchor.state)
            })
            .map((r) => r.id)
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn('local crisis help is not reaching the household in that county (linking DISABLED via ENFORCE_COUNTY_CRISIS_RECALL=0)', {
          wouldLink: wouldLink.length, scanned, profilesEligible, examples,
        })
      }
      return {
        scanned,
        repaired: 0,
        wouldRepair: wouldLink.length,
        profilesEligible,
        rejectedByEngine,
        adjudicatedOut,
        needMiss,
        truncated,
        enforced: false,
      }
    }
    if (linked > 0 || stale > 0) {
      log.info('linked households to their own county\'s crisis help', {
        linked, stale, scanned, profilesEligible, rejectedByEngine, adjudicatedOut, needMiss, unscorable, examples,
      })
    }
    return {
      scanned,
      repaired: linked,
      stale,
      profilesEligible,
      rejectedByEngine,
      adjudicatedOut,
      needMiss,
      unscorable,
      truncated,
      enforced: true,
    }
  })
}

/**
 * INVARIANT (RECALL): a real need-based individual (disabled / senior / medical /
 * low-income) reaches the national assistance FUNDS THAT ACTUALLY PAY, not just a
 * pile of DIRECTORIES (owner rule 2026-08-23). Measured on prod that day: 10 of
 * 40 real profiles had ZERO awardable accepts; the real ones (Eli Morgan disabled
 * adult, Ruth Alvarez / GeneMac seniors, Olivia small business) surfaced ONLY
 * "211" / "benefits.gov finder" / "Eldercare Locator" pointers. The funds that
 * pay (PAN, HealthWell, Patient Advocate, Modest Needs) ARE in the catalog and
 * the engine accepts them for SOME profiles — but each reaches only 13-23 of 40,
 * with duplicate rows reaching zero, because the match store is a ROLLING
 * SNAPSHOT: a national source reaches only the handful of profiles crawled near
 * its discovery. Run on the exact pairs, the engine scores these REVIEW (2-10),
 * not ACCEPT, for a genuinely-qualifying disabled/senior person — a broadly-
 * eligible fund states few of the ~70 data points the ratio-score measures — so
 * an awardable row at REVIEW was never recommendable and never reached them.
 *
 * THE NET: for each profile that DECLARES an overlapping assistance need
 * (structured signals only; `config/nationalAssistanceFunders.js`), the VETTED
 * national awardable assistance-funder slice (a curated ~16-identity list — never
 * "any assistance-titled row", which is full of foreign SASSA grants, a job
 * posting, and research grants) is put in front of the canonical engine and
 * written when it did NOT REJECT (ACCEPT or REVIEW), under matcher_version
 * 'national-assistance-link' (reconcile-surviving). `qualifiesForDisplay` surfaces
 * the vetted slice below the numeric floor, honestly a "you may qualify — verify
 * with the funder" recommendation. The engine stays the sole authority (a REJECT
 * is never written); MISSING = NEUTRAL (a profile declaring no assistance need,
 * or an org, gets nothing). BOUNDED: the candidate slice is ~40 catalog rows, so
 * this is not the 14k-link flood a broad need∩geo key causes.
 *
 * `ENFORCE_NATIONAL_ASSISTANCE_RECALL=0` for count-only; `NATIONAL_ASSISTANCE_LINK_LIMIT`
 * bounds writes.
 */
export async function enforceNationalAssistanceRecall(db) {
  return runInvariant('national_assistance_recall', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let assist, normalizeOpportunity, computeMatchDecision
    try {
      assist = await import('../config/nationalAssistanceFunders.js')
      ;({ normalizeOpportunity, computeMatchDecision } = await import('../services/matchEngine.js'))
    } catch (err) {
      log.warn('national_assistance_recall: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }

    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    const trueLit = isPg ? 'TRUE' : '1'
    const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
    const writeLimit = _boundedLimit('NATIONAL_ASSISTANCE_LINK_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_NATIONAL_ASSISTANCE_RECALL) === false

    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('national_assistance_recall: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    const superset = assist.assistanceFunderSqlSuperset('fo')

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let adjudicatedOut = 0
    let unscorable = 0
    let profilesEligible = 0
    let truncated = false
    const wouldLink = []
    const examples = []
    // Every profile examined, with whether it STILL declares an assistance need,
    // so convergence re-adjudicates existing links against the profile's own
    // facts — NOT against the candidate set (which excludes already-linked rows
    // and would delete every link next boot).
    const needsByProfile = new Map()

    for (const row of profileIds || []) {
      if (linked + wouldLink.length >= writeLimit) { truncated = true; break }
      const profileId = row.id
      const ctx = await _loadProfileContextForInvariant(db, profileId)
      if (!ctx) continue
      let declaredNeeds = new Set()
      try {
        declaredNeeds = assist.profileAssistanceNeeds(ctx.profile, ctx.sections)
      } catch { declaredNeeds = new Set() }
      needsByProfile.set(profileId, declaredNeeds)
      if (!declaredNeeds || declaredNeeds.size === 0) continue
      profilesEligible += 1

      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT fo.* FROM funding_opportunities fo
              WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND fo.is_national = ${trueLit}
                AND ${superset.clause}
                AND NOT EXISTS (
                  SELECT 1 FROM profile_opportunity_matches m
                   WHERE m.profile_id = ? AND m.opportunity_id = fo.id
                )
              ORDER BY fo.created_at
              LIMIT ?`,
          )
          .all(...superset.params, profileId, writeLimit)
      } catch (err) {
        log.warn('national_assistance_recall: candidate query failed (non-fatal)', {
          profile: profileId, error: String(err?.message || err),
        })
        continue
      }

      for (const opp of candidates || []) {
        // Re-adjudicate the LIKE superset in JS: national + awardable (not a
        // pointer) + a vetted funder identity, and it must serve a need the
        // profile actually declares.
        if (!assist.funderServesDeclaredNeed(opp, declaredNeeds)) { adjudicatedOut += 1; continue }
        void normalizeOpportunity // (kept for parity with the sibling nets; adjudication above is identity-based)
        scanned += 1
        let decision
        try {
          decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
        } catch (err) {
          unscorable += 1
          log.warn('national_assistance_recall: scoring failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
          continue
        }
        // The engine is the sole authority. A REJECT (eligibility/geo/applicant
        // type fail) is NEVER written. ACCEPT and REVIEW are both admitted — a
        // broadly-eligible assistance fund legitimately scores REVIEW for a
        // qualifying person, and the vetted slice is recommendable at REVIEW.
        const verdict = String(decision?.decision ?? '').toUpperCase()
        if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { unscorable += 1; continue }
        const served = assist.assistanceFunderNeeds(opp) || []

        if (countOnly) {
          wouldLink.push({ profileId, opportunityId: opp.id })
          if (examples.length < 3) examples.push(`${opp.sponsor || opp.title} (${verdict} ${score}, needs ${served.join('/')})`)
          continue
        }
        try {
          const res = await db
            .prepare(
              `INSERT INTO profile_opportunity_matches
                 (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                  match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                  computed_at, updated_at, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'national-assistance-link', ${nowFn}, ${nowFn}, ${nowFn})
               ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
            )
            .run(
              `na:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
              decision?.explanation ?? null,
              JSON.stringify(decision?.matchedNeeds ?? []),
              JSON.stringify(buildPersistedMatchExplain(decision, {
                gate: 'national_assistance',
                served_needs: served,
                declared_needs: [...declaredNeeds],
                evidence: 'profile.declared_needs',
              })),
              null, 'national_assistance',
            )
          const wrote = changesOf(res)
          if (wrote > 0) {
            linked += 1
            if (examples.length < 3) examples.push(`${opp.sponsor || opp.title} (${verdict} ${score}, needs ${served.join('/')})`)
          }
        } catch (err) {
          log.warn('national_assistance_recall: insert failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
        }
      }
    }

    // CONVERGENCE: the profile stopped declaring an assistance need, or the row
    // was deactivated / no longer serves a declared need → the gate no longer
    // authorizes the link. Skipped on a truncated pass so a bound-limited boot
    // never deletes what it never re-derived.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, declaredNeeds] of needsByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT m.id, fo.sponsor, fo.title, fo.opportunity_kind, fo.is_national, fo.is_active
                 FROM profile_opportunity_matches m
                 LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'national-assistance-link'`,
            )
            .all(profileId)
          const doomed = (existing || [])
            .filter((r) => {
              if (!declaredNeeds || declaredNeeds.size === 0) return true
              if (r.sponsor === null && r.title === null) return true
              if (!(r.is_active === null || r.is_active === undefined || r.is_active === 1 || r.is_active === true)) return true
              return !assist.funderServesDeclaredNeed(r, declaredNeeds)
            })
            .map((r) => r.id)
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn('national assistance funds are not reaching the need-based profiles they serve (linking DISABLED via ENFORCE_NATIONAL_ASSISTANCE_RECALL=0)', {
          wouldLink: wouldLink.length, scanned, profilesEligible, examples,
        })
      }
      return {
        scanned,
        repaired: 0,
        wouldRepair: wouldLink.length,
        profilesEligible,
        rejectedByEngine,
        adjudicatedOut,
        truncated,
        enforced: false,
      }
    }
    if (linked > 0 || stale > 0) {
      log.info('linked need-based profiles to national assistance funds they may qualify for', {
        linked, stale, scanned, profilesEligible, rejectedByEngine, adjudicatedOut, unscorable, examples,
      })
    }
    return {
      scanned,
      repaired: linked,
      stale,
      profilesEligible,
      rejectedByEngine,
      adjudicatedOut,
      unscorable,
      truncated,
      enforced: true,
    }
  })
}

/**
 * INVARIANT (RECALL, the general case): every ACTIVE non-pointer catalog row is
 * EVENTUALLY adjudicated by the canonical engine for every real profile — the
 * "general re-scoring sweep for the rolling snapshot" CLAUDE.md carried as
 * STILL OPEN WORK. Measured 2026-08-03: 641 of 11,050 active non-pointer rows
 * (5.8%) have EVER carried a match row for ANY profile; the keyed recall nets
 * above reach only the slices their keys name.
 *
 * Delegates to the canonical sweep (`services/matching/catalogRescoreSweep.js`)
 * with the boot-scale budgets. ACCEPT-only, cursor-resumable, matcher_version
 * 'catalog-rescore-link'. WRITES DEFAULT ON (`ENFORCE_CATALOG_RESCORE=0` for
 * count-only). The fundability junk gate (`passesFundabilityGate`) consumes
 * `fundingResultFilters` so writes no longer wait on an unset opt-in. Every
 * boot still reports the census (`would_link` / `linked`) so recall stays
 * measured.
 */
export async function enforceCatalogRescoreConvergence(db) {
  return runInvariant('catalog_rescore_convergence', async () => {
    let runCatalogRescoreSweep
    try {
      ;({ runCatalogRescoreSweep } = await import('../services/matching/catalogRescoreSweep.js'))
    } catch (err) {
      log.warn('catalog_rescore_convergence: sweep unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const res = await runCatalogRescoreSweep(db)
    return {
      scanned: res.scanned ?? 0,
      repaired: res.linked ?? 0,
      wouldRepair: res.would_link ?? 0,
      adjudicated: res.adjudicated ?? 0,
      rejectedByEngine: res.rejected_by_engine ?? 0,
      review: res.review ?? 0,
      notFundable: res.not_fundable ?? 0,
      explainRefreshed: res.explain_refreshed ?? 0,
      staleExplainPrioritized: res.stale_explain_prioritized ?? 0,
      staleExplainsAtStart: res.stale_explains_at_start ?? 0,
      inventoryPausedForExplainDrain: Boolean(res.inventory_paused_for_explain_drain),
      staleRemoved: res.stale_removed ?? 0,
      profilesCompleted: res.profiles_completed ?? 0,
      truncated: Boolean(res.truncated),
      enforced: Boolean(res.write_enabled),
      examples: res.examples ?? [],
    }
  })
}

/**
 * INVARIANT: Surfaced match rows carry scoring_policy_version when the engine
 * measured one. Linker nets used to persist gate-only stubs; this drain
 * refreshes residue IN PLACE without rebranding matcher_version.
 */
export async function enforceStaleMatchExplainRefresh(db) {
  return runInvariant('stale_match_explain_refresh', async () => {
    let runStaleMatchExplainRefresh
    try {
      ;({ runStaleMatchExplainRefresh } = await import('../services/matching/staleMatchExplainRefresh.js'))
    } catch (err) {
      log.warn('stale_match_explain_refresh: unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const res = await runStaleMatchExplainRefresh(db)
    return {
      scanned: res.scanned ?? 0,
      repaired: res.refreshed ?? 0,
      wouldRepair: res.would_refresh ?? 0,
      unscorable: res.unscorable ?? 0,
      truncated: Boolean(res.truncated),
      enforced: Boolean(res.write_enabled),
    }
  })
}

/**
 * INVARIANT: A FUNDER THE CATALOG HOLDS HAS ITS DEMONSTRATED GIVING READ
 * (the funder-behavior graph, 2026-08-05).
 *
 * The `propublica_990` lane discovers grantmakers but stored NOTHING about
 * what they fund — the row text is an NTEE letter and a city, so the engine
 * scores foundations against silence while commercial products (Candid/FDO)
 * match against the itemized grant lists funders FILE (990-PF Part XV,
 * 990 Schedule I — public, keyless e-file data). This net ingests those
 * lists into `grant_transactions`, bounded per boot, and enriches each
 * funder row with an honest one-line giving summary (marker-idempotent) plus
 * the canonical needs its stated purposes evidence.
 *
 * Chain (each link live-verified 2026-08-05): ProPublica org page → e-file
 * object ids → GivingTuesday 990 data lake → raw IRS XML → parse. Burn/retry
 * discipline is enforceAmountEnrichment's, funder-scoped — see
 * services/funderIntel/funder990Ingest.js. ENFORCE_FUNDER_990_INGEST=0 for
 * count-only.
 */
export async function enforceFunder990Ingest(db) {
  return runInvariant('funder_990_ingest', async () => {
    let runFunder990Ingest
    try {
      ;({ runFunder990Ingest } = await import('../services/funderIntel/funder990Ingest.js'))
    } catch (err) {
      log.warn('funder_990_ingest: service unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const res = await runFunder990Ingest(db)
    if ((res.ingested ?? 0) > 0) {
      log.info('ingested itemized 990 grants for catalog funders', {
        ingested: res.ingested, transactions: res.transactions, enriched: res.enriched, examples: res.examples,
      })
    }
    return {
      scanned: res.scanned ?? 0,
      repaired: res.ingested ?? 0,
      transactions: res.transactions ?? 0,
      enriched: res.enriched ?? 0,
      burnedStable: res.burnedStable ?? 0,
      environment: res.environment ?? 0,
      transient: res.transient ?? 0,
      truncated: Boolean(res.truncated),
      ...(res.skipped ? { skipped: res.skipped } : {}),
      ...(res.remaining !== undefined ? { remaining: res.remaining } : {}),
      enforced: res.enforced !== false,
    }
  })
}

/**
 * INVARIANT (RECALL net): A FUNDER WITH A DEMONSTRATED HISTORY OF FUNDING THE
 * PROFILE'S DECLARED NEED, IN THE PROFILE'S STATE, REACHES THAT PROFILE.
 *
 * The key is DEMONSTRATED BEHAVIOR, not row text: a funder qualifies for a
 * look only when its OWN filed grant list (`grant_transactions`) shows at
 * least one grant to a recipient in the profile's state whose stated purpose
 * evidences a need the profile DECLARES (structured declaration only — the
 * `DECLARED_NEED_FIELDS` registry; prose is never read, the three-times-
 * shipped denial class). Both conjuncts are the flood guards: bare in-state
 * was measured at 5,393/6,210/218 links across three earlier recall attempts
 * and rejected every time (#1090/#1091), and a purpose term is whole-word
 * from a conservative registry (PURPOSE_NEED_TERMS), never one shared token.
 *
 * The gate authorizes a LOOK; `computeMatchDecision` still decides, and only
 * the engine's ACCEPT or REVIEW is written (the student-aid-instate posture,
 * NOT the county-crisis ACCEPT-only bar — deliberately, because a funder row
 * structurally cannot reach ACCEPT: the 990 lane NEVER invents an apply_url
 * (the funder is approached directly), and the engine downgrades an
 * otherwise-ACCEPT row to REVIEW for exactly that missing URL. Measured on
 * the real engine 2026-08-05: a TN housing nonprofit vs a funder with filed
 * TN housing giving scores REVIEW 11, "Downgraded from ACCEPT — missing
 * application URL". An ACCEPT-only bar here is a net that can never fire.
 * Display is still governed by qualifiesForDisplay; a REJECT is never
 * written). Rows land
 * as matcher_version 'funder-behavior-link' (registered in
 * SURFACED_MATCHER_VERSIONS; the crawler-os reconcile's DELETE deliberately
 * does not name it, the web-llm survival reason). Candidate discovery is a
 * SQL predicate (EXISTS over grant_transactions + a LIKE superset the JS
 * whole-word rule re-adjudicates) — never a post-LIMIT filter. MISSING =
 * NEUTRAL: no resolvable state or no structured declared need ⇒ the profile
 * is examined for convergence but gains no key. Bounded by
 * FUNDER_BEHAVIOR_LINK_LIMIT (500); ENFORCE_FUNDER_BEHAVIOR_RECALL=0 for
 * count-only; convergence (need withdrawn / row deactivated / behavior no
 * longer evidenced) is skipped on a truncated pass so a bound-limited boot
 * never deletes what it never re-derived.
 */
export async function enforceFunderBehaviorRecall(db) {
  return runInvariant('funder_behavior_recall', async () => {
    const matchCols = await listMatchColumns(db)
    if (!matchCols.has('profile_id') || !matchCols.has('opportunity_id') || !matchCols.has('matcher_version')) {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    try {
      await db.prepare('SELECT 1 FROM grant_transactions LIMIT 1').get()
    } catch {
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'schema' }
    }
    let declaredNeedsOf, needsEvidencedByPurpose, purposeLikePatternsForNeeds
    let normalizeNeedCategory, NEED_ALIAS_MAP, deriveProfileFacts
    try {
      ;({ declaredNeedsOf, needsEvidencedByPurpose, purposeLikePatternsForNeeds } = await import('../config/funderBehavior.js'))
      ;({ normalizeNeedCategory, NEED_ALIAS_MAP } = await import('../services/profileNormalizer.js'))
      ;({ deriveProfileFacts } = await import('../config/profileDerivedFacts.js'))
    } catch (err) {
      log.warn('funder_behavior_recall: deps unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const { computeMatchDecision } = await import('../services/matchEngine.js')

    const isPg = (db?.dialect || 'sqlite') === 'postgres'
    const trueLit = isPg ? 'TRUE' : '1'
    const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
    const writeLimit = _boundedLimit('FUNDER_BEHAVIOR_LINK_LIMIT', 500)
    const countOnly = _parseBoolEnv(process.env.ENFORCE_FUNDER_BEHAVIOR_RECALL) === false

    let profileIds
    try {
      profileIds = await db
        .prepare("SELECT id FROM profiles WHERE status IS NULL OR status = 'active' ORDER BY created_at")
        .all()
    } catch (err) {
      log.warn('funder_behavior_recall: profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'query' }
    }

    let scanned = 0
    let linked = 0
    let rejectedByEngine = 0
    let adjudicatedOut = 0
    let unscorable = 0
    // Pairs the ENGINE endorsed but the persisted-decision CONTRACT forbids
    // (a resource-kind row below REVIEW_SCORE). Counted, never written — see
    // the convergence note at the write site below.
    let contractRejected = 0
    let profilesEligible = 0
    let truncated = false
    const wouldLink = []
    const examples = []
    // profileId → { state, needs:Set } | null, for convergence against the
    // profile's CURRENT facts (never against the candidate set — the
    // idempotence-deletes-everything class).
    const anchorByProfile = new Map()

    for (const row of profileIds || []) {
      if (linked + wouldLink.length >= writeLimit) { truncated = true; break }
      const profileId = row.id
      const ctx = await _loadProfileContextForInvariant(db, profileId)
      if (!ctx) continue
      let state = null
      try {
        const facts = deriveProfileFacts(ctx.profile, ctx.sections)
        state = String(facts?.place?.state || '').toUpperCase() || null
      } catch { state = null }
      let needs
      try {
        needs = declaredNeedsOf(ctx.profile, ctx.sections, normalizeNeedCategory, NEED_ALIAS_MAP)
      } catch { needs = new Set() }
      const qualifies = Boolean(state) && needs.size > 0
      anchorByProfile.set(profileId, qualifies ? { state, needs } : null)
      if (!qualifies) continue
      profilesEligible += 1

      const likePatterns = purposeLikePatternsForNeeds([...needs])
      if (!likePatterns.length) continue
      const likeSql = likePatterns.map(() => "LOWER(COALESCE(t.purpose,'')) LIKE ?").join(' OR ')

      let candidates
      try {
        candidates = await db
          .prepare(
            `SELECT fo.* FROM funding_opportunities fo
              WHERE fo.source = 'propublica_990'
                AND (fo.is_active IS NULL OR fo.is_active = ${trueLit})
                AND EXISTS (
                  SELECT 1 FROM grant_transactions t
                   WHERE t.funder_ein = fo.source_id
                     AND UPPER(COALESCE(t.recipient_state,'')) = ?
                     AND (${likeSql})
                )
                AND NOT EXISTS (
                  SELECT 1 FROM profile_opportunity_matches m
                   WHERE m.profile_id = ? AND m.opportunity_id = fo.id
                )
              ORDER BY fo.created_at
              LIMIT ?`,
          )
          .all(state, ...likePatterns, profileId, writeLimit)
      } catch (err) {
        log.warn('funder_behavior_recall: candidate query failed (non-fatal)', {
          profile: profileId, error: String(err?.message || err),
        })
        continue
      }

      for (const opp of candidates || []) {
        // Whole-word adjudication of the LIKE superset: at least one of this
        // funder's in-state grants must EVIDENCE a declared need.
        let txs
        try {
          txs = await db
            .prepare(
              `SELECT recipient_name, recipient_state, amount, purpose FROM grant_transactions
                WHERE funder_ein = ? AND UPPER(COALESCE(recipient_state,'')) = ? LIMIT 25`,
            )
            .all(opp.source_id, state)
        } catch { continue }
        const evidence = (txs || []).filter((t) =>
          needsEvidencedByPurpose(t.purpose).some((n) => needs.has(n)),
        )
        if (!evidence.length) { adjudicatedOut += 1; continue }
        scanned += 1

        let decision
        try {
          decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
        } catch (err) {
          unscorable += 1
          log.warn('funder_behavior_recall: scoring failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
          continue
        }
        const verdict = String(decision?.decision ?? '').toUpperCase()
        if (verdict !== 'ACCEPT' && verdict !== 'REVIEW') { rejectedByEngine += 1; continue }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { unscorable += 1; continue }

        // LADDER CONVERGENCE (2026-08-21). `enforcePersistedMatchDecisionIntegrity`
        // (step 39, rule 3) DELETES any resource-kind match carrying an explicit
        // score below REVIEW_SCORE. This sweep is step 33 and writes on the
        // engine's REVIEW verdict alone — and the engine can return REVIEW under
        // that bar. Measured on a real local catalog: profile 80953e8d… ↔
        // "Michael & Susan Dell Foundation — Foundation/Grantmaker"
        // (opportunity_kind `directory`, score 2, decision `review`) was inserted
        // here and deleted there on EVERY boot, holding the ladder's
        // totalRepaired at a permanent floor (15 → 7 → 7 → 7 over four passes)
        // so convergence could never be observed.
        //
        // Skipping it surfaces NOTHING less than before — the row never survived
        // the same boot — it only stops the two sweeps from fighting. The bar
        // comes from the contract's own module; it is never re-encoded here.
        if (isBelowReviewResourceMatch({ opportunityKind: opp.opportunity_kind, matchScore: score })) {
          contractRejected += 1
          continue
        }

        if (countOnly) {
          wouldLink.push({ profileId, opportunityId: opp.id })
          if (examples.length < 3) examples.push(`${opp.sponsor ?? opp.title} (${state}, ${verdict} ${score})`)
          continue
        }
        try {
          const res = await db
            .prepare(
              `INSERT INTO profile_opportunity_matches
                 (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                  match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                  computed_at, updated_at, evaluated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'funder-behavior-link', ${nowFn}, ${nowFn}, ${nowFn})
               ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
            )
            .run(
              `fb:${profileId}:${opp.id}`, profileId, opp.id, score, verdict.toLowerCase(),
              decision?.explanation ?? null,
              JSON.stringify(decision?.matchedNeeds ?? []),
              JSON.stringify(buildPersistedMatchExplain(decision, {
                gate: 'funder_behavior',
                state,
                needs: [...needs].slice(0, 8),
                // The evidence IS the claim: the funder's own filed grants.
                evidence: evidence.slice(0, 3).map((t) => ({
                  recipient: t.recipient_name,
                  state: t.recipient_state,
                  amount: t.amount,
                  purpose: String(t.purpose ?? '').slice(0, 140),
                })),
              })),
              null, 'funder_behavior',
            )
          const wrote = changesOf(res)
          if (wrote > 0) {
            linked += 1
            if (examples.length < 3) examples.push(`${opp.sponsor ?? opp.title} (${state}, ${verdict} ${score})`)
          }
        } catch (err) {
          log.warn('funder_behavior_recall: insert failed (non-fatal)', {
            profile: profileId, opportunity: opp.id, error: String(err?.message || err),
          })
        }
      }
    }

    // CONVERGENCE: the profile withdrew the need / moved state, the row was
    // deactivated, or the funder's stored behavior no longer evidences any
    // currently-declared need. Skipped on a truncated pass.
    let stale = 0
    if (!countOnly && !truncated) {
      for (const [profileId, anchor] of anchorByProfile) {
        try {
          const existing = await db
            .prepare(
              `SELECT m.id, fo.id AS opp_id, fo.source_id AS funder_ein, fo.is_active
                 FROM profile_opportunity_matches m
                 LEFT JOIN funding_opportunities fo ON fo.id = m.opportunity_id
                WHERE m.profile_id = ? AND m.matcher_version = 'funder-behavior-link'`,
            )
            .all(profileId)
          const doomed = []
          for (const r of existing || []) {
            if (!anchor) { doomed.push(r.id); continue }
            if (!r.opp_id) { doomed.push(r.id); continue }
            if (!(r.is_active === null || r.is_active === undefined || r.is_active === 1 || r.is_active === true)) {
              doomed.push(r.id)
              continue
            }
            let txs
            try {
              txs = await db
                .prepare(
                  `SELECT purpose FROM grant_transactions
                    WHERE funder_ein = ? AND UPPER(COALESCE(recipient_state,'')) = ? LIMIT 25`,
                )
                .all(r.funder_ein, anchor.state)
            } catch { continue }
            const stillEvidenced = (txs || []).some((t) =>
              needsEvidencedByPurpose(t.purpose).some((n) => anchor.needs.has(n)),
            )
            if (!stillEvidenced) doomed.push(r.id)
          }
          for (let i = 0; i < doomed.length; i += 200) {
            const slice = doomed.slice(i, i + 200)
            const ph = slice.map(() => '?').join(', ')
            const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
            stale += changesOf(res) || slice.length
          }
        } catch { /* convergence is best-effort; never fails the sweep */ }
      }
    }

    if (countOnly) {
      if (wouldLink.length > 0) {
        log.warn('funders with demonstrated in-state need-matched giving are not reaching profiles (linking DISABLED via ENFORCE_FUNDER_BEHAVIOR_RECALL=0)', {
          wouldLink: wouldLink.length, scanned, profilesEligible, examples,
        })
      }
      return {
        scanned, repaired: 0, wouldRepair: wouldLink.length, profilesEligible,
        rejectedByEngine, adjudicatedOut, contractRejected, truncated, enforced: false,
      }
    }
    // `contractRejected > 0` is in the condition on purpose: a run that linked
    // nothing BECAUSE the decision contract forbade every candidate must say so.
    // A skip nobody can see is the silent-no-op shape, and this sweep would
    // otherwise log only when it succeeded.
    if (linked > 0 || stale > 0 || contractRejected > 0) {
      log.info('linked profiles to funders with demonstrated matching giving', {
        linked, stale, scanned, profilesEligible, rejectedByEngine, adjudicatedOut, unscorable, contractRejected, examples,
      })
    }
    return {
      scanned, repaired: linked, stale, profilesEligible,
      rejectedByEngine, adjudicatedOut, unscorable, contractRejected, truncated, enforced: true,
    }
  })
}

/**
 * INVARIANT (owner directive 2026-08-23): Robert AUTONOMOUSLY adds qualifying
 * national FUNDERS to a profile's pipeline as FUNDER LEADS.
 *
 * For every profile, over the propublica_990 national-funder slice, Robert runs
 * his FOUR-GATE qualification (REAL / RELATABLE / COVERS-A-DECLARED-NEED /
 * QUALIFIES on type+geo+eligibility+recipient-type) gated on QUALIFICATION, not
 * the grantmaker-row ratio score, and auto-adds each qualifying funder as a
 * FUNDER_LEAD (a research prospect Hamilton can NEVER cold-submit). A funder with
 * a national footprint (>= NATIONAL_FOOTPRINT_MIN_STATES distinct states of
 * need-evidenced giving) is admitted alongside in-state givers, so orgs in small
 * states reach national funders of their cause. Bounded + idempotent; no dry
 * run. ENFORCE_FUNDER_LEAD_ADMISSION=0 for count-only.
 */
export async function enforceFunderLeadAdmission(db) {
  return runInvariant('funder_lead_admission', async () => {
    let admitFunderLeads
    try { ({ admitFunderLeads } = await import('../services/robert/robertFunderLeads.js')) } catch (err) {
      log.warn('funder_lead_admission: service unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const res = await admitFunderLeads(db)
    if ((res.added ?? 0) > 0) {
      log.info('Robert auto-added national funder leads to profiles', {
        added: res.added, profiles: res.profiles, scanned: res.scanned, examples: res.examples,
      })
    }
    return {
      scanned: res.scanned ?? 0,
      repaired: res.added ?? 0,
      wouldRepair: res.wouldAdd ?? 0,
      profiles: res.profiles ?? 0,
      perProfileCapped: res.perProfileCapped ?? 0,
      skippedExisting: res.skippedExisting ?? 0,
      skippedTombstoned: res.skippedTombstoned ?? 0,
      byReason: res.byReason ?? {},
      truncated: Boolean(res.truncated),
      ...(res.skipped ? { skipped: res.skipped } : {}),
      enforced: res.wouldAdd === undefined || res.wouldAdd === 0 ? true : false,
    }
  })
}

/**
 * INVARIANT (owner refinement 2026-08-23): Robert INVESTIGATES each funder lead
 * toward a verdict and PROMOTES the ones with a real applicable path.
 *
 * A funder lead that has (or, on investigation, gains) a usable application path
 * is promoted to the APPLY-READY funding-source side, where Hamilton handles it
 * normally on a fully-autonomous profile. A lead with no self-serve application
 * path is recorded as a research/relationship prospect and stays a lead (bounded
 * attempts -> not_applicable, labeled) — never silently promoted, never
 * cold-submitted. Bounded per pass; a search-provider outage never burns an
 * attempt.
 */
export async function enforceFunderLeadInvestigation(db) {
  return runInvariant('funder_lead_investigation', async () => {
    let investigateFunderLeads
    try { ({ investigateFunderLeads } = await import('../services/robert/robertFunderLeads.js')) } catch (err) {
      log.warn('funder_lead_investigation: service unavailable (non-fatal)', { error: String(err?.message || err) })
      return { scanned: 0, repaired: 0, enforced: true, skipped: 'deps' }
    }
    const res = await investigateFunderLeads(db)
    if ((res.promoted ?? 0) > 0 || (res.notApplicable ?? 0) > 0) {
      log.info('Robert investigated funder leads', {
        promoted: res.promoted, investigated: res.investigated, notApplicable: res.notApplicable, scanned: res.scanned,
      })
    }
    return {
      scanned: res.scanned ?? 0,
      repaired: res.promoted ?? 0,
      investigated: res.investigated ?? 0,
      notApplicable: res.notApplicable ?? 0,
      deferredOutage: res.deferredOutage ?? 0,
      ...(res.skipped ? { skipped: res.skipped } : {}),
      enforced: true,
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
  // SCOPE nets for the surfaced match store (2026-08-01, the GeneMac report).
  // Geo scope FIRST and on the CATALOG, because the two match-store purges below
  // and every later geo comparison read `funding_opportunities.state` — a row
  // re-scoped from its own title in this step is judged correctly for the rest
  // of the boot instead of one boot late.
  steps.push(await enforceDeclaredGeoScope(db))
  // A per-state housing finance agency row declares its state as a FULL NAME in
  // its curated title/sponsor — a shape the "<Place>, XX —" rule above cannot
  // read. Re-scope those rows from the SAME registry that minted them, and
  // purge the out-of-state agency matches (the Demo College Student Persona HFA class). Runs
  // right after the general geo repair so every later comparison reads the
  // corrected state this same boot.
  steps.push(await enforceStateAgencyGeoScope(db))
  // …then remove the out-of-area locators that scope already surfaced (the top
  // of the owner's GeneMac list: an Indiana senior shown Polk County TN).
  steps.push(await enforceDeclaredPlaceScopeMatches(db))
  // A program administered by another government can never be applied to from
  // the US; the geography gate had no country concept at all, so these scored as
  // nationwide-eligible.
  steps.push(await enforceForeignJurisdictionMatches(db))
  // Non-grant junk (owner QA 2026-08-03): regulatory/administrative notices,
  // lead-gen "scholarships", and clearly-expired programs carry no claim a
  // profile can act on. Sits with the scope purges so stored rows predating
  // the widened procedural registry converge the same boot it ships.
  steps.push(await enforceNonGrantNoticeMatches(db))
  // …and the PIPELINE half of the same rule: the grants table is what the
  // owner works, and every pre-gate writer (manual creates, imports, the
  // admin-schema-repair migrations) left regulatory notices there as work
  // items with live application tasks. Purges only on positive junk evidence;
  // FR-source-alone rows are flagged for the owner-gated repair.
  steps.push(await enforceNonGrantNoticePipeline(db))
  // The award ceiling an INDIVIDUAL's pipeline has enforced for months, applied
  // to the match store that actually feeds the owner-facing list.
  steps.push(await enforceIndividualMatchAwardCeiling(db))
  // A profile that was NEVER FILLED IN is not a crawler failure. Remove the
  // geography the system INVENTED from its placeholder address ("Anytown, SA",
  // out-of-state county locators) and report the profile as unconfigured with
  // the missing prerequisites named. Runs LAST in the scope family so the
  // catalog is already re-scoped and the ordinary place/foreign/ceiling nets
  // have taken their (profile-agnostic) rows first.
  steps.push(await enforceUnconfiguredProfileGeoMatches(db))
  // CROSS-PROFILE PRECISION (2026-08-03, the Demo College Student Persona report): a
  // cross-profile (xmatch) row is a match only on the engine's ACCEPT. Purges
  // the stored REVIEW flood (95.5% of all xmatch rows in prod) that the
  // resource-preserving reconcile would otherwise restore forever. Sits with
  // the scope purges, before the recall nets add rows under other versions.
  steps.push(await enforceCrossProfileMatchPrecision(db))
  // …and the match-store half of the condition-lane gate: a disease-specific
  // lane's rows reach only a profile that DECLARES the condition. The planner
  // gate (#1102) stops new selections; this reaches the rows that predate it,
  // which the resource-preserving reconcile makes structurally immortal.
  steps.push(await enforceConditionLaneMatchScope(db))
  steps.push(await enforceMissionLaneMatchScope(db))
  // Surface-table eligibility net: demote persisted student-aid matches that are
  // surfacing to a NON-student profile (stale ACCEPTs the live engine already
  // caps below the floor, e.g. web-llm rows that the reconcile never re-scores).
  // Operates on profile_opportunity_matches, so it complements the grants sweeps.
  steps.push(await enforceStudentAidEligibility(db))
  // RECALL net (the other direction): a student's OWN school's aid must reach
  // them. Runs BEFORE the dangling / decision-integrity sweeps on purpose, so
  // the rows it adds are validated by them in the SAME boot rather than a boot
  // late. It authorizes the canonical engine to LOOK at an attendance-linked
  // pair; the engine still decides, and a REJECT is never written.
  steps.push(await enforceInstitutionAidLinkage(db))
  // RECALL net, same class one level up: a catalog row that RECORDS the profile
  // it was discovered for is re-offered to that profile, because the match store
  // is a rolling snapshot and the row's own match was erased by a later run.
  // Runs immediately after the institution net so both linkage gates land before
  // the dangling/decision-integrity hygiene sweeps read the table.
  steps.push(await enforceProfileDiscoveredCatalogLinkage(db))
  // RECALL net, keyed on what the profile SAYS IT STUDIES rather than on a
  // school or on a row's provenance: a catalog row whose title or sponsor names
  // the profile's DECLARED field of study is offered to that profile. Runs with
  // the other linkage gates, before the dangling/decision-integrity hygiene
  // sweeps read the table.
  steps.push(await enforceDeclaredFieldOfStudyRecall(db))
  // RECALL net, keyed on the student's own STATE: a catalog row whose title or
  // sponsor NAMES that state and whose aid taxonomy makes it a scholarship or
  // endowment is offered to the student. Sits with the other linkage gates; the
  // stage-scope purge immediately below is what holds everything it (and every
  // other producer) surfaced to the academic-stage bar.
  steps.push(await enforceStudentAidInStateRecall(db))
  // RECALL net for the OTHER half of the fleet: a household in crisis. Keyed on
  // the profile's own COUNTY (declared, or ZIP-derived and city-corroborated)
  // plus a crisis need the profile DECLARES, so already-catalogued local help
  // reaches the person it was written for. Sits with the other linkage gates so
  // the rows it adds are held to the scope/hygiene bars in the SAME boot.
  steps.push(await enforceCountyCrisisNeedRecall(db))
  // RECALL net for the need-based individual who was getting only DIRECTORIES:
  // the VETTED national awardable assistance-funder slice (PAN / HealthWell /
  // Patient Advocate / Modest Needs / …) is put in front of the canonical engine
  // for every profile that DECLARES an overlapping assistance need, and written
  // when the engine did not REJECT (ACCEPT or REVIEW). Sits with the other
  // linkage gates so its rows are held to the scope/hygiene bars the SAME boot.
  steps.push(await enforceNationalAssistanceRecall(db))
  // FUNDER-BEHAVIOR ingest (the Candid-gap closer): read the itemized 990
  // grant lists for funders the catalog already holds, bounded per boot, so
  // the recall net right below — and every later sweep — scores foundations
  // against DEMONSTRATED giving instead of an NTEE letter and silence.
  steps.push(await enforceFunder990Ingest(db))
  // RECALL net keyed on that demonstrated behavior: a funder whose own filed
  // grants show in-state giving for a need the profile DECLARES is put in
  // front of the canonical engine (ACCEPT only). Sits with the other linkage
  // gates so its rows are held to the scope/hygiene bars the SAME boot.
  steps.push(await enforceFunderBehaviorRecall(db))
  // ROBERT auto-adds qualifying NATIONAL FUNDERS to the pipeline as FUNDER LEADS
  // (four-gate qualification, NOT the ratio-score floor; national footprint +
  // in-state givers; recipient-type gate). Runs right after the 990 ingest +
  // behavior recall so it scores against the freshest demonstrated giving.
  steps.push(await enforceFunderLeadAdmission(db))
  // …then Robert INVESTIGATES those leads and PROMOTES the ones with a real
  // applicable application path to the apply-ready side (Hamilton's territory).
  steps.push(await enforceFunderLeadInvestigation(db))
  // RECALL net, the GENERAL case: the continuous catalog-wide re-matching
  // census/sweep (rolling-snapshot convergence). Sits with the other linkage
  // gates so anything it links (writes env-gated) is held to the stage/scope/
  // hygiene bars below in the SAME boot.
  steps.push(await enforceCatalogRescoreConvergence(db))
  // Linker / recall residue: refresh gate-only stubs that lack
  // scoring_policy_version WITHOUT rebranding matcher_version (item 43).
  steps.push(await enforceStaleMatchExplainRefresh(db))
  // ACADEMIC-STAGE scope net: remove surfaced awards the profile's derived stage
  // provably cannot receive (graduate/professional, postdoctoral, adult
  // reentry). Runs immediately AFTER the recall gates so anything they added
  // this boot is held to the same bar in the SAME boot, not a boot late.
  steps.push(await enforceStageOfLifeMatchScope(db))
  steps.push(await enforceFieldOfStudyMatchScope(db))
  // Surface-table hygiene: a persisted match whose catalog row was deleted
  // (dedupe/reality-gate/reaper purges never cleaned matches up) is an
  // unusable ghost that inflates the matches view and wastes promote passes.
  steps.push(await enforceNoDanglingMatches(db))
  // RESULT FLOOR census — runs AFTER every scope/eligibility/linkage net above
  // and after the dangling cleanup, so the count it takes is of the match store
  // as it will actually be READ, not of rows this same boot is about to purge.
  // Counts only (no crawl); the nightly heal queue is its actor.
  steps.push(await enforceProfileResultFloor(db))
  // Persisted-decision integrity AFTER dangling cleanup: no direct REJECT may
  // remain surfaced, and every surviving resource is REVIEW rather than ACCEPT.
  steps.push(await enforcePersistedMatchDecisionIntegrity(db))
  // Profession-eligibility net: cancel the Hamilton tasks + purge the early-status
  // grants for opportunities LOCKED to a profession the profile does not practise
  // (e.g. a nursing scholarship in a paramedic student's pipeline). Reuses the
  // shared professionEligibility predicate; conservative (never touches a profile
  // whose field is unknown, or a profession the profile actually practises).
  steps.push(await enforceProfileEligibility(db))
  // PIPELINE PRECISION (owner order 2026-08-21): every remaining pipeline row
  // must meet a DECLARED need, come from a REAL/RELATABLE source, and be one
  // the profile QUALIFIES for — Robert's four-gate verifier run as a boot net
  // over every profile (deterministic REAL half only). Early-status failures
  // are tombstoned + deleted; protected rows are RE-LABELED, never deleted.
  // Runs right after the profession net, before the data-repair steps, so no
  // repair is wasted on a row this boot removes.
  steps.push(await enforcePipelinePrecision(db))
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
  // URL-less pointer/directory/referral tasks are research leads, not portal
  // applications. Preserve their evidence while disabling submission intent.
  steps.push(await enforcePointerTaskReclassification(db))
  // URL-hygiene net: a search-engine RESULTS url is never a portal/application
  // target — null it wherever it was persisted and reclassify affected tasks
  // to the truthful unknown_application_method state.
  steps.push(await enforceNoSearchEngineApplicationTargets(db))
  // Shared-listing net (2026-08-23, the Coolidge/Live Más class): an
  // application_url shared by >= 5 distinct award titles is a hub/listing,
  // not the award's page — move it to evidence_url so the URL-rescue net can
  // find the real page. Runs beside the other URL-target repairs.
  steps.push(await enforceSharedListingApplicationTargets(db))
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
  // Session-lifetime observability net: a saved portal session with no
  // `session_established_at` can never contribute an observation to the
  // lifetime ledger (the recorder refuses rather than invent a clock), so the
  // "how long do this host's sessions live?" question stays permanently
  // unanswerable for it. Stamp it from the row's own created_at.
  steps.push(await enforcePortalSessionLifetimeStamp(db))
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
      // Candidates the ENGINE endorsed that the persisted-decision CONTRACT
      // forbids (funder_behavior_recall). Carried so "linked 0" can be read as
      // "the contract rejected N" rather than as an unexplained empty run.
      ...(s.contractRejected !== undefined ? { contractRejected: s.contractRejected } : {}),
      // Pipeline precision (owner order 2026-08-21): per-gate + per-reason
      // removal counts, the re-labeled protected rows, and the two need-gate
      // silence classes — so the boot summary answers "removed WHAT and WHY",
      // never a bare repaired total.
      ...(s.byGate !== undefined ? {
        removed: s.removed, relabeled: s.relabeled, kept: s.kept,
        byGate: s.byGate, byReason: s.byReason,
        needNeutralProfile: s.needNeutralProfile, needNeutralRow: s.needNeutralRow,
        truncated: s.truncated,
      } : {}),
      // Result-floor census: the owner-facing number ("how many profiles hold
      // fewer real funding sources than they asked for") plus how many of those
      // have a recorded, evidenced "exhausted" verdict rather than a pending
      // retry — the difference between a backlog and a converged answer.
      ...(s.belowTarget !== undefined ? { belowTarget: s.belowTarget } : {}),
      ...(s.exhausted !== undefined ? { exhausted: s.exhausted } : {}),
      ...(s.reopened !== undefined ? { reopened: s.reopened } : {}),
      ...(s.fleetTarget !== undefined ? { fleetTarget: s.fleetTarget } : {}),
      // Unconfigured-profile nets: how many profiles cannot be served until a
      // human fills them in, and how many match rows carried a place the system
      // FABRICATED from a placeholder address.
      ...(s.unconfigured !== undefined ? { unconfigured: s.unconfigured } : {}),
      ...(s.unconfiguredProfiles !== undefined ? { unconfiguredProfiles: s.unconfiguredProfiles } : {}),
      ...(s.fabricatedPlace !== undefined ? { fabricatedPlace: s.fabricatedPlace } : {}),
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
      steps: steps.map((s) => ({
        name: s.name,
        ok: s.ok,
        repaired: s.repaired ?? 0,
        // NOTE: `?? 0` means a step that never emits `scanned` is indistinguishable
        // here from one that scanned nothing — which is exactly why every BOUNDED
        // sweep must emit it (see stale_missing_field_resolution /
        // hamilton_stop_recheck): `scanned === bound` is the only blindness signal
        // this artifact can carry.
        scanned: s.scanned ?? 0,
        // Work the sweep deliberately did NOT do, and why — so "repaired 0" can be
        // read as "the decision contract forbade N candidates" instead of as an
        // unexplained empty run.
        ...(s.contractRejected ? { contractRejected: s.contractRejected } : {}),
        ...(s.error ? { error: s.error } : {}),
      })),
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
  enforceDeclaredGeoScope,
  enforceDeclaredPlaceScopeMatches,
  enforceForeignJurisdictionMatches,
  enforceNonGrantNoticeMatches,
  enforceNonGrantNoticePipeline,
  enforceIndividualMatchAwardCeiling,
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
  enforcePointerTaskReclassification,
  resolveSelfHealRequeueCap,
  SELF_HEAL_REQUEUE_CAP_DEFAULT,
  enforceAdminReinterviewSuppression,
  enforceLeadContactPlausibility,
  enforceJohnDraftPlausibility,
  enforceProfileResultFloor,
  enforceStageOfLifeMatchScope,
  enforceFieldOfStudyMatchScope,
  enforceStudentAidInStateRecall,
}
