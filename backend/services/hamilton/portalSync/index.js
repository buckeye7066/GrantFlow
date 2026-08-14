/**
 * portalSync/index.js
 *
 * Two-way portal ↔ GrantFlow data sync orchestrator.
 *
 *   runPortalSync(db, { profileId, portalHost, direction, actorUserId })
 *
 * It:
 *   1. resolves an authenticated context for the profile + host using the SAME
 *      machinery Hamilton autopilot uses — a durable saved Playwright
 *      storageState (findValidSession + getSessionStorageState) and/or a saved
 *      login (getDecryptedCredentialWithFallback);
 *   2. respects the browser-automation gate (HAMILTON_ENABLE_BROWSER_AUTOMATION
 *      + HAMILTON_BROWSER_AUTOMATION_HOST_ALLOWLIST) — reusing the orchestrator's
 *      browserAutomationPermittedForUrl, with the profile's credentialed domain
 *      as an authorized host so a portal the owner provisioned is reachable;
 *   3. launches Playwright the same way runAutopilot does (dynamic import,
 *      headless, storageState applied);
 *   4. dispatches to the host's connector (registry.getConnectorForHost);
 *   5. PERSISTS read results — profile fields via profileFieldWriter, awards via
 *      the canonical school-portal opportunity path, honoring the DISMISSED gate;
 *   6. records a portal_sync_runs row (ensurePortalSyncSchema self-heals it);
 *   7. ALWAYS closes the browser.
 *
 * Honesty: a connector returns notFound/skipped instead of throwing on missing
 * selectors, and this orchestrator surfaces those verbatim in the run summary.
 * We never record status:'ok' with fabricated data.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'

import { normalizeHost, findValidSession, getSessionStorageState } from '../hamiltonCredentialSessionService.js'
import { launchPortalBrowser, REALISTIC_PORTAL_UA } from '../browserLaunch.js'
import {
  controlledBetaBrowserContextOptions,
  controlledBetaBrowserRefusal,
  installControlledBetaBrowserEgressGuard,
  isControlledBetaSyntheticBrowserUrl,
} from '../controlledBetaBrowserPolicy.js'
import { getDecryptedCredentialWithFallback, listCredentialedDomains, registrableDomain } from '../hamiltonPortalCredentialService.js'
import {
  browserAutomationPermittedForUrl,
  isBrowserAutomationEnabled,
} from '../hamiltonAutomationOrchestrator.js'
import { setProfileSectionField } from '../../profileFieldWriter.js'
import { upsertSchoolPortalAwardAsOpportunity } from '../../schoolPortalImportService.js'
import { isDismissed } from '../../pipelineDismissals.js'
import { evaluateAwardAgainstPreferences } from '../../../config/aidTypePreferences.js'
import { collectAcceptedFundingSources } from './acceptedFundingSources.js'
import { deriveNamePartsIntoBasicInfo } from '../../../../shared/nameParsing.js'
import { createLogger } from '../../../utils/logger.js'
import { PORTAL_STATUS } from '../portalCompletionStore.js'
import { listConnectors, getConnectorForHost, resolveConnector } from './registry.js'
import {
  ensurePortalSyncSchema,
  recordRunStart,
  finishRun,
  listRuns,
} from './store.js'

export { listConnectors, getConnectorForHost, resolveConnector, ensurePortalSyncSchema, listRuns }

const log = createLogger('service:portalSync')

const VALID_DIRECTIONS = new Set(['read', 'write', 'both'])

function profileToFundingSources(profile) {
  // Pull the profile's completed-application funding sources / awards so a WRITE
  // can push them into the portal. We read the same university_applications
  // section the import service writes into. The real award data lives in BOTH
  // `imported_portal_awards` (raw imports) AND `financial_aid_pipeline` (the
  // tracked aid stages the UI shows) — so we read both. Previously only
  // imported_portal_awards was read, which left WRITE with zero sources because
  // the data actually sits in financial_aid_pipeline.
  const sources = []
  const uni = profile?.university_applications || profile?.sections?.university_applications || {}
  for (const app of Array.isArray(uni?.applications) ? uni.applications : []) {
    for (const a of Array.isArray(app?.imported_portal_awards) ? app.imported_portal_awards : []) {
      sources.push({ name: a?.title || a?.award_name, amount: a?.amount, sponsor: a?.provider_name })
    }
    // financial_aid_pipeline stages carry the funding source name (label/name/
    // title) and, when known, an amount.
    for (const stage of Array.isArray(app?.financial_aid_pipeline) ? app.financial_aid_pipeline : []) {
      const name = stage?.title || stage?.name || stage?.label
      if (!name) continue
      sources.push({ name, amount: stage?.amount ?? stage?.award_amount ?? null, sponsor: stage?.provider_name || stage?.sponsor })
    }
  }
  // Dedupe by name; drop entries with no name.
  const seen = new Set()
  return sources.filter((s) => {
    const k = String(s?.name || '').trim().toLowerCase()
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/**
 * Persist READ results. Profile fields go through the canonical
 * setProfileSectionField (guarded). Awards go through the canonical
 * school-portal opportunity upsert, each gated by the per-profile DISMISSED
 * tombstone so a previously-removed award is never resurrected.
 *
 * @returns {Promise<{ fieldsWritten:number, fieldsRejected:Array, awardsWritten:number, awardsDismissed:number }>}
 */
/**
 * Apply a connector-reported FAFSA lifecycle stage through the CANONICAL owner
 * (services/college/fafsaStatus.js), never as a raw section field: that module
 * owns the stage history and the derived `fafsa_completed` boolean, and
 * `fafsa_status` is not in the education section's field metadata, so a
 * setProfileSectionField write would be rejected by the guard anyway.
 *
 * MONOTONIC BY DESIGN: a portal read may ADVANCE the stage but never silently
 * regress it. studentaid.gov renders stale banners ("Submitted on …") next to
 * newer state, and a regression would erase verification progress the student
 * already recorded by hand. A lower observed stage is REPORTED (so the run
 * summary shows the disagreement) and not written.
 *
 * @returns {Promise<null|{applied:boolean, stage:string, from:string, reason?:string}>}
 */
async function applyFafsaStatusFromRead(db, { profileId, actorUserId, readResult }) {
  const incoming = readResult?.fafsaStatus
  const stage = incoming?.stage
  if (!stage) return null
  try {
    const { normalizeFafsaStatus, setFafsaStage, isKnownStage, stageIndex } = await import('../../college/fafsaStatus.js')
    if (!isKnownStage(stage)) return { applied: false, stage, from: 'unknown', reason: 'unknown_stage' }

    let education = {}
    try {
      const row = await db.prepare(
        "SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'education' LIMIT 1",
      ).get(String(profileId))
      if (row?.data) education = typeof row.data === 'object' ? row.data : JSON.parse(row.data)
    } catch { education = {} }

    const current = normalizeFafsaStatus(education)
    if (stageIndex(stage) <= stageIndex(current.stage)) {
      return {
        applied: false,
        stage,
        from: current.stage,
        reason: stage === current.stage
          ? 'already_at_stage'
          : 'would_regress: the portal page evidenced an EARLIER stage than the profile already records (often a stale banner) — left unchanged',
      }
    }

    const result = setFafsaStage(current, stage, { now: new Date().toISOString() })
    if (!result.ok) return { applied: false, stage, from: current.stage, reason: result.error || 'set_failed' }
    // The EVIDENCE quote rides the run summary. Without it the 2026-08-01
    // incident (a nav label advancing a real student to the terminal
    // `complete`) could only be diagnosed by re-deriving the regex by hand —
    // a stage write that cannot be audited from its own run record is not
    // auditable at all.
    const evidence = incoming?.evidence ? String(incoming.evidence).slice(0, 200) : null

    const next = { ...education, fafsa_status: result.status, fafsa_completed: result.fafsa_completed }
    const data = JSON.stringify(next)
    const updatedBy = actorUserId || 'hamilton_portal_sync'
    const existing = await db.prepare(
      "SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = 'education'",
    ).get(String(profileId))
    if (existing) {
      await db.prepare(
        "UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND section_key = 'education'",
      ).run(data, updatedBy, String(profileId))
    } else {
      await db.prepare(
        "INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, 'education', ?, ?)",
      ).run(String(profileId), data, updatedBy)
    }
    return { applied: true, stage, from: current.stage, evidence }
  } catch (err) {
    return { applied: false, stage, from: 'unknown', reason: err?.message || 'fafsa_status_write_failed' }
  }
}

/**
 * The saved session provably failed to clear the portal's sign-in wall: mark it
 * expired and tell the household ONCE, so the fix ("sign in side-by-side one
 * more time") actually reaches a human instead of dying in a run summary.
 *
 * Deliberately reuses the keepalive's own primitives and its re-notify cooldown
 * so a repeatedly-run sync cannot page the household on every attempt. Entirely
 * best-effort: a notification failure must never change the sync's outcome.
 */
async function markSessionDeadAfterWall(db, session, host) {
  const RENOTIFY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
  let meta = {}
  try {
    const raw = session.metadata_json ?? session.metadata
    meta = raw ? (typeof raw === 'object' ? raw : JSON.parse(raw)) : {}
  } catch { meta = {} }

  try {
    const { markSessionExpired } = await import('../hamiltonCredentialSessionService.js')
    await markSessionExpired(db, session.id, 'portal sync reached the sign-in wall — session not accepted')
  } catch (err) {
    log.warn('portal_sync_expire_failed', { host, err: err?.message })
    return
  }

  const lastNotified = meta.keepalive_notified_at ? Date.parse(meta.keepalive_notified_at) : NaN
  if (Number.isFinite(lastNotified) && Date.now() - lastNotified < RENOTIFY_COOLDOWN_MS) return
  try {
    const { emitHamiltonNotificationToProfileAndAdmins } = await import('../hamiltonNotifications.js')
    await emitHamiltonNotificationToProfileAndAdmins(db, {
      profileId: session.profile_id,
      profileUserId: session.user_id,
      type: 'hamilton_session_capture_needed',
      title: `Sign in once to ${host}`,
      message: `Hamilton's saved session for ${host} was not accepted — the portal returned its sign-in page instead of your account. One side-by-side sign-in restores it. (No data was read, and nothing on your profile was changed.)`,
      data: { portal_host: host, profile_id: session.profile_id, source: 'portal_sync' },
      severity: 'warning',
    })
    const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
    await db.prepare(
      `UPDATE hamilton_saved_sessions SET metadata_json = ?, updated_at = ${nowFn} WHERE id = ?`,
    ).run(JSON.stringify({ ...meta, keepalive_notified_at: new Date().toISOString() }), session.id)
  } catch (err) {
    log.warn('portal_sync_notify_failed', { host, err: err?.message })
  }
}

/**
 * The portal offered no online way to report outside awards. Build the
 * mailable/faxable package, file it in the profile's Documents, and ALERT the
 * owner (and admins) that it is waiting for them.
 *
 * The alert is the load-bearing half. A document that silently appears in a
 * Documents list is only marginally better than no document: the family has to
 * already know to look. Reporting an outside award is usually REQUIRED, and an
 * unreported one can mean a revised aid package or a repayment demand — so this
 * has to reach a person.
 *
 * Entirely best-effort: the sync already reported the truth about not
 * submitting, and neither a packet failure nor a notification failure may
 * change that outcome.
 */
/**
 * Should this run produce the mail/fax packet? Exported and pure so the
 * DECISION is testable — the first version of this lived inline and a test that
 * called the builder directly could not see it at all (both mutations of the
 * inline condition passed, which is exactly the "a check that can't fail proves
 * nothing" trap this repo warns about).
 *
 * True only when there was real work to report AND the portal gave us no online
 * way to send it. Never after a successful submit; never for an empty list; and
 * never for an unrelated failure (an unreachable portal is a connectivity
 * problem to retry, not a reason to hand someone an envelope).
 */
export function needsMailFaxPacket(writeResult, fundingSources = []) {
  if (!Array.isArray(fundingSources) || fundingSources.length === 0) return false
  if (writeResult?.submitted === true) return false
  const skipped = Array.isArray(writeResult?.skipped) ? writeResult.skipped : []
  return skipped.some((s) => /no outside-scholarship reporting form|no submit control/i.test(String(s?.reason || '')))
}

async function buildOutsideAwardFallbackPacket(db, { profile, profileId, host, fundingSources, actorUserId }) {
  try {
    const { generateOutsideAwardPacket } = await import('./outsideAwardPacket.js')
    const packet = await generateOutsideAwardPacket(db, {
      profile: profile || { id: profileId },
      portalHost: host,
      sources: fundingSources,
      userId: actorUserId || null,
    })
    if (!packet) return null

    try {
      const { emitHamiltonNotificationToProfileAndAdmins } = await import('../hamiltonNotifications.js')
      await emitHamiltonNotificationToProfileAndAdmins(db, {
        profileId,
        profileUserId: profile?.user_id || null,
        // ADMINS ARE DELIBERATELY NOT FANNED OUT TO (owner rule, 2026-08-01:
        // "only alert admin to what needs synced in a profile when admin is
        // working in that particular profile — that way admin is not flooded").
        // This helper otherwise emits a row to EVERY admin, and with 39 profiles
        // in prod that is a wall of notifications an admin learns to scroll
        // past — which would also bury the one profile that matters. The people
        // who must physically mail or fax this are the profile's own household,
        // so they are the recipients; an admin working inside the profile sees
        // the packet in its Documents and on the profile's own surfaces.
        // Passing an explicit empty array is what suppresses the admin lookup.
        adminUserIds: [],
        type: 'hamilton_outside_award_packet_ready',
        title: `Mail or fax your award report to ${host}`,
        message: `${host} has no online form for reporting outside scholarships, so Hamilton prepared a signed-ready report listing ${packet.count} award${packet.count === 1 ? '' : 's'}. It is in this profile's Documents ("${packet.title}") — print it, sign it, and mail or fax it to the financial-aid office. Reporting outside awards is usually required.`,
        data: {
          portal_host: host,
          profile_id: profileId,
          document_ids: packet.documentIds,
          award_count: packet.count,
          source: 'portal_sync',
        },
        severity: 'warning',
      })
    } catch (err) {
      log.warn('outside_award_packet_notify_failed', { host, err: err?.message })
    }
    return packet
  } catch (err) {
    log.warn('outside_award_packet_build_failed', { host, err: err?.message })
    return null
  }
}

async function persistReadResult(db, { profileId, portalHost, actorUserId, readResult }) {
  const out = {
    fieldsWritten: 0, fieldsRejected: [], awardsWritten: 0, awardsDismissed: 0, awardsFailed: [],
    // Awards the profile's own aid-type preference declined (e.g. loans).
    // REPORTED, never silently dropped — the student may still have a real
    // offer they need to act on at the portal itself.
    awardsDeclinedByPreference: [],
  }

  // The profile's aid-type preference (education.aid_types_accepted). Loaded
  // ONCE per run: a household that has decided against debt must never find a
  // loan sitting in their pipeline as though it were an award (owner rule,
  // 2026-08-01). Discovery already refuses loans; this closes the portal-sync
  // path that bypassed that line entirely.
  let education = {}
  try {
    const row = await db.prepare(
      "SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = 'education' LIMIT 1",
    ).get(String(profileId))
    if (row?.data) education = typeof row.data === 'object' ? row.data : JSON.parse(row.data)
  } catch { education = {} }

  // FAFSA lifecycle (studentaid.gov) rides the canonical stage owner, not the
  // raw field writer — see applyFafsaStatusFromRead.
  const fafsa = await applyFafsaStatusFromRead(db, { profileId, actorUserId, readResult })
  if (fafsa) {
    out.fafsaStatus = fafsa
    if (fafsa.applied) out.fieldsWritten += 1
  }

  for (const f of Array.isArray(readResult?.fields) ? readResult.fields : []) {
    if (!f?.sectionKey || !f?.field || f.value === undefined || f.value === null || String(f.value).trim() === '') continue
    try {
      await setProfileSectionField(db, {
        profileId, sectionKey: f.sectionKey, field: f.field, value: f.value, updatedBy: actorUserId || 'hamilton_portal_sync',
      })
      out.fieldsWritten += 1
    } catch (err) {
      // Guard rejected the field (not part of the section) — record honestly,
      // don't pretend it was saved.
      out.fieldsRejected.push({ sectionKey: f.sectionKey, field: f.field, reason: err?.code || err?.message || 'rejected' })
    }
  }

  const connection = {
    provider_id: 'portal_sync',
    provider_name: 'Portal Sync',
    portal_url: `https://${portalHost}`,
    integration_mode: 'browser_autopilot',
    live_supported: true,
    automation_supported: true,
  }
  for (const a of Array.isArray(readResult?.awards) ? readResult.awards : []) {
    const title = String(a?.title || '').trim()
    if (!title) continue
    // AID-TYPE PREFERENCE GATE — before any write. An award whose kind this
    // profile declined is recorded as declined and skipped; an award whose kind
    // we cannot name is NEVER excluded (hiding real money because we could not
    // classify it would be the worse failure).
    const verdict = evaluateAwardAgainstPreferences(a, education)
    if (!verdict.accepted) {
      out.awardsDeclinedByPreference.push({ title, aid_type: verdict.aidType, reason: verdict.reason })
      continue
    }
    // Stable id so re-syncing the same award updates rather than duplicates.
    // The PROFILE is part of the identity: without it, two students with the
    // same portal + title + amount collide on one row, and now that award rows
    // are profile-scoped (the G4/G8 fix below) the second student's award
    // would silently update the first student's row.
    const fp = crypto.createHash('sha1').update(`${profileId}|${portalHost}|${title}|${a?.amount ?? ''}`).digest('hex').slice(0, 24)
    const awardId = `portal_sync_${fp}`
    // DISMISSED gate: if the user previously removed this award from their
    // pipeline, do NOT resurrect it. isDismissed accepts an opportunity-shaped
    // object; we pass the synthetic award identity.
    let dismissed = false
    try {
      dismissed = await isDismissed(db, profileId, {
        id: awardId, source_url: a?.sourceUrl || connection.portal_url, title,
      })
    } catch { dismissed = false }
    if (dismissed) { out.awardsDismissed += 1; continue }

    // The portal's own status ("under consideration", "awarded", …) is a real
    // fact the connectors read (types.js PortalReadAward.status) that used to
    // be dropped right here. funding_opportunities has no status column, so it
    // rides the description — visible everywhere the row renders, never lost.
    const portalStatus = String(a?.status || '').trim()
    const award = {
      id: awardId,
      title,
      provider_name: a?.sponsor || connection.provider_name,
      external_id: a?.externalId || null,
      amount: Number.isFinite(Number(a?.amount)) ? Number(a.amount) : null,
      amount_display: a?.amountDisplay || null,
      description: `Read from ${portalHost} via Hamilton portal sync${portalStatus ? ` — portal status: ${portalStatus}` : ''}`,
      portal_url: a?.sourceUrl || connection.portal_url,
      source_url: a?.sourceUrl || connection.portal_url,
    }
    // A persist failure must be RECORDED, not swallowed: a run that silently
    // dropped awards used to still report a clean "completed" summary. The
    // failure list rides the run summary (and blocks the auto-merge below) so
    // the sync never looks more successful than it was.
    try {
      // profileId scopes the row: a student's authenticated portal award is
      // THEIR fact, never a global catalog entry every profile can match
      // (2026-07-28 audit — the cross-profile-bleed class).
      const ok = await upsertSchoolPortalAwardAsOpportunity(db, award, connection, { profileId })
      if (ok) out.awardsWritten += 1
      else out.awardsFailed.push({ title, reason: 'upsert_returned_false' })
    } catch (err) {
      out.awardsFailed.push({ title, reason: err?.message || 'upsert_failed' })
    }
  }

  return out
}

/**
 * Stamp last_checked_at / last_check_status on every student_portals row whose
 * URL lives on the synced host, so the "last checked" columns the portals panel
 * renders actually get written (they were previously write-path-dead — no
 * caller ever invoked recordPortalCheck). Best-effort; never throws.
 */
async function recordStudentPortalChecks(db, { profileId, host, status }) {
  try {
    const { listStudentPortals, recordPortalCheck } = await import('../studentPortalStore.js')
    const wantDomain = registrableDomain(host)
    if (!wantDomain) return
    const portals = await listStudentPortals(db, profileId, { includeInactive: false })
    for (const p of portals || []) {
      const match = [p.portal_url, p.login_url, p.application_url]
        .some((u) => u && registrableDomain(normalizeHost(u)) === wantDomain)
      if (!match) continue
      await recordPortalCheck(db, profileId, p.id, { status }).catch(() => {})
    }
  } catch { /* best-effort — a check stamp must never break the sync */ }
}

/**
 * Should a completed READ be recorded as the portal's terminal MERGED state?
 * Conservative by design ("merged only when truly merged"): only when data was
 * genuinely written into the profile (or deliberately dismissed by the user)
 * AND nothing failed to persist — an empty or partially-failed read leaves the
 * portal unmerged and still on the weekly reminder.
 */
export function shouldMarkMergedAfterRead(persisted) {
  if (!persisted || typeof persisted !== 'object') return false
  // Dismissals do NOT count as pulled data: a run that wrote zero fields and
  // zero awards because the user had previously dismissed everything is a
  // no-op read, not a merge — counting it marked portals terminally `merged`
  // off pure suppression (2026-07-28 audit).
  const pulledData = (Number(persisted.fieldsWritten) || 0)
    + (Number(persisted.awardsWritten) || 0) > 0
  const cleanPersist = (persisted.awardsFailed || []).length === 0
    && (persisted.fieldsRejected || []).length === 0
  return pulledData && cleanPersist
}

/**
 * The COMPLETENESS contract (2026-07-28 audit #19): a read may be marked the
 * TERMINAL `merged` state only when the connector can certify it read every
 * domain it is responsible for — not merely that one field/award wrote. Returns
 * the honest lifecycle target: 'merged', 'partially_synced', or null.
 *
 * FULL merge requires ALL of: a clean pull (shouldMarkMergedAfterRead),
 * connector.supportsFullMerge === true, a non-empty connector.requiredReadDomains,
 * and every one of those domains reported `complete` in readResult.domains. A
 * connector that pulls data but cannot certify completeness (the generic
 * LLM-extraction connector, or a full-merge connector whose read didn't cover
 * every domain this run) reaches `partially_synced` — real progress, never a
 * false terminal merge.
 */
export function resolveMergeState(persisted, connector, readResult) {
  if (!shouldMarkMergedAfterRead(persisted)) return null
  const required = Array.isArray(connector?.requiredReadDomains) ? connector.requiredReadDomains : []
  const domains = (readResult && typeof readResult.domains === 'object' && readResult.domains) || {}
  const allDomainsComplete = required.length > 0 && required.every((d) => domains?.[d]?.complete === true)
  if (connector?.supportsFullMerge === true && allDomainsComplete) return PORTAL_STATUS.MERGED
  return PORTAL_STATUS.PARTIALLY_SYNCED
}

/**
 * Record the lifecycle state after a successful READ, per the completeness
 * contract (resolveMergeState): terminal `merged` ONLY when the connector
 * certified every required domain, else the honest non-terminal
 * `partially_synced` when real data was pulled. The sync run is the auditable
 * proof both states require. Returns { state, recorded }. Best-effort — a
 * status write failure never breaks the sync.
 */
export async function finalizeReadMerge(db, { profileId, host, runId = null, persisted, connector = null, readResult = null } = {}) {
  const state = resolveMergeState(persisted, connector, readResult)
  if (!state) return { state: null, recorded: false, merged: false }
  try {
    const { markPortalMerged, markPortalPartiallySynced } = await import('../portalCompletionStore.js')
    const opts = {
      profileId, portalHost: host,
      source: 'portal_sync',
      syncRunId: runId || undefined,
      evidence: runId ? `portal_sync_run:${runId}` : `portal_sync_read:${new Date().toISOString()}`,
    }
    const row = state === PORTAL_STATUS.MERGED
      ? await markPortalMerged(db, opts)
      : await markPortalPartiallySynced(db, opts)
    return { state, recorded: Boolean(row), merged: state === PORTAL_STATUS.MERGED && Boolean(row) }
  } catch (err) {
    log.warn('portal_sync_merge_mark_failed', { profileId, host, err: err?.message })
    return { state, recorded: false, merged: false }
  }
}

async function loadProfileBundle(db, profileId) {
  if (!db || !profileId) return null
  let row = null
  try { row = await db.prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1').get(String(profileId)) } catch { row = null }
  if (!row) return null
  let sectionRows = []
  try {
    sectionRows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(String(profileId))
  } catch { sectionRows = [] }
  const sections = {}
  for (const r of sectionRows || []) {
    try { sections[r.section_key] = typeof r.data === 'string' ? JSON.parse(r.data) : r.data } catch { /* ignore */ }
  }
  // Derive first/last name from full_name / display_name so a profile that only
  // carries a single full name still presents first/last to portal form-fill.
  // Mirrors every other Hamilton loader (orchestrator, app-agent, route).
  const derived = deriveNamePartsIntoBasicInfo(sections.basic_information || {}, row.display_name)
  if (derived.changed) sections.basic_information = derived.data
  return { ...row, sections, ...sections }
}

/**
 * Run a two-way portal sync.
 *
 * @param {object} db
 * @param {object} arg
 * @param {string} arg.profileId
 * @param {string} arg.portalHost  host or URL of the portal to drive.
 * @param {'read'|'write'|'both'} arg.direction
 * @param {string} [arg.actorUserId]
 * @returns {Promise<{ ok:boolean, direction:string, connectorId:string|null, read?:object, write?:object, runId:string|null, error?:string }>}
 */
// In-flight sync registry: survives across requests within one process; a
// process restart clears it, which is correct (the orphaned run is finished or
// dead by then).
const inFlightSyncs = new Map()

export async function runPortalSync(db, {
  profileId, portalHost, direction = 'read', actorUserId = null,
  // Compatibility input only. Portal sync is intentionally outside Hamilton's
  // canonical task authorization/lease/proof protocol, so it must never become
  // a second final-submit authority.
  allowSubmit = false,
} = {}) {
  if (!db) return { ok: false, direction, connectorId: null, runId: null, error: 'db required' }
  if (!profileId) return { ok: false, direction, connectorId: null, runId: null, error: 'profileId required' }
  const host = normalizeHost(portalHost)
  if (!host) return { ok: false, direction, connectorId: null, runId: null, error: 'portalHost required' }
  const dir = VALID_DIRECTIONS.has(direction) ? direction : 'read'
  const controlledBetaUrl = `https://${host}/`

  // Defense in depth for direct service callers and stale clients. A final
  // external submit may be reintroduced only through a reviewed adapter joined
  // to the canonical durable task authorization, final-review veto, submission
  // lease, and confirmation-proof protocol.
  if (allowSubmit === true) {
    return {
      ok: false,
      direction: dir,
      connectorId: null,
      runId: null,
      error: 'reviewed_submission_adapter_required',
      requires_human_submission: true,
    }
  }

  if (!isControlledBetaSyntheticBrowserUrl(controlledBetaUrl)) {
    const refusal = controlledBetaBrowserRefusal()
    return {
      ok: false,
      direction: dir,
      connectorId: null,
      runId: null,
      error: refusal.code,
      detail: refusal.message,
      requires_human_handoff: true,
    }
  }

  // IN-FLIGHT GUARD: a sync can outlive the HTTP edge timeout (the client sees
  // a 504 while the server-side run keeps going and persists). A blind retry
  // then runs the SAME portal twice concurrently. Refuse the duplicate and hand
  // back the running runId so callers poll GET /runs instead.
  const flightKey = `${profileId}|${host}`
  const running = inFlightSyncs.get(flightKey)
  if (running) {
    return {
      ok: false, direction: dir, connectorId: running.connectorId || null,
      runId: running.runId || null, in_flight: true,
      error: 'a sync for this profile + portal is already running; poll /api/hamilton/portal-sync/runs for its result',
    }
  }
  inFlightSyncs.set(flightKey, { runId: null, connectorId: null, startedAt: Date.now() })
  try {
    return await runPortalSyncInner(db, { profileId, host, dir, actorUserId, flightKey })
  } finally {
    inFlightSyncs.delete(flightKey)
  }
}

async function runPortalSyncInner(db, { profileId, host, dir, actorUserId, flightKey }) {

  // Load the saved login up front so connector resolution is credential-aware:
  // an MTSU account saved under login.microsoftonline.com must route to the MTSU
  // connector, not the generic one. resolveConnector always returns a connector
  // (generic fallback), so any reachable host is syncable.
  let credential = null
  try { credential = await getDecryptedCredentialWithFallback(db, { profileId, portalHost: host }) } catch { credential = null }

  const connector = resolveConnector({ host, username: credential?.username, label: credential?.label })
  const connectorId = connector?.id || null

  await ensurePortalSyncSchema(db).catch(() => {})
  const runId = await recordRunStart(db, { profileId, portalHost: host, connectorId, direction: dir, actorUserId }).catch(() => null)
  // Let concurrent duplicate callers learn WHICH run is already in flight.
  const flight = flightKey ? inFlightSyncs.get(flightKey) : null
  if (flight) { flight.runId = runId; flight.connectorId = connectorId }
  // Run bookkeeping failure must be VISIBLE: with runId=null the run would
  // finish "successfully" while the health surface / lastSync show "never
  // synced". Surface the degradation on the result instead of hiding it.
  if (!runId) log.warn('portal_sync_run_bookkeeping_failed', { profileId, host })

  const fail = async (error, extra = {}) => {
    await finishRun(db, runId, { status: 'failed', error, summary: extra }).catch(() => {})
    await recordStudentPortalChecks(db, { profileId, host, status: 'failed' })
    return { ok: false, direction: dir, connectorId, runId, error, ...extra }
  }

  if (!connector) return fail(`no connector registered for host ${host}`)

  // Browser-automation gate. Treat the profile's credentialed domains as
  // authorized hosts so a portal the owner provisioned a login/session for is
  // reachable even with a restrictive static allowlist.
  const url = `https://${host}/`
  let extraAllowedHosts = []
  try { extraAllowedHosts = [...await listCredentialedDomains(db, profileId)] } catch { extraAllowedHosts = [] }
  if (!browserAutomationPermittedForUrl(url, { extraAllowedHosts })) {
    const reason = !isBrowserAutomationEnabled()
      ? 'HAMILTON_ENABLE_BROWSER_AUTOMATION is not true'
      : 'controlled beta permits only the reserved synthetic fixture origin'
    return fail(`browser automation not permitted: ${reason}`)
  }

  // Resolve an authenticated context: durable saved session first, then a saved
  // login. At least one is required — without it we cannot act as the user.
  let storageState = null
  let savedSession = null
  try {
    const saved = await findValidSession(db, { profileId, portalHost: host })
    if (saved?.has_storage_state) {
      savedSession = saved
      storageState = await getSessionStorageState(db, saved.id)
    }
  } catch { storageState = null }
  // `credential` was already resolved above for connector selection.

  if (!storageState && !credential) {
    return fail('no authenticated session or saved login for this profile + portal host')
  }

  // HONESTY GATE: a connector that declares requiresSession (SSO / 2FA portal,
  // e.g. MTSU via Microsoft) cannot be authenticated from a saved username/
  // password alone — the sync only ever APPLIES a captured storageState, it never
  // logs in. Without a session we'd open a browser, read the login wall, and
  // record a misleading "completed, 0 awards". Fail honestly instead, pointing the
  // user at the side-by-side login that captures the session.
  if (connector.requiresSession && !storageState) {
    return fail('this portal needs a captured login session (use the side-by-side login first); a saved password alone cannot clear its SSO/2FA', { needs_session: true })
  }

  // Launch Playwright exactly like runAutopilot does.
  let chromium
  try { ({ chromium } = await import('playwright')) } catch (err) {
    return fail(`Playwright unavailable: ${err?.message || err}`)
  }
  const exe = chromium.executablePath?.()
  if (!exe || !fs.existsSync(exe)) {
    return fail('Playwright chromium binary not installed')
  }

  const profile = await loadProfileBundle(db, profileId)
  const ctxLog = (msg, detail) => log.info(msg, { profileId, host, ...(detail || {}) })

  let browser = null
  try {
    // Hardened shared launcher: container-safe args (this call site had drifted
    // to a bare launch — the /dev/shm OOM class) + the full-Chromium engine +
    // the capture-time UA so WAF-bound sessions replay (see browserLaunch.js).
    ;({ browser } = await launchPortalBrowser(chromium, { targetUrl: url }))
    const context = await browser.newContext(controlledBetaBrowserContextOptions({
      userAgent: REALISTIC_PORTAL_UA,
      ...(storageState && typeof storageState === 'object' ? { storageState } : {}),
    }))
    await installControlledBetaBrowserEgressGuard(context)
    const page = await context.newPage()

    const ctx = {
      profileId, portalHost: host, actorUserId,
      profile, credential, hasSession: !!storageState, log: ctxLog,
    }

    const result = { ok: true, direction: dir, connectorId, runId }
    if (!runId) result.bookkeeping_degraded = true
    const summary = { connector: connectorId }
    // hit_login_wall: set when markSessionDeadAfterWall() proves the saved
    // session never cleared the portal's sign-in wall. The run below still
    // finishes its bookkeeping normally, but MUST NOT be recorded 'completed'
    // — a completed run is what portalSyncStaleness.js's
    // loadLastSuccessfulSyncByHost() reads as "just synced" (status='completed'
    // is its explicit, deliberate filter), so a fake-completed wall run
    // suppressed the login prompt for 7 days on a session that was already
    // dead, and portalSyncHealth.js's Mission Control view showed it green.
    let hitLoginWall = false

    if (dir === 'read' || dir === 'both') {
      const readResult = await connector.read(page, ctx)
      // A connector that could not even REACH the portal (DNS failure, cert
      // mismatch, connection reset) must yield a FAILED run — recording
      // "completed, 0 awards" for a page the browser never loaded shows dead
      // portals as green on every dashboard.
      if (readResult?.reached === false) {
        return await fail(`portal unreachable: ${readResult?.error || 'navigation failed'}`, { unreachable: true })
      }
      // A connector that PROVED it never cleared the portal's sign-in wall has
      // established the same fact the keepalive sweep expires a session on: the
      // saved session is dead. Without this the run just reports an empty read
      // and the owner is never told the one thing that would fix it — capture a
      // fresh login. Mirrors runSessionKeepAliveSweep exactly, including its
      // hard-won distinction: an auth challenge is the session's death, while a
      // BLOCK ('blocked' — a datacenter/WAF refusal) is OUR reachability
      // problem and must never burn a working session.
      if (readResult?.access === 'signin_wall' && savedSession?.id) {
        hitLoginWall = true
        await markSessionDeadAfterWall(db, savedSession, host).catch(() => {})
      }
      const persisted = await persistReadResult(db, { profileId, portalHost: host, actorUserId, readResult })
      result.read = {
        // REACHABILITY, recorded before any finding is interpreted: "signed in
        // with no data" and "never got past the sign-in wall" are different
        // facts, and a run record that cannot tell them apart makes an empty
        // read undiagnosable (2026-08-01, two studentaid.gov runs). `pages`
        // carries url/title/char-count/access ONLY — never page text, which
        // holds the student's own financial data.
        access: readResult?.access || null,
        pages: (readResult?.raw?.pages || []).map((p) => ({
          url: p?.url || null, landed: p?.landed || null, title: p?.title || null,
          chars: p?.chars ?? null, access: p?.access || null,
        })),
        fields_found: (readResult?.fields || []).length,
        // Name the fields a sync wrote — a bare fieldsWritten count is
        // unauditable after the fact.
        fields: (readResult?.fields || []).map((f) => ({ sectionKey: f?.sectionKey, field: f?.field })),
        awards_found: (readResult?.awards || []).length,
        // Aid the profile DECLINED by preference (e.g. loans). Surfaced so the
        // owner can see exactly what was left out and why — never a silent drop.
        awards_declined_by_preference: persisted?.awardsDeclinedByPreference || [],
        // Fabrication-guard audit trail: extracted items REFUSED as user awards.
        rejected: readResult?.rejected || [],
        not_found: readResult?.notFound || [],
        persisted,
      }
      summary.read = result.read

      // Lifecycle state per the completeness contract: terminal `merged` ONLY
      // when the connector certified every required domain, else the honest
      // non-terminal `partially_synced` when real data was pulled. Recorded
      // with the sync run as auditable proof; a partial sync stays on the
      // weekly reminder (it isn't done) but no longer reads as "unmerged".
      const mergeOutcome = await finalizeReadMerge(db, { profileId, host, runId, persisted, connector, readResult })
      result.merged = mergeOutcome.merged
      result.sync_state = mergeOutcome.state
      summary.merged = mergeOutcome.merged
      summary.sync_state = mergeOutcome.state

      // UMBRELLA-APPLICATION COVERAGE (owner rule 2026-08-02): when the
      // connector VERIFIED the school's general scholarship application
      // submitted (quote-anchored), reflect that onto every governed pipeline
      // grant and Hamilton task — the portal's own rule is that those
      // scholarships cannot be applied to individually, so leaving them at
      // pending_review describes work that does not exist. A read that
      // verified nothing is a hard no-op inside the service.
      if (readResult?.generalApplication) {
        try {
          const { applyGeneralApplicationCoverage } = await import('./generalApplicationCoverage.js')
          const coverage = await applyGeneralApplicationCoverage(db, {
            profileId,
            portalHost: host,
            tenant: readResult?.tenant || null,
            generalApplication: readResult.generalApplication,
            syncRunId: runId,
          })
          if (coverage?.applied) {
            result.general_application_coverage = coverage
            summary.general_application_coverage = coverage
          }
        } catch (err) {
          log(`general-application coverage failed (non-fatal): ${err?.message}`)
        }
      }
    }

    if (dir === 'write' || dir === 'both') {
      // What the household has ACTUALLY WON, read from the pipeline — the
      // canonical record. profileToFundingSources() reads only the
      // university_applications section, so any award won outside a school
      // import was silently never reported to anyone. It stays as a fallback so
      // a profile whose awards live only in that section is never worse off.
      const accepted = await collectAcceptedFundingSources(db, { profileId })
      const fundingSources = accepted.sources.length > 0
        ? accepted.sources
        : profileToFundingSources(profile)
      const writeResult = await connector.write(page, ctx, { fundingSources, allowSubmit: false })
      if (writeResult?.reached === false && dir === 'write') {
        return await fail(`portal unreachable: ${writeResult?.error || 'navigation failed'}`, { unreachable: true })
      }
      result.write = {
        written: writeResult?.written || [],
        // Provenance the owner can audit: how many accepted sources were
        // offered to this portal, and what the household's own aid-type
        // preference held back (never a silent omission).
        sources_offered: fundingSources.length,
        declined_by_preference: accepted.declinedByPreference,
        ...(accepted.truncated > 0 ? { truncated: accepted.truncated } : {}),
        skipped: writeResult?.skipped || [],
        // Portal sync prepares values only; the user completes the irreversible
        // final submission in the portal.
        submitted: writeResult?.submitted === true,
        submit_authorized_by: null,
        // Values may be staged for the user's manual portal handoff.
        submittable: writeResult?.submitted !== true
          && (writeResult?.written || []).some((w) => w?.state === 'filled_not_submitted'),
      }

      // NO ONLINE WAY TO SUBMIT → produce the mail/fax package instead (owner
      // rule, 2026-08-01). Refusing to fake a submission is honest but
      // incomplete: without an artifact the family is simply handed the work
      // back. Hamilton now writes a signed-ready outside-award report into the
      // profile's Documents and TELLS the owner it is there.
      //
      // Fires only when there was real work to report and the portal gave us no
      // way to send it — never after a successful submit, and never for an
      // empty list.
      if (needsMailFaxPacket(writeResult, fundingSources)) {
        const packet = await buildOutsideAwardFallbackPacket(db, {
          profile, profileId, host, fundingSources, actorUserId,
        })
        if (packet) result.write.mail_fax_packet = packet
      }
      if (writeResult?.reached === false) result.write.unreachable = writeResult?.error || 'navigation failed'
      summary.write = result.write
    }

    // hit_login_wall_never_completed: mirrors the file's own early-exit
    // vocabulary (the fail() helper above always finishes a run 'failed') so
    // portalSyncStaleness.js's status='completed' filter and
    // portalSyncHealth.js's failing-count (status==='failed' || Boolean(error))
    // both correctly stop treating a dead-session wall-hit as a real sync.
    await finishRun(db, runId, {
      status: hitLoginWall ? 'failed' : 'completed',
      summary,
      error: hitLoginWall
        ? 'portal sync reached the sign-in wall — saved session not accepted'
        : undefined,
    }).catch(() => {})
    await recordStudentPortalChecks(db, { profileId, host, status: 'completed' })
    if (hitLoginWall) result.hit_login_wall = true
    return result
  } catch (err) {
    return fail(err?.message || String(err))
  } finally {
    // ALWAYS close the browser.
    if (browser) { try { await browser.close() } catch { /* best-effort */ } }
  }
}

export const _internal = {
  persistReadResult, recordStudentPortalChecks, applyFafsaStatusFromRead, markSessionDeadAfterWall,
  buildOutsideAwardFallbackPacket,
}

export default { runPortalSync, listConnectors, getConnectorForHost, ensurePortalSyncSchema, listRuns }
