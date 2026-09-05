/**
 * hamiltonIdentityNeeds.js — WHAT HAMILTON STILL NEEDS FROM THE PERSON, asked
 * at login and stored in the identity vault.
 *
 * Owner order 2026-09-05: "Hamilton needs to be able to ask for these upon
 * user login, and safely store them in the vault to use." The live case: a
 * student's pipeline held four scholarships behind her university's
 * scholarship portal (PipelineMT), a state award that runs through the FAFSA /
 * TSAC portal, and real application forms — while her vault held only a date
 * of birth. Hamilton parked at every login wall and nothing told her which
 * three values would have let him through.
 *
 * This module DERIVES the needed vault kinds from the profile's own pipeline
 * (the same classifier every Hamilton run uses), compares them with what the
 * vault holds, and returns the missing ones with the reason and the sources
 * that need them. `getHamiltonReadiness` carries the result to the login
 * banner; `emitIdentityNeedsReminder` posts one deduped notification whose
 * deep link opens the vault card with the kind pre-selected. Values are stored
 * by the existing `POST /identity-vault` route (encrypted at rest, never
 * echoed back) — nothing here reads or writes a secret value.
 *
 * SILENCE IS NEUTRAL: a profile with no ready sources needs nothing; a kind the
 * vault already holds is never asked for again.
 */
import { loadProfileContext } from '../profileHelpers.js'
import { classifyFundingSource } from './hamiltonAutomationClassifier.js'
import { listIdentitySecrets, identityKindLabel } from './hamiltonProfileIdentityVault.js'
import { buildAddIdentityLink, identityRequestNotice, IDENTITY_REQUEST_NOTIFICATION_TYPE } from './hamiltonIdentityRequest.js'
import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'
import { HAMILTON_PROTECTED_PIPELINE_STATUSES } from '../../../shared/hamiltonProcessingPolicy.js'

export const IDENTITY_NEEDS_SOURCE_LIMIT = 100

/** Hosts whose sign-in is the FSA ID (federal and Tennessee state aid). */
const FSA_ID_HOST_RX = /(?:^|\.)(?:studentaid\.gov|fafsa\.gov|collegepays|collegefortn\.org|tnreconnect\.gov|tsac\.tn\.gov|tn\.gov)$/i
const FSA_ID_PATH_RX = /collegepays|fafsa|tsac|general-assembly-merit|hope-scholarship|tennessee-promise|tn-promise/i

const KIND_PRIORITY = Object.freeze(['sso_username', 'sso_password', 'fsa_id_username', 'fsa_id_password', 'ssn', 'date_of_birth', 'government_id_number'])

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

function isFsaIdSource(url) {
  const host = hostOf(url)
  if (!host) return false
  if (!FSA_ID_HOST_RX.test(host)) return false
  if (/(?:^|\.)tn\.gov$/i.test(host)) return FSA_ID_PATH_RX.test(String(url))
  return true
}

async function loadPipelineSources(db, profileId, limit = IDENTITY_NEEDS_SOURCE_LIMIT) {
  const placeholders = HAMILTON_PROTECTED_PIPELINE_STATUSES.map(() => '?').join(', ')
  const grants = await db.prepare(
    `SELECT id, title, status, application_url, portal_url, url, funding_opportunity_id, funder
       FROM grants
      WHERE profile_id = ? AND (status IS NULL OR status NOT IN (${placeholders}))
      ORDER BY updated_at DESC
      LIMIT ?`,
  ).all(String(profileId), ...HAMILTON_PROTECTED_PIPELINE_STATUSES, limit)
  const opportunityIds = [...new Set(grants.map((g) => g.funding_opportunity_id).filter(Boolean))]
  const opportunities = new Map()
  if (opportunityIds.length > 0) {
    const rows = await db.prepare(
      `SELECT * FROM funding_opportunities WHERE id IN (${opportunityIds.map(() => '?').join(', ')})`,
    ).all(...opportunityIds)
    for (const row of rows) opportunities.set(row.id, row)
  }
  return grants.map((grant) => ({ grant, opportunity: opportunities.get(grant.funding_opportunity_id) ?? null }))
}

/**
 * The vault kinds the profile's pipeline needs, minus what the vault holds.
 * `deps` is injectable for tests (profile loader, vault reader, source loader).
 */
export async function resolveIdentityNeeds(db, { profileId, deps = {} } = {}) {
  if (!db || !profileId) return { profile_id: String(profileId ?? ''), needs: [], on_file_kinds: [], total_missing: 0, needs_attention: false, sources_considered: 0 }
  const loadProfile = deps.loadProfile ?? ((d, id) => loadProfileContext(d, id, { enrichWebsitePurpose: false }))
  const listSecrets = deps.listIdentitySecrets ?? listIdentitySecrets
  const loadSources = deps.loadSources ?? loadPipelineSources
  const ctx = await loadProfile(db, String(profileId))
  const profile = ctx ? { ...(ctx.profile ?? {}), sections: ctx.sections ?? {} } : null
  const sources = await loadSources(db, String(profileId))
  const wanted = new Map()
  const want = (kind, reason, sourceTitle) => {
    if (!kind) return
    const entry = wanted.get(kind) ?? { kind, label: identityKindLabel(kind), reasons: new Set(), sources: [] }
    entry.reasons.add(reason)
    if (sourceTitle && !entry.sources.includes(sourceTitle) && entry.sources.length < 5) entry.sources.push(sourceTitle)
    wanted.set(kind, entry)
  }
  for (const { grant, opportunity } of sources) {
    let classification = null
    try { classification = classifyFundingSource({ opportunity, grant, profile }) } catch { classification = null }
    const title = String(opportunity?.title ?? grant?.title ?? '').trim() || null
    const url = classification?.resolved_url ?? opportunity?.application_url ?? grant?.application_url ?? grant?.url ?? null
    const own = classification?.own_institution_portal ?? null
    if (own) {
      for (const kind of own.vault_kinds ?? []) want(kind, `${own.institution}’s scholarship portal — ${own.login_hint}`, title)
    }
    if (classification?.fafsa_link || isFsaIdSource(url) || isFsaIdSource(opportunity?.application_url) || isFsaIdSource(opportunity?.apply_url)) {
      want('fsa_id_username', 'Federal and Tennessee state aid (FAFSA / TSAC portal) sign in with the FSA ID', title)
      want('fsa_id_password', 'Federal and Tennessee state aid (FAFSA / TSAC portal) sign in with the FSA ID', title)
    }
    if (String(classification?.automation_type ?? '') === 'portal' || url) {
      want('ssn', 'Most scholarship and aid applications ask for it on the form', title)
      want('date_of_birth', 'Every application asks for it', title)
    }
  }
  let onFile = []
  try { onFile = (await listSecrets(db, String(profileId))) ?? [] } catch { onFile = [] }
  const onFileKinds = new Set(onFile.map((r) => String(r.kind)))
  const needs = [...wanted.values()]
    .filter((n) => !onFileKinds.has(n.kind))
    .sort((a, b) => (KIND_PRIORITY.indexOf(a.kind) === -1 ? 99 : KIND_PRIORITY.indexOf(a.kind)) - (KIND_PRIORITY.indexOf(b.kind) === -1 ? 99 : KIND_PRIORITY.indexOf(b.kind)))
    .map((n) => ({
      kind: n.kind,
      label: n.label,
      reasons: [...n.reasons],
      sources: n.sources,
      add_link: buildAddIdentityLink({ profileId, kind: n.kind }),
    }))
  return {
    profile_id: String(profileId),
    needs,
    on_file_kinds: [...onFileKinds],
    total_missing: needs.length,
    needs_attention: needs.length > 0,
    sources_considered: sources.length,
    fingerprint: needs.map((n) => n.kind).join('|'),
  }
}

/**
 * One deduped login-time notification naming the missing kinds, with the vault
 * deep link. Re-posts only when the missing set changes or after
 * `lookbackHours`. Returns the number of notifications emitted (0 or 1).
 */
export async function emitIdentityNeedsReminder(db, { profileId, lookbackHours = 20, deps = {} } = {}) {
  if (!db || !profileId) return 0
  let resolved = null
  try { resolved = await resolveIdentityNeeds(db, { profileId, deps }) } catch { return 0 }
  if (!resolved || resolved.needs.length === 0) return 0
  const fingerprint = resolved.fingerprint
  const recentlyNotified = deps.recentlyNotified ?? (async () => {
    const cutoff = new Date(Date.now() - lookbackHours * 3600_000).toISOString().slice(0, 19).replace('T', ' ')
    try {
      const row = await db.prepare(
        'SELECT 1 FROM notifications WHERE type = ? AND data LIKE ? AND created_at > ? LIMIT 1',
      ).get(IDENTITY_REQUEST_NOTIFICATION_TYPE, `%"identity_fingerprint":"${fingerprint}"%`, cutoff)
      return Boolean(row)
    } catch { return false }
  })
  if (await recentlyNotified()) return 0
  let profileUserId = null
  try {
    const row = await db.prepare('SELECT user_id FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
    profileUserId = row?.user_id || null
  } catch { profileUserId = null }
  const notice = identityRequestNotice({
    profileId,
    kinds: resolved.needs.map((n) => n.kind),
    fundingTitle: resolved.needs[0]?.sources?.[0] ?? null,
  })
  const emit = deps.emit ?? emitHamiltonNotificationToProfileAndAdmins
  await emit(db, {
    profileId,
    profileUserId,
    type: notice.type,
    title: notice.title,
    message: `${notice.message} ${resolved.needs.map((n) => `${n.label}: ${n.reasons[0]}`).join(' ')}`.trim(),
    severity: notice.severity,
    data: { ...notice.data, identity_fingerprint: fingerprint, needs: resolved.needs.map((n) => ({ kind: n.kind, sources: n.sources })) },
  })
  return 1
}

export default { resolveIdentityNeeds, emitIdentityNeedsReminder, IDENTITY_NEEDS_SOURCE_LIMIT }
