/**
 * Larry — relationship tracker.
 *
 * Tracks the per-prospect lifecycle once Larry starts engaging:
 *   none → contacted → opened → replied → meeting → converted | declined
 *
 * Also owns the cooldown clock and the Do-Not-Contact (DNC) flag. DNC is the
 * one switch that supersedes everything else — once flipped, no future send
 * goes out for that prospect, full stop.
 *
 * All functions delegate to `larryRunStore.upsertRelationship` so persistence
 * stays consistent across SQLite and Postgres.
 */

import { RELATIONSHIP_STATE } from './larryTypes.js'
import {
  upsertRelationship,
  addSuppressionEntry,
  getRelationship,
} from './larryRunStore.js'

const DEFAULT_COOLDOWN_DAYS = 14

function plusDays(days) {
  const d = new Date()
  d.setDate(d.getDate() + Math.max(0, days))
  return d.toISOString()
}

export async function recordContactedRelationship({ db, prospectCandidateId, cooldownDays = DEFAULT_COOLDOWN_DAYS } = {}) {
  if (!db || !prospectCandidateId) return null
  const existing = await getRelationship(db, prospectCandidateId)
  const newCount = Number(existing?.contact_count || 0) + 1
  return upsertRelationship(db, prospectCandidateId, {
    relationship_state: RELATIONSHIP_STATE.CONTACTED,
    last_contacted_at: new Date().toISOString(),
    contact_count: newCount,
    cooldown_until: plusDays(cooldownDays),
  })
}

export async function recordOpenedRelationship({ db, prospectCandidateId } = {}) {
  if (!db || !prospectCandidateId) return null
  return upsertRelationship(db, prospectCandidateId, {
    relationship_state: RELATIONSHIP_STATE.OPENED,
  })
}

export async function recordRepliedRelationship({ db, prospectCandidateId, classification = null } = {}) {
  if (!db || !prospectCandidateId) return null
  // A reply ends the cooldown immediately — humans take over.
  const patch = {
    relationship_state: classification === 'declined' ? RELATIONSHIP_STATE.DECLINED : RELATIONSHIP_STATE.REPLIED,
    last_replied_at: new Date().toISOString(),
    cooldown_until: null,
  }
  if (classification === 'declined') {
    patch.do_not_contact = true
    patch.do_not_contact_reason = 'recipient_declined'
    patch.do_not_contact_at = new Date().toISOString()
  }
  return upsertRelationship(db, prospectCandidateId, patch)
}

export async function recordConvertedRelationship({ db, prospectCandidateId, notes = null } = {}) {
  if (!db || !prospectCandidateId) return null
  return upsertRelationship(db, prospectCandidateId, {
    relationship_state: RELATIONSHIP_STATE.CONVERTED,
    notes,
  })
}

/**
 * Do Not Contact: hard-block all future outreach for this prospect AND add
 * the relevant identifiers to the global suppression list so a future
 * discovery run can't accidentally re-add them.
 */
export async function markDoNotContact({
  db,
  prospect,
  reason = 'admin_request',
  addedByUserId = null,
} = {}) {
  if (!db || !prospect?.id) return null

  await upsertRelationship(db, prospect.id, {
    relationship_state: RELATIONSHIP_STATE.DO_NOT_CONTACT,
    do_not_contact: true,
    do_not_contact_reason: reason,
    do_not_contact_at: new Date().toISOString(),
  })

  // Also add identifiers to the global suppression list so future runs skip
  // them even if the prospect row is recreated under a different id.
  const entries = []
  if (prospect.primary_contact_email) {
    entries.push({ identifier_type: 'email', identifier_value: prospect.primary_contact_email })
    const domain = String(prospect.primary_contact_email).split('@')[1]
    if (domain) entries.push({ identifier_type: 'domain', identifier_value: domain })
  }
  if (prospect.ein) entries.push({ identifier_type: 'ein', identifier_value: prospect.ein })
  if (prospect.organization_name) {
    entries.push({ identifier_type: 'organization', identifier_value: prospect.organization_name.trim() })
  }
  if (prospect.primary_contact_phone) {
    const digits = String(prospect.primary_contact_phone).replace(/\D/g, '')
    if (digits) entries.push({ identifier_type: 'phone', identifier_value: digits })
  }

  for (const entry of entries) {
    try {
      await addSuppressionEntry(db, { ...entry, reason, added_by_user_id: addedByUserId })
    } catch {
      // best-effort; suppression dupe is fine
    }
  }

  return await getRelationship(db, prospect.id)
}

export async function isCooledOff(relationship, { now = new Date() } = {}) {
  if (!relationship?.cooldown_until) return false
  const until = new Date(relationship.cooldown_until)
  if (!Number.isFinite(until.getTime())) return false
  return until.getTime() > now.getTime()
}
