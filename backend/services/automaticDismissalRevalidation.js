// A machine rejection can be superseded by newer positive source evidence.
// Owner intent cannot. No time-based expiry or score-only restoration exists.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { ensurePipelineDismissalsSchema, buildDismissalKey } from './pipelineDismissals.js'
import { isAutomaticGateDismissal, withDismissalProfileTransaction, archiveDismissal, readLockedDismissals } from './pipelineDismissalPolicy.js'
import { hasPositiveFourTruthProof, fundingTruthProofFrom } from '../config/fundingTruthPolicy.js'

const parse = value => {
  if (value && typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}
const stamp = value => Date.parse(value instanceof Date ? value.toISOString() : String(value ?? ''))
const canonical = value => value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const hash = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const lower = value => String(value ?? '').trim().toLowerCase()

async function tableExists(db, name) {
  const row = db.dialect === 'postgres'
    ? await db.prepare('SELECT to_regclass(?) AS name').get(name)
    : await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  return Boolean(row?.name)
}

export async function evaluateCurrentDismissalGates(tx, opportunity, profileId) {
  const { loadProfileFacts, gateRelatable, gateQualifies, gateCoversNeed, gateRealOffline } = await import('./robert/robertPipelineAudit.js')
  const { computeMatchDecision } = await import('./matchEngine.js')
  const facts = await loadProfileFacts(tx, profileId, { strict: true })
  if (!facts?.profile || facts.protectedProfile || facts.profile.deleted_at || ['deleted','archived','inactive','merged'].includes(lower(facts.profile.status))) return { pass: false, reason: 'profile_unavailable' }
  const decision = computeMatchDecision(facts.profile, opportunity, { profileSections: facts.sections })
  const gates = {
    relatable: gateRelatable(opportunity).pass === true,
    qualifies: gateQualifies(opportunity, facts).pass === true,
    covers_need: gateCoversNeed(opportunity, facts).pass === true,
    // Network reality comes from the fresh complete crawl proof checked below;
    // the same deterministic current lifecycle rules must also still allow it.
    real: gateRealOffline(opportunity)?.pass !== false,
    engine: String(decision?.decision).toUpperCase() === 'ACCEPT',
  }
  return { pass: Object.values(gates).every(Boolean), gates, profile_facts_sha256: hash({ profile: facts.profile, sections: facts.sections }), canonical_score: decision.score }
}

function sameIdentity(tombstone, opportunity) {
  const key = buildDismissalKey({ opportunity })
  return tombstone.opportunity_id === opportunity.id ||
    Boolean(tombstone.fingerprint && tombstone.fingerprint === key.fingerprint) ||
    Boolean(tombstone.title && lower(tombstone.title) === lower(opportunity.title))
}

function identifiesPair(value, profileId, opportunityId, event) {
  if (!value || typeof value !== 'object') return false
  const profile = value.profile_id ?? value.profileId ?? (event.entity_type === 'profile' ? event.entity_id : null)
  const opportunity = value.opportunity_id ?? value.funding_opportunity_id ?? value.opportunityId ??
    (['opportunity','funding_opportunity'].includes(event.entity_type) ? event.entity_id : null)
  if (profile === profileId && opportunity === opportunityId) return true
  return Object.values(value).some(child => child && typeof child === 'object' && identifiesPair(child, profileId, opportunityId, event))
}

async function hasAuthoritativeUserDismissal(tx, profileId, opportunityId) {
  const events = await tx.prepare(`SELECT actor_type, entity_type, entity_id, action, before_json, after_json FROM audit_events
    WHERE actor_type = 'user' AND (entity_id = ? OR CAST(before_json AS TEXT) LIKE ? OR CAST(after_json AS TEXT) LIKE ?)`)
    .all(opportunityId, `%${opportunityId}%`, `%${opportunityId}%`)
  return events.some(event => {
    const actions = lower(event.action).split(/[^a-z]+/)
    if (!actions.some(action => ['delete','deleted','dismiss','dismissed','remove','removed'].includes(action))) return false
    return identifiesPair(parse(event.before_json), profileId, opportunityId, event) || identifiesPair(parse(event.after_json), profileId, opportunityId, event)
  })
}

export async function revalidateAutomaticDismissalsAfterCrawl(db, {
  profileId, run, idRemap = null, evaluateCurrent = evaluateCurrentDismissalGates, limit = 200,
} = {}) {
  const enteredAt = Date.now()
  const summary = { scanned: 0, revalidated: 0, blocked: 0, truncated: false }
  const started = stamp(run?.started_at), finished = stamp(run?.finished_at)
  if (!profileId || run?.profile_id !== profileId || !run?.run_id || !Number.isFinite(started) || !Number.isFinite(finished) || finished < started || finished > enteredAt) return { ...summary, reason: 'incomplete_own_crawl' }
  const candidates = (run.recommendations ?? []).filter(row => (!row.profile_id || row.profile_id === profileId) && lower(row.decision) === 'accept' && hasPositiveFourTruthProof(row))
  const candidateMap = new Map()
  for (const candidate of candidates) {
    const sourceId = candidate.opportunity_id
    const id = idRemap?.get?.(sourceId) ?? sourceId
    const proof = fundingTruthProofFrom(candidate)
    const captured = stamp(proof?.real?.evidence_captured_at)
    if (id && captured >= started && captured <= finished) candidateMap.set(id, candidate)
  }
  if (!candidateMap.size) return { ...summary, reason: 'no_fresh_proven_accepts' }
  await ensurePipelineDismissalsSchema(db)
  // Without the immutable archive / user evidence table, leave every tombstone.
  if (!await tableExists(db, 'audit_events')) return { ...summary, reason: 'audit_evidence_unavailable' }
  const hasPromotionOutcomes = await tableExists(db, 'pipeline_promotion_outcomes')
  return withDismissalProfileTransaction(db, profileId, async tx => {
    const suffix = tx.dialect === 'postgres' ? ' FOR UPDATE' : ''
    // Profile and section locks keep the gate inputs stable during revocation.
    await tx.prepare(`SELECT id FROM profiles WHERE id = ?${suffix}`).get(profileId)
    await tx.prepare(`SELECT section_key FROM profile_sections WHERE profile_id = ?${suffix}`).all(profileId)
    const tombstones = await readLockedDismissals(tx, profileId)
    const owned = tombstones.filter(row => row.opportunity_id && candidateMap.has(row.opportunity_id) && isAutomaticGateDismissal(row))
    const bound = Math.max(1, Math.min(200, Number(limit) || 200))
    summary.truncated = owned.length > bound
    for (const row of owned.slice(0, bound)) {
      summary.scanned += 1
      const opportunity = await tx.prepare(`SELECT * FROM funding_opportunities WHERE id = ?${suffix}`).get(row.opportunity_id)
      const match = await tx.prepare(`SELECT * FROM profile_opportunity_matches WHERE profile_id = ? AND opportunity_id = ?${suffix}`).get(profileId, row.opportunity_id)
      const proof = fundingTruthProofFrom(match)
      const captured = stamp(proof?.real?.evidence_captured_at)
      const anotherProtected = opportunity && tombstones.some(other => other.id !== row.id && sameIdentity(other, opportunity) && (!isAutomaticGateDismissal(other) || other.opportunity_id !== row.opportunity_id))
      if (!opportunity || !match || anotherProtected || !(stamp(row.dismissed_at) < started) ||
          lower(match.matcher_version) !== 'crawler-os' || lower(match.match_decision) !== 'accept' ||
          String(parse(match.match_explain_json)?.canonical_decision).toUpperCase() !== 'ACCEPT' ||
          !hasPositiveFourTruthProof(match) || captured < started || captured > finished || !Number.isFinite(captured) ||
          !(stamp(match.computed_at) >= started && stamp(match.computed_at) <= enteredAt) ||
          hash(proof) !== hash(fundingTruthProofFrom(candidateMap.get(row.opportunity_id))) ||
          opportunity.is_active === false || opportunity.is_active === 0 || opportunity.is_hidden === true || opportunity.is_hidden === 1 ||
          ['expired','retired','permanently_retired','quarantined'].includes(lower(opportunity.status)) ||
          await hasAuthoritativeUserDismissal(tx, profileId, row.opportunity_id)) {
        summary.blocked += 1
        continue
      }
      const current = await evaluateCurrent(tx, opportunity, profileId)
      if (current?.pass !== true) { summary.blocked += 1; continue }
      const promotion = hasPromotionOutcomes ? await tx.prepare(`SELECT * FROM pipeline_promotion_outcomes WHERE profile_id = ? AND opportunity_id = ?${suffix}`).get(profileId, row.opportunity_id) : null
      await archiveDismissal(tx, row, { profile_id: profileId, opportunity_id: row.opportunity_id, run_id: run.run_id,
        started_at: run.started_at, finished_at: run.finished_at, four_truth_proof: proof, current_gates: current,
        promotion_outcome_before: promotion?.outcome === 'tombstoned' ? promotion : null })
      const removed = await tx.prepare(`DELETE FROM pipeline_dismissals WHERE id = ? AND profile_id = ? AND opportunity_id = ?
        AND dismissed_by = ? AND reason = ? AND dismissed_at = ?`)
        .run(row.id, profileId, row.opportunity_id, row.dismissed_by, row.reason, row.dismissed_at)
      assert.equal(Number(removed.changes ?? removed.rowCount), 1, 'Dismissal changed during revalidation')
      if (promotion?.outcome === 'tombstoned') {
        await tx.prepare("DELETE FROM pipeline_promotion_outcomes WHERE profile_id = ? AND opportunity_id = ? AND outcome = 'tombstoned'").run(profileId, row.opportunity_id)
      }
      summary.revalidated += 1
    }
    return summary
  })
}
