/**
 * catalogRescoreSweep.js — CONTINUOUS CATALOG-WIDE RE-MATCHING (the general
 * re-scoring sweep CLAUDE.md has carried as "STILL OPEN WORK").
 *
 * ── THE HOLE, measured read-only in prod 2026-08-03T16:49Z ──────────────────
 * Of 11,050 ACTIVE non-pointer catalog rows, **641 (5.8%) have EVER carried a
 * match row for ANY profile**. Each golden profile has ~10,930+ active
 * non-pointer rows the engine has never been asked about — because
 * `profile_opportunity_matches` is a ROLLING SNAPSHOT (`persistRun` deletes a
 * profile's crawler-os rows every run and re-inserts only what THAT run
 * re-found), and the keyed recall nets (institution / field-of-study /
 * in-state aid / county-crisis) reach only the slices their keys name. The
 * engine is willing every time a pair is replayed (HOPE ACCEPT 100, Love INC
 * ACCEPT 100, AFTE ACCEPT 83); the pair is simply never put in front of it.
 *
 * Every ScholarshipOwl/Fastweb/Instrumentl-class competitor runs this loop as
 * its core product: the profile is STANDING, and new inventory is pushed
 * through it continuously — matching is a cheap repeated join, not a
 * crawl-on-demand event. This sweep is that loop, GrantFlow-style: the
 * canonical engine stays the SOLE authority, and this module only decides
 * WHICH pairs get put in front of it, bounded per run, resumable via a cursor.
 *
 * ── WHY WRITES DEFAULT ON (after the junk chain landed) ─────────────────────
 * A blind engine-adjudication of a 2,500-row sample once ACCEPTed 13.3–20.2%
 * including junk (embassy notices, federal-register). That is why writes
 * shipped OFF. The shared fundability choke point now consumes
 * `fundingResultFilters.isFundableOpportunity` + proposal-eligible kinds
 * (`passesFundabilityGate`) — the fix/qa-36-profile-junk chain. With that
 * gate live, leaving writes OFF forever is the write-only-queue anti-pattern:
 * the census reports `wouldLink` every boot while profiles stay empty.
 *
 * Default ON. `ENFORCE_CATALOG_RESCORE=0` (or false/off/no) for count-only —
 * the same convention as the older sweeps.
 *
 * ── RULES HONORED ───────────────────────────────────────────────────────────
 * - ACCEPT-ONLY writes (REVIEW is the locator band; a REJECT is never stored).
 * - matcher_version 'catalog-rescore-link' (SURFACED_MATCHER_VERSIONS carries
 *   it; the reconcile DELETE names only crawler-os/crawler-os-xmatch, so these
 *   rows survive the rolling snapshot — the same reason the keyed nets exist).
 * - Candidate discovery is a SQL PREDICATE (active, non-pointer, NOT EXISTS
 *   match) ahead of every LIMIT — never a post-LIMIT JS filter (#944/#1080).
 * - Pointer kinds are refused before the engine is called (the county-crisis
 *   posture: a directory is a pointer, never an award).
 * - Amy synthetic profiles and unconfigured profiles are skipped.
 * - Cursor state is persisted ONLY when writes are enabled: a count-only boot
 *   is a stateless census, so enabling writes later starts from the beginning
 *   instead of skipping everything the census already walked past (the
 *   "green while doing nothing" class).
 * - ON CONFLICT DO NOTHING: a profile's own crawler-os row always wins.
 */

import { isProposalEligibleOpportunity } from '../../../shared/opportunityFundability.js'
import { isFundableOpportunity } from '../../config/fundingResultFilters.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('catalog-rescore')

export const CATALOG_RESCORE_MATCHER_VERSION = 'catalog-rescore-link'
export const CATALOG_RESCORE_KV_KEY = 'catalog_rescore_cursor'

/** Rows fetched per DB round-trip (not a work bound — the budgets are). */
const BATCH_SIZE = 200

const changesOf = (res) => Number(res?.changes ?? res?.rowCount ?? 0) || 0

function envInt(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Writes DEFAULT ON once the fundability gate is wired. Opt out with
 * `ENFORCE_CATALOG_RESCORE=0` (or false/off/no) for a count-only census.
 */
export function isCatalogRescoreWriteEnabled(env = process.env) {
  const raw = String(env.ENFORCE_CATALOG_RESCORE ?? '1').trim()
  if (raw === '') return true
  return !/^(0|false|no|off)$/i.test(raw)
}

/**
 * THE FUNDABILITY CHOKE POINT. Every candidate passes here BEFORE the engine
 * is consulted. It consumes BOTH shared chains — one hook, not scattered
 * call-site checks:
 *   - `shared/opportunityFundability.js` (kind classes: never a proposal
 *     surface for DIRECTORY/BENEFIT-as-proposal/PAST_AWARD_INTEL legacy rows),
 *   - `config/fundingResultFilters.classifyFundingResult` (#1133, the
 *     fix/qa-36-profile-junk chain): regulatory/lead-gen/clearly-expired/
 *     anonymized-funder junk and signal-less rows never reach the engine.
 *     This is exactly the class the 2026-08-03 flood dry-run measured in the
 *     blind ACCEPT set (federal-register notices, embassy program rows).
 *
 * Both modules are loaded once at module initialization. This function runs on
 * every candidate row, so per-row dynamic imports would add thousands of
 * unnecessary promises to each boot census.
 */
export function passesFundabilityGate(opp) {
  return isProposalEligibleOpportunity(opp) && isFundableOpportunity(opp)
}

async function kvSet(db, key, value) {
  const now = new Date().toISOString()
  const stringValue = typeof value === 'string' ? value : JSON.stringify(value)
  const updated = await db.prepare('UPDATE system_kv SET value = ?, updated_at = ? WHERE key = ?').run(stringValue, now, key)
  if (!changesOf(updated)) {
    await db.prepare('INSERT INTO system_kv (key, value, updated_at) VALUES (?, ?, ?)').run(key, stringValue, now)
  }
}

async function kvGetJson(db, key) {
  try {
    const row = await db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key)
    if (!row?.value) return null
    return JSON.parse(row.value)
  } catch { return null }
}

/**
 * runCatalogRescoreSweep — one bounded, resumable pass.
 *
 * @param {object} db  the app DB shim (prepare().all/get/run)
 * @param {object} [opts]
 *   pairBudget    — max engine adjudications this pass (CATALOG_RESCORE_PAIR_BUDGET, 3000)
 *   timeBudgetMs  — wall-clock bound (CATALOG_RESCORE_TIME_BUDGET_MS, 20000)
 *   writeEnabled  — override the env switch (tests)
 *   deps          — { computeMatchDecision, loadProfileContext, assessProfileConfiguration } overrides (tests)
 */
export async function runCatalogRescoreSweep(db, opts = {}) {
  const startedAt = Date.now()
  const pairBudget = Number.isFinite(opts.pairBudget) ? opts.pairBudget
    : envInt(process.env.CATALOG_RESCORE_PAIR_BUDGET, 3000)
  const timeBudgetMs = Number.isFinite(opts.timeBudgetMs) ? opts.timeBudgetMs
    : envInt(process.env.CATALOG_RESCORE_TIME_BUDGET_MS, 20000)
  const writeEnabled = typeof opts.writeEnabled === 'boolean' ? opts.writeEnabled : isCatalogRescoreWriteEnabled()

  const deps = opts.deps ?? {}
  const { computeMatchDecision } = deps.computeMatchDecision
    ? { computeMatchDecision: deps.computeMatchDecision }
    : await import('../matchEngine.js')
  const { loadProfileContext } = deps.loadProfileContext
    ? { loadProfileContext: deps.loadProfileContext }
    : await import('../profileHelpers.js')
  const { assessProfileConfiguration } = deps.assessProfileConfiguration
    ? { assessProfileConfiguration: deps.assessProfileConfiguration }
    : await import('../profile/profileConfiguration.js')
  const { pointerKindSql } = await import('../../config/opportunityKindClasses.js')

  const isPg = (db?.dialect || 'sqlite') === 'postgres'
  const trueLit = isPg ? 'TRUE' : '1'
  const nowFn = isPg ? 'now()' : 'CURRENT_TIMESTAMP'
  const notPointer = `NOT (${pointerKindSql('fo.opportunity_kind')})`

  const summary = {
    ok: true,
    write_enabled: writeEnabled,
    profiles_considered: 0,
    profiles_skipped_synthetic: 0,
    profiles_skipped_unconfigured: 0,
    profiles_completed: 0,
    scanned: 0,
    not_fundable: 0,
    adjudicated: 0,
    linked: 0,
    would_link: 0,
    review: 0,
    rejected_by_engine: 0,
    unscorable: 0,
    stale_removed: 0,
    truncated: false,
    examples: [],
  }

  let profiles
  try {
    profiles = await db.prepare(
      `SELECT id, created_by FROM profiles
        WHERE (status IS NULL OR status = 'active')
        ORDER BY created_at, id`,
    ).all()
  } catch {
    try {
      profiles = await db.prepare(
        `SELECT id, NULL AS created_by FROM profiles
          WHERE (status IS NULL OR status = 'active')
          ORDER BY id`,
      ).all()
    } catch (err) {
      log.warn('profile query failed (non-fatal)', { error: String(err?.message || err) })
      return { ...summary, ok: false, skipped: 'query' }
    }
  }

  const cursor = (writeEnabled ? await kvGetJson(db, CATALOG_RESCORE_KV_KEY) : null) ?? { profiles: {}, last_profile: null }
  if (!cursor.profiles || typeof cursor.profiles !== 'object') cursor.profiles = {}

  let activeBucket = 0
  try {
    const c = await db.prepare(
      `SELECT COUNT(*) AS c FROM funding_opportunities fo
        WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})`,
    ).get()
    activeBucket = Math.floor((Number(c?.c) || 0) / 500)
  } catch { /* bucket stays 0; drift reopening degrades, sweep still runs */ }

  const ordered = [...(profiles || [])]
  if (cursor.last_profile) {
    const i = ordered.findIndex((p) => String(p.id) === String(cursor.last_profile))
    if (i >= 0) ordered.push(...ordered.splice(0, i + 1))
  }

  const spent = () => summary.adjudicated + summary.not_fundable
  const outOfBudget = () => spent() >= pairBudget || (Date.now() - startedAt) >= timeBudgetMs

  for (const p of ordered) {
    if (outOfBudget()) { summary.truncated = true; break }
    const profileId = String(p.id)
    if (String(p.created_by ?? '') === 'agent:amy') { summary.profiles_skipped_synthetic += 1; continue }

    let ctx
    try { ctx = await loadProfileContext(db, profileId) } catch { ctx = null }
    if (!ctx?.profile) continue
    try {
      const conf = assessProfileConfiguration(ctx)
      if (conf?.unconfigured) { summary.profiles_skipped_unconfigured += 1; continue }
    } catch { /* an unreadable verdict never blocks a real profile */ }

    summary.profiles_considered += 1
    const entry = cursor.profiles[profileId] ?? {}
    if (entry.completed_at && entry.active_bucket === activeBucket) continue
    if (entry.completed_at && entry.active_bucket !== activeBucket) {
      delete entry.completed_at
      delete entry.watermark
    }

    let watermark = entry.watermark ?? null
    let profileDone = false
    while (!profileDone && !outOfBudget()) {
      const remaining = Math.max(1, Math.min(BATCH_SIZE, pairBudget - spent()))
      let rows
      try {
        const whereMark = watermark
          ? `AND (fo.created_at > ? OR (fo.created_at = ? AND fo.id > ?))`
          : ''
        const params = watermark ? [watermark.created_at, watermark.created_at, watermark.id] : []
        rows = await db.prepare(
          `SELECT fo.* FROM funding_opportunities fo
            WHERE (fo.is_active IS NULL OR fo.is_active = ${trueLit})
              AND ${notPointer}
              ${whereMark}
              AND NOT EXISTS (SELECT 1 FROM profile_opportunity_matches m
                              WHERE m.profile_id = ? AND m.opportunity_id = fo.id)
            ORDER BY fo.created_at, fo.id
            LIMIT ?`,
        ).all(...params, profileId, remaining)
      } catch (err) {
        log.warn('candidate query failed (non-fatal)', { profile: profileId, error: String(err?.message || err) })
        break
      }

      for (const opp of rows || []) {
        summary.scanned += 1
        watermark = { created_at: opp.created_at, id: opp.id }
        if (!passesFundabilityGate(opp)) { summary.not_fundable += 1; continue }
        let decision
        try { decision = computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections }) }
        catch { summary.unscorable += 1; summary.adjudicated += 1; continue }
        summary.adjudicated += 1
        const verdict = String(decision?.decision ?? '').toUpperCase()
        if (verdict === 'REVIEW') { summary.review += 1; continue }
        if (verdict !== 'ACCEPT') { summary.rejected_by_engine += 1; continue }
        const score = Number.isFinite(Number(decision?.score)) ? Math.round(Number(decision.score)) : null
        if (score === null) { summary.unscorable += 1; continue }

        if (!writeEnabled) {
          summary.would_link += 1
          if (summary.examples.length < 5) summary.examples.push(`${opp.title} (ACCEPT ${score})`)
          continue
        }
        try {
          const res = await db.prepare(
            `INSERT INTO profile_opportunity_matches
               (id, profile_id, opportunity_id, match_score, match_decision, match_explanation,
                match_reasons, match_explain_json, source_query, discovered_via, matcher_version,
                computed_at, updated_at, evaluated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${CATALOG_RESCORE_MATCHER_VERSION}', ${nowFn}, ${nowFn}, ${nowFn})
             ON CONFLICT (profile_id, opportunity_id) DO NOTHING`,
          ).run(
            `cr:${profileId}:${opp.id}`, profileId, opp.id, score, 'accept',
            decision?.explanation ?? null,
            JSON.stringify(decision?.matchedNeeds ?? []),
            JSON.stringify({ gate: 'catalog_rescore' }),
            null, 'catalog_rescore',
          )
          if (changesOf(res) > 0) {
            summary.linked += 1
            if (summary.examples.length < 5) summary.examples.push(`${opp.title} (ACCEPT ${score})`)
          }
        } catch (err) {
          log.warn('insert failed (non-fatal)', { profile: profileId, opportunity: opp.id, error: String(err?.message || err) })
        }
        if (outOfBudget()) break
      }

      if (!rows || rows.length < remaining) profileDone = !outOfBudget()
      if (!rows || rows.length === 0) break
    }

    if (writeEnabled) {
      cursor.profiles[profileId] = {
        ...(watermark ? { watermark } : {}),
        ...(profileDone ? { completed_at: new Date().toISOString(), active_bucket: activeBucket } : {}),
      }
      cursor.last_profile = profileId
    }
    if (profileDone) summary.profiles_completed += 1
  }
  if (outOfBudget() && !summary.truncated) {
    // Both bounds are truncation. A time-limited pass that happened to finish
    // the last profile in the list is still incomplete and must not report a
    // full sweep merely because the pair counter remained below its ceiling.
    summary.truncated = true
  }

  if (writeEnabled) {
    try {
      const doomed = await db.prepare(
        `SELECT m.id FROM profile_opportunity_matches m
          JOIN funding_opportunities fo ON fo.id = m.opportunity_id
         WHERE m.matcher_version = '${CATALOG_RESCORE_MATCHER_VERSION}'
           AND fo.is_active IS NOT NULL AND fo.is_active <> ${trueLit}
         LIMIT 500`,
      ).all()
      for (let i = 0; i < (doomed?.length ?? 0); i += 200) {
        const slice = doomed.slice(i, i + 200).map((r) => r.id)
        const ph = slice.map(() => '?').join(', ')
        const res = await db.prepare(`DELETE FROM profile_opportunity_matches WHERE id IN (${ph})`).run(...slice)
        summary.stale_removed += changesOf(res) || slice.length
      }
    } catch { /* convergence is best-effort; never fails the sweep */ }
    try { await kvSet(db, CATALOG_RESCORE_KV_KEY, cursor) } catch { /* cursor loss = re-scan, never corruption */ }
  }

  summary.elapsed_ms = Date.now() - startedAt
  if (!writeEnabled && summary.would_link > 0) {
    log.info('catalog rescore census: writes DISABLED (ENFORCE_CATALOG_RESCORE=0) — engine ACCEPTs waiting', {
      would_link: summary.would_link, adjudicated: summary.adjudicated, examples: summary.examples,
    })
  }
  return summary
}

export default {
  CATALOG_RESCORE_MATCHER_VERSION,
  CATALOG_RESCORE_KV_KEY,
  isCatalogRescoreWriteEnabled,
  passesFundabilityGate,
  runCatalogRescoreSweep,
}
