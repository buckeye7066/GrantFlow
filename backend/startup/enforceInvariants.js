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
import { reconcileDismissedGrants } from '../services/pipelineDismissals.js'
import { resolveProfileForId } from '../utils/profileResolver.js'
import { DESIGNATED_PROFILES } from '../config/designatedProfiles.js'
import { isTrustedRecordOrigin } from '../config/relevanceFloor.js'
import { PIPELINE_ACTIVE_STATUSES } from '../config/pipelineValue.js'
import { dedupeProfileDisplayName } from '../../shared/nameParsing.js'
import { resolveProfileType, getParentChain } from '../services/profileTypeRegistry.js'
import { grantFamilyKey, grantUrlKey, likelySameGrantOpportunity } from '../utils/grantFingerprint.js'
import { isSearchEngineUrl } from '../config/urlRules.js'

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
  process.env.PIPELINE_RELEVANCE_FLOOR || '50',
  10,
) || 50

/**
 * Hard fallback if neither the shared config nor an env override is available.
 * Matches the insert-gate default the partner agent is introducing.
 */
const RELEVANCE_FLOOR_FALLBACK = 55

/**
 * LENIENT purge floor. The boot sweep is the destructive NET, so it must be at
 * least as lenient as the insert gate — INSERT floor >= PURGE floor — or it
 * would turn around and delete rows the insert gate just (correctly) admitted
 * (e.g. trusted student aid admitted at the 40 trusted floor, or a 50–54 row).
 *
 * The audit caught a "floor collapse": both the insert gate and this purge
 * resolved to the SAME config value (55), so the purge could delete 50–54 rows
 * that should survive. We restore the documented split — the purge uses
 * min(resolvedFloor, 50) so it can never exceed 50 and never exceed the insert
 * floor. Override the cap via env PIPELINE_PURGE_RELEVANCE_FLOOR.
 */
const PURGE_FLOOR_CAP = (() => {
  const v = Number.parseInt(process.env.PIPELINE_PURGE_RELEVANCE_FLOOR || '50', 10)
  return Number.isFinite(v) && v > 0 ? v : 50
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
    source = 'fallback(55):config-not-resolvable'
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
    return { repaired: removed }
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

/** Score a demoted match is forced BELOW the display floor to so it stops surfacing. */
const STUDENT_AID_DEMOTE_SCORE = 40

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

    if (!disabled) {
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

      // Step 2: default amount_requested from the grant's own ceiling/floor.
      try {
        const result = await db
          .prepare(
            `UPDATE grants
                SET amount_requested = COALESCE(NULLIF(amount_max, 0), NULLIF(amount_min, 0))
              WHERE COALESCE(amount_requested, 0) <= 0
                AND (COALESCE(amount_max, 0) > 0 OR COALESCE(amount_min, 0) > 0)`,
          )
          .run()
        repairedRequested = changesOf(result)
      } catch (err) {
        log.warn('grant_amount_backfill: requested-default query failed (non-fatal)', { error: String(err?.message || err) })
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

    const repaired = repairedFromCatalog + repairedRequested
    if (repaired > 0) {
      log.info('backfilled pipeline grant amounts', {
        repairedFromCatalog,
        repairedRequested,
        stillMissingAmount: missing,
        enforced: !disabled,
      })
    }
    return { scanned: repaired + missing, repaired, enforced: !disabled, missingAmount: missing }
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
 * Run every machine-checkable product invariant, in order. Mirrors
 * ensureSchemaInvariants.js: each step is independently guarded, the whole
 * run never throws, and a structured summary is returned + logged.
 *
 * Order: sticky-deletes first (removes rows other invariants would otherwise
 * inspect), then tenancy re-alignment, then the relevance-floor signal.
 *
 * @returns {Promise<{ steps: Array<object>, ran: number, failed: number, totalRepaired: number }>}
 */
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
  steps.push(await enforceRelevanceFloor(db))
  // Pipeline-$ visibility: inherit award min/max from the linked catalog row
  // and default amount_requested from the ceiling/floor wherever empty, so
  // every Pipeline Potential surface can see the money that is actually there.
  // MUST run before the individual amount ceiling so the ceiling operates on
  // honest (backfilled) values.
  steps.push(await enforceGrantAmountBackfill(db))
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
  // Hamilton lifecycle self-heal: re-queue blocked tasks whose missing-profile-
  // field preflight blocker no longer reproduces, and collapse already-stacked
  // duplicate OPEN hard-stops (keep oldest, resolve extras as 'duplicate').
  steps.push(await enforceHamiltonTaskSelfHeal(db))
  // URL-hygiene net: a search-engine RESULTS url is never a portal/application
  // target — null it wherever it was persisted and reclassify affected tasks
  // to the truthful unknown_application_method state.
  steps.push(await enforceNoSearchEngineApplicationTargets(db))

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
      ...(s.missingAmount !== undefined ? { missingAmount: s.missingAmount } : {}),
      ...(s.floor !== undefined ? { floor: s.floor, floorSource: s.floorSource } : {}),
    })),
  })

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
  enforceIndividualAmountCeiling,
  enforceStudentAidEligibility,
  enforceProfileEligibility,
  enforceFunderBackfill,
  enforceGrantAmountBackfill,
  resolveIndividualAmountCeiling,
  isIndividualProfileType,
  parseIncomeValue,
  STUDENT_AID_DEMOTE_SCORE,
  enforceHamiltonTaskSelfHeal,
  resolveSelfHealRequeueCap,
  SELF_HEAL_REQUEUE_CAP_DEFAULT,
}
