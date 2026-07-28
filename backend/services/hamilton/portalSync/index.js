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
import { getDecryptedCredentialWithFallback, listCredentialedDomains, registrableDomain } from '../hamiltonPortalCredentialService.js'
import {
  browserAutomationPermittedForUrl,
  isBrowserAutomationEnabled,
} from '../hamiltonAutomationOrchestrator.js'
import { setProfileSectionField } from '../../profileFieldWriter.js'
import { upsertSchoolPortalAwardAsOpportunity } from '../../schoolPortalImportService.js'
import { isDismissed } from '../../pipelineDismissals.js'
import { deriveNamePartsIntoBasicInfo } from '../../../../shared/nameParsing.js'
import { createLogger } from '../../../utils/logger.js'
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
async function persistReadResult(db, { profileId, portalHost, actorUserId, readResult }) {
  const out = { fieldsWritten: 0, fieldsRejected: [], awardsWritten: 0, awardsDismissed: 0, awardsFailed: [] }

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

    const award = {
      id: awardId,
      title,
      provider_name: a?.sponsor || connection.provider_name,
      external_id: a?.externalId || null,
      amount: Number.isFinite(Number(a?.amount)) ? Number(a.amount) : null,
      amount_display: a?.amountDisplay || null,
      description: `Read from ${portalHost} via Hamilton portal sync`,
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
 * Record the terminal `merged` lifecycle state after a successful READ that
 * truly pulled data in (shouldMarkMergedAfterRead), with the sync run as the
 * auditable proof markPortalMerged requires. Returns whether the merge was
 * recorded. Best-effort — a status write failure never breaks the sync.
 */
export async function finalizeReadMerge(db, { profileId, host, runId = null, persisted } = {}) {
  if (!shouldMarkMergedAfterRead(persisted)) return false
  try {
    const { markPortalMerged } = await import('../portalCompletionStore.js')
    const merged = await markPortalMerged(db, {
      profileId, portalHost: host,
      source: 'portal_sync',
      syncRunId: runId || undefined,
      evidence: runId ? `portal_sync_run:${runId}` : `portal_sync_read:${new Date().toISOString()}`,
    })
    return Boolean(merged)
  } catch (err) {
    log.warn('portal_sync_merge_mark_failed', { profileId, host, err: err?.message })
    return false
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

export async function runPortalSync(db, { profileId, portalHost, direction = 'read', actorUserId = null } = {}) {
  if (!db) return { ok: false, direction, connectorId: null, runId: null, error: 'db required' }
  if (!profileId) return { ok: false, direction, connectorId: null, runId: null, error: 'profileId required' }
  const host = normalizeHost(portalHost)
  if (!host) return { ok: false, direction, connectorId: null, runId: null, error: 'portalHost required' }
  const dir = VALID_DIRECTIONS.has(direction) ? direction : 'read'

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
      : 'portal host is not on the allowlist and the profile has no saved credential/session for it'
    return fail(`browser automation not permitted: ${reason}`)
  }

  // Resolve an authenticated context: durable saved session first, then a saved
  // login. At least one is required — without it we cannot act as the user.
  let storageState = null
  try {
    const saved = await findValidSession(db, { profileId, portalHost: host })
    if (saved?.has_storage_state) storageState = await getSessionStorageState(db, saved.id)
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
    ;({ browser } = await launchPortalBrowser(chromium))
    const context = await browser.newContext({
      userAgent: REALISTIC_PORTAL_UA,
      ...(storageState && typeof storageState === 'object' ? { storageState } : {}),
    })
    const page = await context.newPage()

    const ctx = {
      profileId, portalHost: host, actorUserId,
      profile, credential, hasSession: !!storageState, log: ctxLog,
    }

    const result = { ok: true, direction: dir, connectorId, runId }
    if (!runId) result.bookkeeping_degraded = true
    const summary = { connector: connectorId }

    if (dir === 'read' || dir === 'both') {
      const readResult = await connector.read(page, ctx)
      // A connector that could not even REACH the portal (DNS failure, cert
      // mismatch, connection reset) must yield a FAILED run — recording
      // "completed, 0 awards" for a page the browser never loaded shows dead
      // portals as green on every dashboard.
      if (readResult?.reached === false) {
        return await fail(`portal unreachable: ${readResult?.error || 'navigation failed'}`, { unreachable: true })
      }
      const persisted = await persistReadResult(db, { profileId, portalHost: host, actorUserId, readResult })
      result.read = {
        fields_found: (readResult?.fields || []).length,
        // Name the fields a sync wrote — a bare fieldsWritten count is
        // unauditable after the fact.
        fields: (readResult?.fields || []).map((f) => ({ sectionKey: f?.sectionKey, field: f?.field })),
        awards_found: (readResult?.awards || []).length,
        // Fabrication-guard audit trail: extracted items REFUSED as user awards.
        rejected: readResult?.rejected || [],
        not_found: readResult?.notFound || [],
        persisted,
      }
      summary.read = result.read

      // TRUE MERGE: a successful READ that actually pulled the portal's data
      // into the profile IS the merge the lifecycle store defines — record it,
      // with the sync run as auditable proof, so the tile turns "merged" and
      // the weekly unmerged-portals reminder stops nagging about a portal
      // whose data is already in.
      const merged = await finalizeReadMerge(db, { profileId, host, runId, persisted })
      result.merged = merged
      summary.merged = merged
    }

    if (dir === 'write' || dir === 'both') {
      const fundingSources = profileToFundingSources(profile)
      const writeResult = await connector.write(page, ctx, { fundingSources })
      if (writeResult?.reached === false && dir === 'write') {
        return await fail(`portal unreachable: ${writeResult?.error || 'navigation failed'}`, { unreachable: true })
      }
      result.write = {
        written: writeResult?.written || [],
        skipped: writeResult?.skipped || [],
      }
      if (writeResult?.reached === false) result.write.unreachable = writeResult?.error || 'navigation failed'
      summary.write = result.write
    }

    await finishRun(db, runId, { status: 'completed', summary }).catch(() => {})
    await recordStudentPortalChecks(db, { profileId, host, status: 'completed' })
    return result
  } catch (err) {
    return fail(err?.message || String(err))
  } finally {
    // ALWAYS close the browser.
    if (browser) { try { await browser.close() } catch { /* best-effort */ } }
  }
}

export const _internal = { persistReadResult, recordStudentPortalChecks }

export default { runPortalSync, listConnectors, getConnectorForHost, ensurePortalSyncSchema, listRuns }
