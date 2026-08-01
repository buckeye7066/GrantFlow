/**
 * portalSyncStaleness.js
 *
 * THE ONE PLACE that answers: "which portals need a sync for THIS profile, and
 * why?" — the login-time prompt the owner asked for (2026-08-01):
 *
 *   "Alert the profile owner and admin ON LOGIN that a sync needs to happen,
 *    and which portals need synced. A portal needs synced if it hasn't been
 *    synced in 7 days, OR if the GrantFlow profile has updated awards or
 *    information since the previous sync."
 *
 * WHY A PROMPT BEATS A KEEP-ALIVE (measured 2026-08-01)
 * ----------------------------------------------------
 * A federal-student-aid session was authenticated at T+30s and refused at
 * T+~20min. No probe cadence survives that; the only moment a short-lived
 * session is reliably warm is when a human is present. So the sync goes where
 * the human already is — login — instead of a browser fleet chasing sessions
 * that are already gone (and, on an Akamai-fronted federal host, risking a
 * permanent bot wall, which is strictly worse than an expired session).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH TIMESTAMPS ARE TRUSTWORTHY — verified read-only against prod, 2026-08-01
 * ─────────────────────────────────────────────────────────────────────────────
 * "The profile changed" is only meaningful if the timestamp it rests on moves
 * for HUMAN reasons. Two of the three obvious candidates do not:
 *
 *   profiles.updated_at            REJECTED. 35 of 39 prod profiles share the
 *                                  SAME second (2026-08-01T11:56:04Z) — a bulk
 *                                  machine sweep touches every row. Keying on
 *                                  it marks every portal stale on every login:
 *                                  an alert that can never go green, which
 *                                  CLAUDE.md classifies as noise, not a
 *                                  standard.
 *
 *   grants.updated_at (all rows)   REJECTED. 283 of 524 prod grants are
 *                                  `discovered` and move whenever the crawler
 *                                  or an enrichment sweep touches them (dozens
 *                                  today alone). That is discovery churn, not
 *                                  "the owner has new award information".
 *
 *   grants.updated_at, but ONLY    ACCEPTED. In prod this set is 12 rows total
 *   on rows at a HUMAN-PROGRESSED  (11 `submitted`, 1 `awarded` at $118,500) —
 *   stage or carrying real money   small, human-driven, and exactly what the
 *                                  owner means by "updated awards".
 *
 *   profile_sections.updated_at    ACCEPTED, with a provenance filter. It moves
 *   with a MACHINE-WRITER filter   for real edits AND for machine writers, but
 *                                  unlike the others it records WHO wrote
 *                                  (`updated_by`): prod holds
 *                                  `buckeye7066@gmail.com` and
 *                                  `owner_directive_no_loans` (human) alongside
 *                                  `agent:amy`, `crawler-stress-cohort`,
 *                                  `system-seed`, `invariant:…`,
 *                                  `legacy_scale_migration` (machine). Filtering
 *                                  on the writer is what makes this signal
 *                                  converge.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SCOPE: ONE PROFILE, ALWAYS (owner refinement, 2026-08-01)
 * ─────────────────────────────────────────────────────────────────────────────
 *   "For admin, only alert to what needs synced in a profile when admin is
 *    working in that particular profile. That way admin is not flooded."
 *
 * `resolveProfileSyncNeeds` takes exactly ONE `profileId` and has no aggregate
 * mode. There is deliberately no "all profiles I can access" entry point: with
 * 39 prod profiles, an admin digest is a wall of prompts an admin learns to
 * scroll past, which destroys the surface for the one profile that matters.
 * Admins see the SAME list an owner sees — the difference is scope, not content.
 * The route enforces this via `requireProfileScope`, which 400s without a
 * profileId, so an admin with no active profile gets nothing rather than
 * everything.
 *
 * NEVER NAG ABOUT SOMETHING THAT CANNOT BE ACTED ON: a portal with no captured
 * session gets `action: 'sign_in'` ("sign in once"), never "sync now" — and a
 * portal with no session, no credential and no sync history is not listed at
 * all, because there is nothing there to keep in sync.
 *
 * Best-effort: never throws. A failure degrades to "no prompts", never to a
 * wrong prompt.
 */

import { PIPELINE_STAGE } from '../../../shared/pipelineStages.js'
import { getProfilePortals } from './profilePortalIndex.js'
import { loadLifetimeLedger, summarizeHostLifetime } from './portalSessionLifetime.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:portal-sync-staleness')

/** Owner's rule: a portal not synced in this long is stale. */
export const DEFAULT_STALE_AFTER_DAYS = 7

/**
 * Most portals prompted at once. The remainder is REPORTED as a count
 * (`truncated_count`), never silently dropped.
 *
 * Measured against real prod data (Anastasia, profile c4a92724, 2026-08-01):
 * 14 portals qualify — 4 actionable "sync now" and 10 one-off portals last
 * touched by a bulk run on 2026-07-02 with no valid session. Fourteen prompts
 * at login is precisely the flood the owner rejected ("that way admin is not
 * flooded"), and an alert people scroll past is noise, not a standard.
 */
export const DEFAULT_MAX_PROMPTED_PORTALS = 5

/**
 * Grant stages that represent REAL, human-progressed award activity — the
 * "updated awards" half of the owner's rule. Discovery/triage stages are
 * deliberately excluded: they move on crawler churn, not owner intent.
 * Sourced from the canonical `PIPELINE_STAGE` vocabulary so a stage rename
 * cannot silently drop out of this set (totality-tested).
 */
export const AWARD_ACTIVITY_STAGES = Object.freeze([
  PIPELINE_STAGE.SUBMITTED,
  PIPELINE_STAGE.AWARDED,
  PIPELINE_STAGE.FOLLOW_UP,
  PIPELINE_STAGE.DECLINED,
].filter(Boolean))

/**
 * `profile_sections.updated_by` values that are MACHINE writers. A change
 * written by one of these is not "the owner updated their information", so it
 * must not trigger a sync prompt.
 *
 * ONE canonical pattern, matched case-insensitively against the whole value.
 * Namespace-shaped (`agent:`, `invariant:`, `system-`, `document:`) rather than
 * an exact-match denylist, because an exact-match Set can never filter values
 * that are generated per-run — the failure CLAUDE.md records for
 * `NON_DISEASE_HEALTH_SIGNALS`. Every writer observed in prod is pinned to its
 * classification by a totality test.
 *
 * A NULL/unknown writer counts as HUMAN. That is deliberate and conservative in
 * the safe direction: prod's null-writer rows are real UI edits (Anastasia's
 * basic_information / narrative / demographics), and the cost of a false
 * positive is one extra "sync now" prompt, while the cost of a false negative
 * is a portal that silently drifts out of date — the defect we are fixing.
 */
export const MACHINE_WRITER_RX =
  /^(agent:|invariant:|document:|system[-_]|crawler[-_]|profile[-_]?(merge|enrichment)|.*_migration$|legacy[-_]|amy\b|sam\b|robert\b|yana\b|john\b|anya[-_]?onboarding$)/i

/**
 * Writers that name a PERSON acting, and therefore win over MACHINE_WRITER_RX.
 *
 * Needed because a namespace prefix alone cannot separate `system-seed` (a
 * migration) from `system_admin_token` (a human admin editing through the admin
 * token — prod has one on Anastasia's `university_applications`). An email
 * address is likewise always a person. Checked FIRST so the namespace rule can
 * stay broad without swallowing real edits.
 */
export const HUMAN_ACTOR_RX = /(^|[-_])admin[-_]token(\b|$)|@/i

/** True when this `updated_by` is a machine writer (so its edit is not owner intent). */
export function isMachineWriter(updatedBy) {
  const s = String(updatedBy ?? '').trim()
  if (!s) return false // null/empty = a real UI edit; see note above.
  if (HUMAN_ACTOR_RX.test(s)) return false
  return MACHINE_WRITER_RX.test(s)
}

/** Reason codes — a stable vocabulary every consumer (API + UI + tests) shares. */
export const SYNC_NEED_REASON = Object.freeze({
  NEVER_SYNCED: 'never_synced',
  STALE: 'stale',
  AWARDS_CHANGED: 'awards_changed',
  PROFILE_CHANGED: 'profile_changed',
})

/** What the human is actually being asked to do. */
export const SYNC_NEED_ACTION = Object.freeze({
  SIGN_IN: 'sign_in',   // no valid captured session — one watched sign-in first
  SYNC_NOW: 'sync_now', // session in hand — the sync can run immediately
})

export function staleAfterMs() {
  const raw = Number(process.env.HAMILTON_PORTAL_SYNC_STALE_DAYS)
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STALE_AFTER_DAYS
  return days * 24 * 60 * 60 * 1000
}

export function maxPromptedPortals() {
  const raw = Number(process.env.HAMILTON_PORTAL_SYNC_MAX_PROMPTS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_PROMPTED_PORTALS
}

function parseTime(v) {
  if (!v) return NaN
  if (v instanceof Date) return v.getTime()
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : NaN
}

function isoOrNull(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * Latest SUCCESSFUL sync per host for one profile, in ONE query.
 *
 * Deliberately `status = 'completed'`: a failed run is not a sync. Prod holds
 * 4 failed `collegefortn.org` runs alongside 4 completed ones — counting the
 * failures would report a portal as freshly synced when nothing synced.
 *
 * Uses `finished_at` and falls back to `started_at` so a row whose finish
 * stamp never landed still counts as an attempt at a known time.
 *
 * @returns {Promise<Map<string, number>>} host -> epoch ms
 */
async function loadLastSuccessfulSyncByHost(db, profileId) {
  const out = new Map()
  try {
    const rows = await db.prepare(
      `SELECT portal_host, MAX(COALESCE(finished_at, started_at)) AS last_ok
         FROM portal_sync_runs
        WHERE profile_id = ? AND status = 'completed'
        GROUP BY portal_host`,
    ).all(String(profileId))
    for (const r of rows || []) {
      const host = String(r?.portal_host || '').trim().toLowerCase()
      const t = parseTime(r?.last_ok)
      if (host && Number.isFinite(t)) out.set(host, t)
    }
  } catch (err) {
    // Table absent on an old deploy → every portal reads as never-synced, which
    // is the honest degradation (prompt, don't silently skip).
    log.warn('last_sync_read_failed', { err: err?.message })
  }
  return out
}

/**
 * Most recent HUMAN-PROGRESSED award activity for the profile (epoch ms), or
 * NaN when there is none. See AWARD_ACTIVITY_STAGES for why the stage filter
 * is load-bearing.
 */
async function loadLastAwardActivityAt(db, profileId) {
  try {
    const placeholders = AWARD_ACTIVITY_STAGES.map(() => '?').join(', ')
    const row = await db.prepare(
      `SELECT MAX(updated_at) AS mx FROM grants
        WHERE profile_id = ?
          AND (status IN (${placeholders}) OR amount_awarded > 0)`,
    ).get(String(profileId), ...AWARD_ACTIVITY_STAGES)
    return parseTime(row?.mx)
  } catch (err) {
    log.warn('award_activity_read_failed', { err: err?.message })
    return NaN
  }
}

/**
 * Most recent HUMAN profile-information edit (epoch ms), or NaN.
 *
 * Grouped by writer so the machine-writer filter runs in JS against the
 * canonical regex — a SQL NOT LIKE chain would have to be duplicated per
 * dialect and would drift from `isMachineWriter`. The grouped result is tiny
 * (≤ ~15 distinct writers per profile).
 */
async function loadLastHumanProfileEditAt(db, profileId) {
  try {
    const rows = await db.prepare(
      `SELECT updated_by, MAX(updated_at) AS mx
         FROM profile_sections
        WHERE profile_id = ?
        GROUP BY updated_by`,
    ).all(String(profileId))
    let best = NaN
    for (const r of rows || []) {
      if (isMachineWriter(r?.updated_by)) continue
      const t = parseTime(r?.mx)
      if (Number.isFinite(t) && (!Number.isFinite(best) || t > best)) best = t
    }
    return best
  } catch (err) {
    log.warn('profile_edit_read_failed', { err: err?.message })
    return NaN
  }
}

/**
 * Decide the reasons ONE portal needs a sync. Pure — all I/O is done by the
 * caller — so the whole rule is unit-testable without a database.
 *
 * @returns {Array<{code:string, detail:string, since?:string|null}>}
 */
export function evaluatePortalSyncReasons({
  lastSuccessfulSyncAtMs = NaN,
  lastAwardActivityAtMs = NaN,
  lastHumanProfileEditAtMs = NaN,
  nowMs = Date.now(),
  staleMs = staleAfterMs(),
} = {}) {
  const reasons = []
  const staleDays = Math.round(staleMs / 86_400_000)

  if (!Number.isFinite(lastSuccessfulSyncAtMs)) {
    reasons.push({
      code: SYNC_NEED_REASON.NEVER_SYNCED,
      detail: 'This portal has never completed a sync.',
      since: null,
    })
    // NEVER_SYNCED already implies everything below; adding "also stale" and
    // "also changed" would triple one prompt for one portal.
    return reasons
  }

  const age = nowMs - lastSuccessfulSyncAtMs
  if (age >= staleMs) {
    const days = Math.floor(age / 86_400_000)
    reasons.push({
      code: SYNC_NEED_REASON.STALE,
      detail: `Last synced ${days} day${days === 1 ? '' : 's'} ago (over the ${staleDays}-day limit).`,
      since: isoOrNull(lastSuccessfulSyncAtMs),
    })
  }
  if (Number.isFinite(lastAwardActivityAtMs) && lastAwardActivityAtMs > lastSuccessfulSyncAtMs) {
    reasons.push({
      code: SYNC_NEED_REASON.AWARDS_CHANGED,
      detail: 'Award activity was updated after the last sync.',
      since: isoOrNull(lastAwardActivityAtMs),
    })
  }
  if (Number.isFinite(lastHumanProfileEditAtMs) && lastHumanProfileEditAtMs > lastSuccessfulSyncAtMs) {
    reasons.push({
      code: SYNC_NEED_REASON.PROFILE_CHANGED,
      detail: 'Profile information was edited after the last sync.',
      since: isoOrNull(lastHumanProfileEditAtMs),
    })
  }
  return reasons
}

/**
 * Which portals need a sync for ONE profile, and why.
 *
 * @param {object} db
 * @param {object} arg
 * @param {string} arg.profileId          REQUIRED — there is no aggregate mode.
 * @param {number} [arg.nowMs]
 * @param {Function} [arg.loadPortals]    injectable for tests
 * @returns {Promise<{
 *   profile_id: string, checked_at: string, stale_after_days: number,
 *   portals: Array<object>, needs_sync_count: number, needs_sign_in_count: number,
 *   needs_attention: boolean
 * }>}
 */
export async function resolveProfileSyncNeeds(db, {
  profileId,
  nowMs = Date.now(),
  loadPortals = null,
} = {}) {
  const empty = {
    profile_id: profileId ? String(profileId) : null,
    checked_at: new Date(nowMs).toISOString(),
    stale_after_days: Math.round(staleAfterMs() / 86_400_000),
    portals: [],
    total_needing_action: 0,
    truncated_count: 0,
    needs_sync_count: 0,
    needs_sign_in_count: 0,
    needs_attention: false,
  }
  // No profile scope = nothing. An admin who is not working inside a profile
  // gets no prompts, never an aggregate across every profile they can access.
  if (!db || !profileId) return empty

  try {
    const portalsFn = loadPortals || ((d, p) => getProfilePortals(d, p, { refresh: false }))
    const [{ portals = [] } = {}, lastSyncByHost, lastAward, lastEdit, ledger] = await Promise.all([
      portalsFn(db, profileId).catch(() => ({ portals: [] })),
      loadLastSuccessfulSyncByHost(db, profileId),
      loadLastAwardActivityAt(db, profileId),
      loadLastHumanProfileEditAt(db, profileId),
      loadLifetimeLedger(db).catch(() => ({ version: 1, hosts: {} })),
    ])

    const staleMs = staleAfterMs()
    const out = []
    for (const portal of portals || []) {
      const host = String(portal?.portalHost || '').trim().toLowerCase()
      if (!host) continue

      const lastSuccessfulSyncAtMs = lastSyncByHost.has(host) ? lastSyncByHost.get(host) : NaN
      const everSynced = Number.isFinite(lastSuccessfulSyncAtMs)

      // ACTIONABILITY GATE: only prompt about a portal there is something to
      // keep in sync with. No session, no credential and no sync history means
      // the profile has no relationship with this portal — prompting would be
      // the "wall of noise" the owner explicitly rejected.
      if (!portal.hasSession && !portal.hasCredential && !everSynced) continue

      const reasons = evaluatePortalSyncReasons({
        lastSuccessfulSyncAtMs,
        lastAwardActivityAtMs: lastAward,
        lastHumanProfileEditAtMs: lastEdit,
        nowMs,
        staleMs,
      })
      if (reasons.length === 0) continue

      // A portal with no valid session cannot be synced — the honest ask is one
      // watched sign-in, NOT "sync now".
      const action = portal.hasSession ? SYNC_NEED_ACTION.SYNC_NOW : SYNC_NEED_ACTION.SIGN_IN
      const lifetime = summarizeHostLifetime(ledger, host)

      out.push({
        portal_host: host,
        label: portal.label || host,
        login_url: portal.loginUrl || `https://${host}`,
        action,
        reasons,
        reason_codes: reasons.map((r) => r.code),
        last_successful_sync_at: isoOrNull(lastSuccessfulSyncAtMs),
        has_session: !!portal.hasSession,
        has_credential: !!portal.hasCredential,
        supports_two_way_sync: !!portal.supportsTwoWaySync,
        // Honesty: what we have actually MEASURED about this host's session,
        // never a claim of durability we have not observed.
        session_lifetime: {
          last_confirmed_alive_at: lifetime.lastConfirmedAliveAt,
          estimate_ms: lifetime.estimateMs,
          estimate_source: lifetime.estimateSource,
          measured: lifetime.measured,
          samples: lifetime.samples,
        },
      })
    }

    // SYNC_NOW first: it is one click and immediately useful, whereas a
    // SIGN_IN needs the human to sit through a watched login. With the prompt
    // cap below, ordering sign-ins first would let a pile of one-off portals
    // (prod: 10 of them, all last touched by a bulk run on 2026-07-02) crowd
    // out every portal we could actually keep fresh today. Within a group,
    // oldest sync first.
    const actionRank = (a) => (a === SYNC_NEED_ACTION.SYNC_NOW ? 0 : 1)
    out.sort((a, b) => {
      if (a.action !== b.action) return actionRank(a.action) - actionRank(b.action)
      const ta = parseTime(a.last_successful_sync_at)
      const tb = parseTime(b.last_successful_sync_at)
      if (!Number.isFinite(ta)) return -1
      if (!Number.isFinite(tb)) return 1
      return ta - tb
    })

    // Bound the prompt, but never hide the remainder: the counts below describe
    // EVERY qualifying portal, and `truncated_count` says how many are not
    // listed. A surface that silently drops items would understate the backlog.
    const cap = maxPromptedPortals()
    const shown = out.slice(0, cap)
    const needsSignIn = out.filter((p) => p.action === SYNC_NEED_ACTION.SIGN_IN).length
    return {
      profile_id: String(profileId),
      checked_at: new Date(nowMs).toISOString(),
      stale_after_days: Math.round(staleMs / 86_400_000),
      portals: shown,
      total_needing_action: out.length,
      truncated_count: Math.max(0, out.length - shown.length),
      needs_sync_count: out.length - needsSignIn,
      needs_sign_in_count: needsSignIn,
      needs_attention: out.length > 0,
    }
  } catch (err) {
    log.warn('resolve_sync_needs_failed', { profileId: String(profileId), err: err?.message })
    return empty
  }
}

export default {
  DEFAULT_STALE_AFTER_DAYS,
  AWARD_ACTIVITY_STAGES,
  MACHINE_WRITER_RX,
  SYNC_NEED_REASON,
  SYNC_NEED_ACTION,
  isMachineWriter,
  staleAfterMs,
  evaluatePortalSyncReasons,
  resolveProfileSyncNeeds,
}
