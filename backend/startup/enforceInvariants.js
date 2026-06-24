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
import { isTrustedRecordOrigin } from '../config/relevanceFloor.js'
import { dedupeProfileDisplayName } from '../../shared/nameParsing.js'

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
    const where = `profile_id IS NULL AND (amount_awarded IS NULL OR amount_awarded <= 0)`

    let violators = 0
    try {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM grants WHERE ${where}`).get()
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

    const result = await db.prepare(`DELETE FROM grants WHERE ${where}`).run()
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
 * basic_information.full_name — e.g. "Robert White" + "Robert Michael White"
 * became "Robert White\nRobert Michael White", which synced into
 * profiles.display_name and rendered as "Robert White Robert Michael White" in
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
  steps.push(await enforceNoCrossProfileBleed(db))
  // Drop profile-less orphans next: removes rows the duplicate + relevance
  // sweeps would otherwise waste time scanning, and closes the org-scoped PDF
  // leak at the data layer (the print-side guard is the first line of defense).
  steps.push(await enforceProfileScopedPipeline(db))
  steps.push(await enforceNoDuplicateGrants(db))
  steps.push(await enforceRelevanceFloor(db))
  // Profile-level data repair (not pipeline): collapse any doubled display_name
  // (e.g. "Robert White Robert Michael White") back to a single name.
  steps.push(await enforceProfileDisplayNameNotDoubled(db))

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
  enforceProfileScopedPipeline,
}
