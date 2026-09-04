import { loadProfileContext } from '../services/profileHelpers.js'
import { clamp01, jaccard, tokenize, safeJsonParse, jsonForDb, sqlNowLiteral } from './vnextUtils.js'
import { getScopedOpportunityForVnextApplication } from '../utils/scopedOpportunity.js'

/** Parse a DB field that may be a JSON array, CSV string, or already an array. */
function parseArrayField(value) {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'string') return []
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) { try { const a = JSON.parse(trimmed); if (Array.isArray(a)) return a } catch { /* fall through */ } }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean)
}
import { writeAuditEvent } from './auditEventsService.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('vnext.scoring')

function pickAmountExpected(opp) {
  const min = Number(opp?.amount_min ?? 0)
  const max = Number(opp?.amount_max ?? 0)
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max > 0) return (min + max) / 2
  if (Number.isFinite(max) && max > 0) return max
  if (Number.isFinite(min) && min > 0) return min
  return 0
}

function parseDeadlineMs(opp) {
  const raw = opp?.deadline_at || opp?.deadline || null
  if (!raw) return null
  const d = new Date(String(raw))
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

function fitScore(profileCtx, opp) {
  const profileTokens = []
  profileTokens.push(...tokenize(profileCtx?.profile?.display_name))
  profileTokens.push(...(Array.isArray(profileCtx?.profile?.interests) ? profileCtx.profile.interests.map(String) : []))
  profileTokens.push(...tokenize(profileCtx?.sections?.basic_information?.mission))
  profileTokens.push(...tokenize(profileCtx?.signals?.keywords?.join?.(' ') || ''))

  const oppTokens = []
  oppTokens.push(...tokenize(opp?.title))
  oppTokens.push(...tokenize(opp?.description))
  oppTokens.push(...parseArrayField(opp?.keywords).map(String))
  oppTokens.push(...parseArrayField(opp?.categories).map(String))

  return clamp01(0.15 + 0.85 * jaccard(profileTokens, oppTokens))
}

function complianceHours(opp) {
  const requiresMatch = opp?.requires_match === true || opp?.requires_match === 1 || String(opp?.requires_match) === 'true'
  const requires501c3 = opp?.requires_501c3 === true || opp?.requires_501c3 === 1 || String(opp?.requires_501c3) === 'true'
  let hours = 0.5
  if (requiresMatch) hours += 2
  if (requires501c3) hours += 1
  return hours
}

function effortHours({ missing, opp }) {
  const missingFields = Array.isArray(missing?.missing_fields) ? missing.missing_fields.length : 0
  const missingDocs = Array.isArray(missing?.missing_docs) ? missing.missing_docs.length : 0
  const base = 2
  const mode = String(opp?.application_mode || 'unknown').toLowerCase()
  const modeCost = mode === 'portal' ? 4 : mode === 'paper' ? 3 : 2
  return base + modeCost + missingFields * 0.75 + missingDocs * 1.25
}

function timeRisk(opp, { nowMs } = {}) {
  const deadlineMs = parseDeadlineMs(opp)
  if (!deadlineMs) return 0.25
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const days = (deadlineMs - now) / (1000 * 60 * 60 * 24)
  if (days <= 0) return 0.95
  if (days < 7) return 0.85
  if (days < 14) return 0.7
  if (days < 30) return 0.45
  return 0.25
}

function pWin({ fit, effort_hours, compliance_hours, time_risk, amount_expected }) {
  // Deterministic heuristic:
  // - higher fit increases p_win
  // - higher effort/compliance/time_risk decreases p_win
  // - very large awards slightly decrease p_win (more competition)
  const amountPenalty = amount_expected > 250_000 ? 0.12 : amount_expected > 50_000 ? 0.06 : 0.0
  const effortPenalty = clamp01((effort_hours + compliance_hours) / 60) * 0.25
  const base = 0.15 + fit * 0.55
  const raw = base * (1 - time_risk * 0.6) - effortPenalty - amountPenalty
  return clamp01(raw)
}

export async function scoreApplication(db, { applicationId, actor = null, hourly_value = 50, nowMs = null } = {}) {
  // Scoped lookup through vnext_applications.opportunity_id so a tampered or
  // stale opportunity id can never be resolved to another profile's data.
  const scoped = await getScopedOpportunityForVnextApplication(db, applicationId)
  const app = scoped.application
  if (!app) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'Application not found' } }
  }
  const opportunity = scoped.opportunity
  if (!opportunity) {
    return {
      ok: false,
      error: {
        code: scoped.reason === 'OPPORTUNITY_NOT_LINKED' ? 'OPPORTUNITY_NOT_LINKED' : 'OPPORTUNITY_NOT_FOUND',
        message: 'Opportunity not found or not linked to application',
      },
    }
  }

  const profileCtx = await loadProfileContext(db, String(app.profile_id))
  const missing = safeJsonParse(app.missing_requirements, null)

  const fit = fitScore(profileCtx, opportunity)
  const amount_expected = pickAmountExpected(opportunity)
  const compliance_hours = complianceHours(opportunity)
  const effort_hours = effortHours({ missing, opp: opportunity })
  const time_risk = timeRisk(opportunity, { nowMs })
  const p_win = pWin({ fit, effort_hours, compliance_hours, time_risk, amount_expected })

  const cost = (effort_hours + compliance_hours) * Number(hourly_value || 50)
  const value = amount_expected * p_win * fit * (1 - time_risk)
  const expected_value = value - cost

  const risk_score = clamp01(time_risk * 0.6 + (missing?.missing_fields?.length ? 0.25 : 0) + (missing?.missing_docs?.length ? 0.15 : 0))

  const breakdown = {
    fit,
    p_win,
    effort_hours,
    compliance_hours,
    time_risk,
    amount_expected,
    hourly_value: Number(hourly_value || 50),
    cost,
    value,
    expected_value,
  }

  const nowExpr = sqlNowLiteral(db)
  const before = safeJsonParse(app.score_breakdown, null)
  await db
    .prepare(
      `UPDATE vnext_applications SET score_breakdown = ?, expected_value = ?, risk_score = ?, updated_at = ${nowExpr} WHERE id = ?`,
    )
    .run(jsonForDb(db, breakdown), expected_value, risk_score, String(applicationId))

  try {
    await writeAuditEvent(db, {
      actor,
      entity_type: 'vnext_application',
      entity_id: String(applicationId),
      action: 'scoring.recomputed',
      before,
      after: breakdown,
    })
  } catch (error) {
    // Auditing is best-effort and must never roll back a claimed transition.
    log.warn('scoring.audit_failed', {
      applicationId: String(applicationId),
      action: 'scoring.recomputed',
      error: error?.message || String(error),
    })
  }

  return { ok: true, expected_value, risk_score, breakdown }
}

