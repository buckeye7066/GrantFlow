/**
 * robertFunderLeads.js — Robert's national-funder pipeline flow.
 *
 * OWNER DIRECTIVE (2026-08-23): "You already have a pretty good idea of who these
 * national funders are — wire Robert to AUTONOMOUSLY CRAWL them into GrantFlow's
 * database, then, after closer inspection, ones that he finds meet our criteria
 * for a match, AUTOMATICALLY add them to a profile." And (refinement): a funder
 * Robert adds is a "potential source, UNDER ACTIVE INVESTIGATION" — Robert works
 * each lead toward a verdict; only a lead investigation confirms has a real
 * applicable application path is PROMOTED to the funding-source (apply-ready)
 * side where Hamilton handles it.
 *
 * TWO OPERATIONS, both bounded + idempotent, no dry-run:
 *
 *   admitFunderLeads       — for each profile, over the national 990-funder
 *                            catalog slice, run Robert's FOUR-GATE qualification
 *                            (REAL / RELATABLE / COVERS-A-DECLARED-NEED /
 *                            QUALIFIES on type+geo+eligibility+recipient-type)
 *                            gated on QUALIFICATION, NOT the ratio-score floor,
 *                            and AUTO-ADD each qualifying funder to the pipeline
 *                            as a FUNDER_LEAD (never apply-ready). A funder with
 *                            a NATIONAL FOOTPRINT (gave for the cause in >= 5
 *                            distinct states) is admitted alongside in-state
 *                            givers, so orgs in small states reach national
 *                            funders of their cause.
 *
 *   investigateFunderLeads — Robert's "closer inspection": work each lead toward
 *                            a verdict. If the funder has a usable application
 *                            path, PROMOTE it to apply-ready (it "comes over" to
 *                            the funding-source side and Hamilton handles it).
 *                            Otherwise record what was found and leave it a lead
 *                            (bounded attempts -> not_applicable, labeled, never
 *                            silently promoted, never cold-submitted).
 *
 * WHY the score floor is bypassed: all 990 funder rows are opportunity_kind
 * 'directory' (grantmakers), so the canonical ratio-score reads REVIEW ~2 (a
 * grantmaker row states few of the ~70 data points the score measures). The
 * owner's criteria are QUALIFICATION-based (real/relatable/covers-need/
 * qualifies), not score — so a genuinely-qualifying national funder must not be
 * dropped on its low grantmaker-row score. RELEVANCE_FLOOR is NOT lowered
 * fleet-wide (it keeps junk out everywhere); it is bypassed ONLY on this
 * four-gate funder-lead path.
 *
 * SAFETY: a FUNDER_LEAD is NEVER selected by Hamilton's auto-submit
 * (config/pipelineCategory.js + routes/hamiltonAutomation.js listReadySources).
 * A foundation that funds by relationship/invitation must never receive a cold
 * auto-submitted application.
 */

import crypto from 'crypto'
import { createLogger } from '../../utils/logger.js'
import { PIPELINE_CATEGORY, FUNDER_LEAD_STATE, hasUsableApplyPath } from '../../config/pipelineCategory.js'
import {
  declaredNeedsOf,
  purposeLikePatternsForNeeds,
  analyzeFunderFit,
  NATIONAL_FOOTPRINT_MIN_STATES,
} from '../../config/funderBehavior.js'
import { normalizeNeedCategory, NEED_ALIAS_MAP } from '../profileNormalizer.js'
import { classifyFundingResult, RESULT_BUCKETS } from '../../config/fundingResultFilters.js'
import { isDismissed } from '../pipelineDismissals.js'

const log = createLogger('robert-funder-leads')

export const FUNDER_LEAD_MATCHER_VERSION = 'funder-lead'
/** How many funder leads a single profile may hold (a research list, not noise). */
export const FUNDER_LEAD_MAX_PER_PROFILE = boundedInt('FUNDER_LEAD_MAX_PER_PROFILE', 25, 1)
/** Fleet-wide write cap per admission pass. */
export const FUNDER_LEAD_LINK_LIMIT = boundedInt('FUNDER_LEAD_LINK_LIMIT', 500, 1)
/** Superset transactions loaded per funder to adjudicate footprint/recipient. */
const FUNDER_TX_SAMPLE = boundedInt('FUNDER_LEAD_TX_SAMPLE', 800, 50)
/** Candidate funder rows scanned per profile. */
const FUNDER_CANDIDATE_LIMIT = boundedInt('FUNDER_LEAD_CANDIDATE_LIMIT', 400, 1)

function boundedInt(envName, dflt, min) {
  const n = Number.parseInt(process.env[envName] || '', 10)
  return Number.isFinite(n) && n >= min ? n : dflt
}

function parseBoolEnv(v) {
  if (v === undefined || v === null || v === '') return null
  return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
}

function isPg(db) {
  return (db?.dialect || 'sqlite') === 'postgres'
}

async function tableExists(db, table) {
  try { await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(); return true } catch { return false }
}

async function grantColumnSet(db) {
  try {
    if (isPg(db)) {
      const rows = await db
        .prepare("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='grants'")
        .all()
      return new Set((rows || []).map((r) => String(r.column_name)))
    }
    const rows = await db.prepare('PRAGMA table_info(grants)').all()
    return new Set((rows || []).map((r) => String(r.name)))
  } catch { return new Set() }
}

async function loadProfileCtx(db, profileId) {
  let profile = null
  try { profile = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId)) } catch { profile = null }
  if (!profile) return null
  const sections = {}
  try {
    const rows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(String(profileId))
    for (const s of rows || []) {
      if (!s?.section_key) continue
      let parsed = s.data
      if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed) } catch { parsed = null } }
      if (parsed && typeof parsed === 'object') sections[s.section_key] = parsed
    }
  } catch { /* degraded schema — proceed with what we have */ }
  return { profile, sections }
}

/**
 * Robert's four gates for a FUNDER lead (distinct from the leaf-application
 * gates — a funder is a relationship prospect, not a form to fill). Delegates:
 *   REAL       — a filed 990 funder with a source URL, not expired/junk
 *   RELATABLE  — a genuine grantmaker (propublica_990, not a NOT_A_GRANT record)
 *   COVERS     — its OWN filed giving evidences a declared need (analyzeFunderFit)
 *   QUALIFIES  — footprint (in-state OR national) + recipient-type fit
 *
 * Returns { pass, reason, fit } — reason names the failing gate when !pass.
 */
export function qualifyFunderLead({ row, fit, facts, deps }) {
  const { deriveProfileFacts, gateQualifies, isIndividualLikeProfileType } = deps
  // REAL — a funder with a source page. (Deadlines/expiry do not apply to a
  // standing grantmaker; the 990 row always carries the ProPublica org page.)
  const url = row?.application_url || row?.source_url || row?.url || null
  if (!url) return { pass: false, reason: 'real:no_url', fit }

  // RELATABLE — a genuine grantmaker record, not regulatory/lead-gen/anonymized junk.
  const classification = classifyFundingResult(row)
  if (classification.bucket === RESULT_BUCKETS.NOT_A_GRANT) {
    return { pass: false, reason: `relatable:${classification.reasons?.[0] ?? 'not_a_grant'}`, fit }
  }
  const funderName = String(row?.sponsor || row?.title || '').trim()
  if (!funderName) return { pass: false, reason: 'relatable:no_funder_name', fit }

  // COVERS A NEED — the funder's OWN filed giving evidences a declared need.
  if (!(fit.evidencingCount > 0)) return { pass: false, reason: 'covers_need:no_evidenced_giving', fit }

  // QUALIFIES — applicant type / geo / eligibility (neutral for a bare funder
  // row) via the canonical gate, PLUS the two funder-specific conditions.
  const qual = gateQualifies(row, facts)
  if (!qual.pass) return { pass: false, reason: `qualifies:${qual.reason ?? 'mismatch'}`, fit }

  // Footprint: in-state OR a national footprint (>= N distinct states). A funder
  // that gave for the cause in only 1-2 OTHER states is geographically
  // restricted and is NOT offered.
  if (!fit.inState && !fit.nationalFootprint) {
    return { pass: false, reason: 'qualifies:not_reachable_footprint', fit }
  }

  // Recipient-type: a private foundation that gives org-to-org cannot be
  // applied to by an INDIVIDUAL. An individual-root profile qualifies only when
  // the funder's filings NAME individual recipients (RecipientPersonNm). Legacy
  // transactions predate recipient-type capture, so an individual profile gains
  // funder leads only as the ingest backfills that flag — deliberately
  // conservative (no foundation flood onto individuals).
  const individual = isIndividualLikeProfileType(facts.applicantType)
  if (individual && !fit.fundsIndividuals) {
    return { pass: false, reason: 'qualifies:foundation_funds_orgs_not_individuals', fit }
  }

  return { pass: true, reason: null, fit }
}

/**
 * Admit qualifying national funders as FUNDER_LEAD rows for the given profiles.
 *
 * @returns accounting summary (scanned funders adjudicated, added, per-profile
 *   caps hit, would-add when count-only, examples).
 */
export async function admitFunderLeads(db, {
  profileIds = null,
  writeLimit = FUNDER_LEAD_LINK_LIMIT,
  perProfileCap = FUNDER_LEAD_MAX_PER_PROFILE,
  countOnly = parseBoolEnv(process.env.ENFORCE_FUNDER_LEAD_ADMISSION) === false,
} = {}) {
  const out = {
    profiles: 0, scanned: 0, added: 0, wouldAdd: 0, skippedExisting: 0,
    skippedTombstoned: 0, byReason: {}, perProfileCapped: 0, truncated: false,
    examples: [], skipped: null, enforced: true,
  }
  if (!(await tableExists(db, 'grant_transactions')) || !(await tableExists(db, 'funding_opportunities'))) {
    out.skipped = 'schema'; return out
  }
  const cols = await grantColumnSet(db)
  if (!cols.has('pipeline_category')) { out.skipped = 'schema:pipeline_category'; return out }

  // Deps imported lazily so a degraded deployment reports skipped, never throws.
  let deps
  try {
    const audit = await import('./robertPipelineAudit.js')
    const engine = await import('../matchEngine.js')
    deps = {
      deriveProfileFacts: audit.deriveProfileFacts,
      gateQualifies: audit.gateQualifies,
      isIndividualLikeProfileType: engine.isIndividualLikeProfileType,
      computeMatchDecision: engine.computeMatchDecision,
    }
  } catch (err) {
    log.warn('funder-lead admission: deps unavailable (non-fatal)', { error: String(err?.message || err) })
    out.skipped = 'deps'; return out
  }

  let ids = Array.isArray(profileIds) && profileIds.length ? profileIds.map(String) : null
  if (!ids) {
    try {
      const rows = await db.prepare("SELECT id FROM profiles WHERE (deleted_at IS NULL) AND (status IS NULL OR status <> 'deleted')").all()
      ids = (rows || []).map((r) => String(r.id))
    } catch {
      try { ids = (await db.prepare('SELECT id FROM profiles').all() || []).map((r) => String(r.id)) } catch { ids = [] }
    }
  }

  const trueLit = isPg(db) ? 'TRUE' : '1'
  const bump = (reason) => { out.byReason[reason] = (out.byReason[reason] || 0) + 1 }

  for (const profileId of ids) {
    if (out.added + out.wouldAdd >= writeLimit) { out.truncated = true; break }
    const ctx = await loadProfileCtx(db, profileId)
    if (!ctx) continue

    let facts
    try { facts = deps.deriveProfileFacts(ctx.profile, ctx.sections, { profileId }) } catch { continue }

    let state = null
    try {
      const df = await import('../../config/profileDerivedFacts.js')
      const derived = df.deriveProfileFacts(ctx.profile, ctx.sections)
      state = String(derived?.place?.state || '').toUpperCase() || null
    } catch { state = null }

    let needs
    try { needs = declaredNeedsOf(ctx.profile, ctx.sections, normalizeNeedCategory, NEED_ALIAS_MAP) } catch { needs = new Set() }
    // MISSING = NEUTRAL: no declared need means we cannot say what to fund.
    if (!needs || needs.size === 0) continue
    out.profiles += 1

    const likePatterns = purposeLikePatternsForNeeds([...needs])
    if (!likePatterns.length) continue
    // SAFE BY CONSTRUCTION: this is a fixed literal repeated once per pattern and
    // joined with OR — no caller data reaches the SQL text. The patterns
    // themselves are bound as ? parameters below (…all(...likePatterns, …)).
    const safeLikeSql = likePatterns.map(() => "LOWER(COALESCE(t.purpose,'')) LIKE ?").join(' OR ')

    let candidates
    try {
      candidates = await db.prepare(
        `SELECT fo.* FROM funding_opportunities fo
          WHERE fo.source = 'propublica_990'
            AND (fo.is_active IS NULL OR fo.is_active = ${trueLit})
            AND EXISTS (
              SELECT 1 FROM grant_transactions t
               WHERE t.funder_ein = fo.source_id AND (${safeLikeSql})
            )
            AND NOT EXISTS (
              SELECT 1 FROM grants g WHERE g.profile_id = ? AND g.funding_opportunity_id = fo.id
            )
          ORDER BY fo.created_at
          LIMIT ?`,
      ).all(...likePatterns, profileId, FUNDER_CANDIDATE_LIMIT)
    } catch (err) {
      log.warn('funder-lead admission: candidate query failed (non-fatal)', { profile: profileId, error: String(err?.message || err) })
      continue
    }

    // Adjudicate + rank by giving amount so a per-profile cap keeps the biggest funders.
    const qualified = []
    for (const opp of candidates || []) {
      let txs
      try {
        txs = await db.prepare(
          `SELECT t.recipient_name, t.recipient_state, t.recipient_is_individual, t.amount, t.purpose
             FROM grant_transactions t WHERE t.funder_ein = ? AND (${safeLikeSql})
             ORDER BY t.amount DESC LIMIT ?`,
        ).all(opp.source_id, ...likePatterns, FUNDER_TX_SAMPLE)
      } catch { continue }
      const fit = analyzeFunderFit(txs, needs, { profileState: state })
      out.scanned += 1
      const verdict = qualifyFunderLead({ row: opp, fit, facts, deps })
      if (!verdict.pass) { bump(verdict.reason); continue }
      qualified.push({ opp, fit })
    }
    qualified.sort((a, b) => (b.fit.topAmount || 0) - (a.fit.topAmount || 0))

    let addedThisProfile = 0
    for (const { opp, fit } of qualified) {
      if (addedThisProfile >= perProfileCap) { out.perProfileCapped += 1; break }
      if (out.added + out.wouldAdd >= writeLimit) { out.truncated = true; break }

      // Tombstone: a funder the user explicitly removed stays gone (manual re-add clears it).
      try { if (await isDismissed(db, profileId, opp)) { out.skippedTombstoned += 1; continue } } catch { /* recall over suppression */ }

      // Informational score only — admission does NOT gate on it.
      let score = null
      let decisionStr = 'review'
      try {
        const d = deps.computeMatchDecision(ctx.profile, opp, { profileSections: ctx.sections })
        if (Number.isFinite(Number(d?.score))) score = Math.round(Number(d.score))
        if (d?.decision) decisionStr = String(d.decision).toLowerCase()
      } catch { /* score stays null; funder gates already passed */ }

      if (countOnly) {
        out.wouldAdd += 1
        if (out.examples.length < 5) out.examples.push(`${opp.sponsor ?? opp.title} (${state ?? '?'}, states ${fit.distinctStates}${fit.inState ? '+in-state' : ''})`)
        addedThisProfile += 1
        continue
      }

      const noteLine =
        `Robert funder lead: ${opp.sponsor ?? opp.title} — demonstrated giving for ` +
        `[${[...needs].slice(0, 6).join(', ')}] in ${fit.distinctStates} state(s)` +
        `${fit.inState ? ' incl. in-state' : ''}${fit.nationalFootprint ? ` (national footprint >= ${NATIONAL_FOOTPRINT_MIN_STATES})` : ''}` +
        `${fit.fundsIndividuals ? '; funds individuals' : ''}. Under investigation — confirm an application path before applying.`

      try {
        const grantId = crypto.randomUUID()
        const insCols = ['id', 'profile_id', 'funding_opportunity_id', 'title', 'funder', 'status', 'notes', 'pipeline_category', 'funder_lead_state']
        const insVals = [grantId, profileId, opp.id, opp.title, opp.sponsor || opp.title || null, 'interested', noteLine, PIPELINE_CATEGORY.FUNDER_LEAD, FUNDER_LEAD_STATE.CANDIDATE]
        const optional = [
          ['organization_id', ctx.profile.organization_id ?? null],
          ['match_score', score],
          ['match_decision', decisionStr],
          ['matcher_version', FUNDER_LEAD_MATCHER_VERSION],
          ['source_url', opp.source_url ?? null],
          ['url', opp.source_url ?? null],
        ]
        for (const [c, v] of optional) if (cols.has(c)) { insCols.push(c); insVals.push(v) }
        const ph = insCols.map(() => '?').join(', ')
        await db.prepare(`INSERT INTO grants (${insCols.join(', ')}) VALUES (${ph})`).run(...insVals)
        out.added += 1
        addedThisProfile += 1
        if (out.examples.length < 5) out.examples.push(`${opp.sponsor ?? opp.title} (${state ?? '?'}, states ${fit.distinctStates}${fit.inState ? '+in-state' : ''})`)
      } catch (err) {
        const msg = String(err?.message || '').toLowerCase()
        if (msg.includes('unique') || msg.includes('duplicate')) { out.skippedExisting += 1; continue }
        log.warn('funder-lead admission: insert failed (non-fatal)', { profile: profileId, opportunity: opp.id, error: String(err?.message || err) })
      }
    }
  }

  return out
}

/**
 * A funder-lead grant is PROMOTED to apply-ready when it has a usable
 * application path. This is the single transition that lets a funder reach
 * Hamilton's auto-submit. Idempotent; a row without an apply path is untouched.
 *
 * @returns true iff a promotion happened.
 */
export async function promoteFunderLeadIfApplicable(db, grantRow, cols = null) {
  if (!grantRow) return false
  if (!hasUsableApplyPath(grantRow)) return false
  const columns = cols || (await grantColumnSet(db))
  const sets = ['pipeline_category = ?']
  const vals = [PIPELINE_CATEGORY.APPLY_READY]
  if (columns.has('funder_lead_state')) { sets.push('funder_lead_state = ?'); vals.push(FUNDER_LEAD_STATE.PROMOTED) }
  if (columns.has('status')) {
    // A promoted funder is now a workable opportunity; a research 'interested'
    // row moves to 'saved' so the apply-ready pipeline picks it up. Never
    // touches a further-progressed status.
    sets.push("status = CASE WHEN status IN ('interested','discovered') THEN 'saved' ELSE status END")
  }
  if (columns.has('updated_at')) sets.push(`updated_at = ${isPg(db) ? 'now()' : 'CURRENT_TIMESTAMP'}`)
  vals.push(grantRow.id)
  try {
    await db.prepare(`UPDATE grants SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    return true
  } catch (err) {
    log.warn('funder-lead promotion: update failed (non-fatal)', { grant: grantRow.id, error: String(err?.message || err) })
    return false
  }
}

const MAX_INVESTIGATE_ATTEMPTS = boundedInt('FUNDER_LEAD_MAX_ATTEMPTS', 3, 1)
const APPLICATION_PATH_RX = /\/(apply|application|applications|grants?|funding|how-to-apply|eligibility|guidelines|rfp|nofo|proposal)s?(\/|$|\?|#)/i

/** A discovered URL that looks like an application/grants PATH, not a bare homepage. */
export function looksLikeApplicationPath(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false
  try { return APPLICATION_PATH_RX.test(new URL(url).pathname + (new URL(url).search || '')) } catch { return false }
}

/**
 * Robert's active investigation of funder leads: work each toward a verdict.
 *
 *   1. Already has a usable apply path  -> PROMOTE (no network).
 *   2. Otherwise search for the funder's official application page; if a live
 *      URL that looks like an application PATH is found, set it and PROMOTE.
 *   3. A live homepage (no apply path) is recorded as a research lead; the row
 *      stays a lead, attempts++ (bounded -> not_applicable, labeled).
 *   4. A search-provider outage (0 hits) never burns an attempt.
 *
 * Bounded per pass (FUNDER_LEAD_INVESTIGATE_LIMIT, time budget). Fewest-attempts
 * first so a permanently-unreachable funder never starves fresh leads.
 */
export async function investigateFunderLeads(db, {
  limit = boundedInt('FUNDER_LEAD_INVESTIGATE_LIMIT', 8, 1),
  timeBudgetMs = boundedInt('FUNDER_LEAD_INVESTIGATE_BUDGET_MS', 20000, 1000),
  findUrl = null,
  now = Date.now(),
} = {}) {
  const out = { scanned: 0, promoted: 0, investigated: 0, notApplicable: 0, deferredOutage: 0, skipped: null, enforced: true }
  const cols = await grantColumnSet(db)
  if (!cols.has('pipeline_category')) { out.skipped = 'schema'; return out }
  const hasState = cols.has('funder_lead_state')
  const hasAttempts = cols.has('funder_lead_attempts')
  const hasInvestigatedAt = cols.has('funder_lead_last_investigated_at')

  let findOfficialUrlForOpportunity = findUrl
  if (!findOfficialUrlForOpportunity) {
    try { ({ findOfficialUrlForOpportunity } = await import('../urlEnrichment.js')) }
    catch { out.skipped = 'deps'; return out }
  }

  // Candidates: funder leads not yet promoted, fewest-attempts first.
  let rows
  try {
    const stateFilter = hasState ? `AND (funder_lead_state IS NULL OR funder_lead_state IN ('candidate','investigated'))` : ''
    // SAFE BY CONSTRUCTION: a ternary over two compile-time literals, selected by
    // a column-existence flag — no caller data reaches the SQL text.
    const safeOrderBy = hasAttempts ? 'COALESCE(funder_lead_attempts,0) ASC, updated_at ASC' : 'updated_at ASC'
    rows = await db.prepare(
      `SELECT id, title, funder, application_url, portal_url, url, source_url
         ${hasAttempts ? ', funder_lead_attempts' : ''}
         FROM grants
        WHERE LOWER(COALESCE(pipeline_category,'')) = '${PIPELINE_CATEGORY.FUNDER_LEAD}'
          ${stateFilter}
        ORDER BY ${safeOrderBy}
        LIMIT ?`,
    ).all(limit)
  } catch (err) {
    log.warn('funder-lead investigation: candidate query failed (non-fatal)', { error: String(err?.message || err) })
    out.skipped = 'query'; return out
  }

  const start = Date.now()
  for (const row of rows || []) {
    if (Date.now() - start > timeBudgetMs) break
    out.scanned += 1

    // 1. Already applicable -> promote.
    if (hasUsableApplyPath(row)) {
      if (await promoteFunderLeadIfApplicable(db, row, cols)) out.promoted += 1
      continue
    }

    // 2/3. Search for a real application path.
    let found = null
    try {
      found = await findOfficialUrlForOpportunity({ title: row.funder || row.title, sponsor: row.funder || null })
    } catch (err) {
      found = { url: null, searched: false, error: String(err?.message || err) }
    }
    if (found && found.searched === true && (found.hits === 0)) {
      out.deferredOutage += 1 // provider returned nothing — do not burn an attempt
      continue
    }
    if (found?.url && looksLikeApplicationPath(found.url)) {
      // A real application path — set it and promote.
      const promoted = await setApplyPathAndPromote(db, row.id, found.url, cols)
      if (promoted) { out.promoted += 1; continue }
    }

    // 4. No application path this pass — record research + count an attempt.
    const attempts = (Number(row.funder_lead_attempts) || 0) + 1
    const nextState = attempts >= MAX_INVESTIGATE_ATTEMPTS ? FUNDER_LEAD_STATE.NOT_APPLICABLE : FUNDER_LEAD_STATE.INVESTIGATED
    const sets = []
    const vals = []
    if (hasState) { sets.push('funder_lead_state = ?'); vals.push(nextState) }
    if (hasAttempts) { sets.push('funder_lead_attempts = ?'); vals.push(attempts) }
    if (hasInvestigatedAt) { sets.push(`funder_lead_last_investigated_at = ${isPg(db) ? 'now()' : 'CURRENT_TIMESTAMP'}`) }
    if (found?.url && cols.has('notes')) {
      // Record the funder's site as a research lead (a homepage is a contact,
      // not an application form — a human/relationship step still applies).
      sets.push('notes = ?')
      vals.push(`Robert investigated: funder site ${found.url} found (no self-serve application path detected). Relationship/research step needed.`)
    }
    if (!sets.length) { out.investigated += 1; continue }
    vals.push(row.id)
    try {
      await db.prepare(`UPDATE grants SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
      if (nextState === FUNDER_LEAD_STATE.NOT_APPLICABLE) out.notApplicable += 1
      else out.investigated += 1
    } catch (err) {
      log.warn('funder-lead investigation: update failed (non-fatal)', { grant: row.id, error: String(err?.message || err) })
    }
  }
  return out
}

async function setApplyPathAndPromote(db, grantId, url, cols) {
  const sets = ['pipeline_category = ?']
  const vals = [PIPELINE_CATEGORY.APPLY_READY]
  if (cols.has('application_url')) { sets.push('application_url = ?'); vals.push(url) }
  if (cols.has('url')) { sets.push('url = ?'); vals.push(url) }
  if (cols.has('funder_lead_state')) { sets.push('funder_lead_state = ?'); vals.push(FUNDER_LEAD_STATE.PROMOTED) }
  if (cols.has('status')) sets.push("status = CASE WHEN status IN ('interested','discovered') THEN 'saved' ELSE status END")
  if (cols.has('updated_at')) sets.push(`updated_at = ${isPg(db) ? 'now()' : 'CURRENT_TIMESTAMP'}`)
  vals.push(grantId)
  try { await db.prepare(`UPDATE grants SET ${sets.join(', ')} WHERE id = ?`).run(...vals); return true }
  catch (err) { log.warn('funder-lead promote-with-path failed (non-fatal)', { grant: grantId, error: String(err?.message || err) }); return false }
}

export default {
  admitFunderLeads,
  investigateFunderLeads,
  promoteFunderLeadIfApplicable,
  qualifyFunderLead,
  looksLikeApplicationPath,
  FUNDER_LEAD_MATCHER_VERSION,
}
