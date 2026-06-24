/**
 * /api/profiles/:id/portals
 *
 * The per-profile "Portals" dashboard data source. Returns every portal that
 * applies to a profile — prepopulated with a resolved sign-in URL + friendly
 * label + a green/red status — so the UI never asks the user to type a portal
 * name or URL. Hamilton owns the login URL; the user only ever supplies
 * username/password/2FA elsewhere.
 *
 * The portal set is derived (deduped by registrable host) from the profile's
 * pipeline grants, target colleges / university_applications, and any
 * credential/session the profile already holds — see profilePortalIndex.js. It
 * is ALSO joined with relevance + geography gated PROCESS portals (FAFSA/ACT/
 * College Board for students, state benefit portals for need profiles, Grants.gov
 * /SAM.gov for orgs, plus the student's own school) — see processPortals.js.
 *
 * Auth: authenticated caller, profile-access scoped exactly like the rest of the
 * profile surface (admin sees all; others only profiles they can access).
 *
 * The response also carries `mailFaxSources: [...]` — the profile's REAL funding
 * sources (URL present) that are NOT login/application portals (they apply by
 * mail/fax/email, or are info-only pages). The UI shows these in a separate
 * "Apply by mail/fax/email" section with a printable application packet, never as
 * a login tile. Each entry carries `packet: { generated, documentId, at }` so the
 * page can reflect whether Hamilton has already saved a packet to Documents.
 *
 * POST /profiles/:id/portals/packet renders the packet (via the SHARED packet
 * HTML builder) and stores it as a durable Document (BYTEA bytes survive
 * Railway's ephemeral disk), returning { documentId }. GET .../packet/:docId/
 * download streams those bytes.
 *
 * Degrades gracefully: a profile with no portals returns
 * { portals: [], mailFaxSources: [] }, and the resolver never throws, so this
 * endpoint does not 500 on sparse data.
 */

import express from 'express'
import crypto from 'crypto'
import {
  requireAuthenticatedUser,
  getAccessibleProfileIds,
} from '../utils/accessControl.js'
import { getProfilePortals } from '../services/hamilton/profilePortalIndex.js'
import {
  getPortalStatusMap,
  markPortalMerged,
  markPortalComplete,
  PORTAL_STATUS,
  portalStatusKeyHost,
} from '../services/hamilton/portalCompletionStore.js'
import {
  getMasterVaultStatus,
  setMasterPassphrase,
  setAutopilotIdentity,
  unlockVault,
  lockVault,
} from '../services/hamilton/hamiltonPortalMasterVault.js'
import {
  describeAutopilotStateForPortal,
  runAutopilotIdentityForPortal,
  runAutopilotIdentityForProfile,
} from '../services/hamilton/hamiltonPortalAutopilotIdentity.js'
import {
  buildApplicationPacketHtml,
  packetDocumentName,
} from '../../shared/applicationPacketHtml.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('route:profile-portals')
const router = express.Router()

const PACKET_DOC_TYPE = 'application_packet'

async function userMayAccessProfile(req, user, profileId) {
  if (!profileId) return false
  if (user?.role === 'admin') return true
  const accessible = await getAccessibleProfileIds(req.db, user)
  if (accessible === null) return true // global access
  return accessible.has(String(profileId))
}

// ── durable bytes column (self-healing, mirrors the avatar_data BYTEA pattern) ─
// documents.file_bytes holds the packet's bytes so a saved packet survives the
// ephemeral filesystem. Added by migration 0121 in prod; ensured here so SQLite
// (tests/local) and un-migrated deploys both work. Per-db cached so we only try
// the ALTER once per database handle.
const fileBytesReady = new WeakMap()
async function ensureDocumentFileBytesColumn(db) {
  if (!db || fileBytesReady.has(db)) return
  const isPostgres = db?.dialect === 'postgres'
  const type = isPostgres ? 'BYTEA' : 'BLOB'
  try {
    if (isPostgres) {
      await db.exec('ALTER TABLE documents ADD COLUMN IF NOT EXISTS file_bytes BYTEA')
    } else {
      // SQLite has no ADD COLUMN IF NOT EXISTS; a duplicate-column error is fine.
      try { await db.exec(`ALTER TABLE documents ADD COLUMN file_bytes ${type}`) } catch { /* already present */ }
    }
  } catch (err) {
    log.warn('ensure_file_bytes_failed', { err: err?.message })
  }
  fileBytesReady.set(db, true)
}

/**
 * Look up an existing saved packet for one (profile, source) so the page can show
 * "Packet saved to Documents" without re-saving, and so re-clicking re-uses the
 * same document. We match on the durable document name (Funder application packet)
 * scoped to the profile + the application_packet type.
 */
async function findExistingPacket(db, profileId, source) {
  try {
    const name = packetDocumentName(source)
    const row = await db
      .prepare(
        `SELECT id, created_at FROM documents
          WHERE profile_id = ? AND type = ? AND name = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(String(profileId), PACKET_DOC_TYPE, name)
    if (!row) return null
    return { documentId: String(row.id), at: row.created_at || null }
  } catch {
    return null
  }
}

// ── GET the dashboard data ────────────────────────────────────────────────────

router.get('/profiles/:id/portals', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const result = await getProfilePortals(req.db, profileId)
    // Annotate each portal tile with its MERGE/COMPLETION lifecycle status
    // (distinct from the green/red "ready" status): 'merged' (terminal),
    // 'complete' (application done but not merged), or 'unmerged' (default).
    let statusMap = new Map()
    try { statusMap = await getPortalStatusMap(req.db, profileId) } catch { statusMap = new Map() }
    // Per-profile master-vault / autopilot-identity status (read-only): whether a
    // master passphrase is set, whether it's unlocked, and the autopilot identity
    // email Hamilton would register new accounts with.
    let vaultStatus = { has_passphrase: false, is_unlocked: false, identity_email: null }
    try { vaultStatus = await getMasterVaultStatus(req.db, profileId) } catch { /* default */ }
    const portals = []
    for (const p of result?.portals || []) {
      const key = p?.portalHost ? portalStatusKeyHost(p.portalHost) : ''
      const st = key ? statusMap.get(key) : null
      const mergeStatus = st?.status || PORTAL_STATUS.UNMERGED
      // Per-portal autopilot lifecycle state (auto_provisioned / needs_user /
      // identity_proof_required / has_existing_credentials / vault_locked).
      // Read-only — no registration / handoff is triggered on a GET.
      let autopilot = { state: null, detail: null, resolution: null, canAutoMerge: null, cobrowse: null }
      if (p?.portalHost) {
        try {
          autopilot = await describeAutopilotStateForPortal(req.db, {
            profileId, portalHost: p.portalHost, loginUrl: p.loginUrl || null,
            hasCredential: Boolean(p.hasCredential), hasSession: Boolean(p.hasSession),
          })
        } catch { autopilot = { state: null, detail: null, resolution: null, canAutoMerge: null, cobrowse: null } }
      }
      // A portal Hamilton CAN'T auto-merge (terminal autopilot state, all
      // automation exhausted) is plainly flagged and routed to the LAST-RESORT
      // side-by-side co-browse. `canAutoMerge === false` + a cobrowse target ⇒
      // the tile shows "Can't auto-merge — open side-by-side login".
      const offerCobrowse = autopilot.resolution === 'side_by_side_cobrowse'
      portals.push({
        ...p,
        mergeStatus,
        isMerged: mergeStatus === PORTAL_STATUS.MERGED,
        isComplete: mergeStatus === PORTAL_STATUS.COMPLETE,
        completedAt: st?.completed_at || null,
        mergedAt: st?.merged_at || null,
        autopilotState: autopilot.state,
        autopilotDetail: autopilot.detail,
        autopilotResolution: autopilot.resolution || null,
        // null = automation handled it (no merge concept needed); false = can't
        // auto-merge → co-browse; (true only via the read-only describe path).
        canAutoMerge: autopilot.canAutoMerge ?? null,
        cantAutoMerge: autopilot.canAutoMerge === false && offerCobrowse,
        cobrowse: offerCobrowse ? (autopilot.cobrowse || { host: p.portalHost, loginUrl: p.loginUrl || null }) : null,
      })
    }
    // Annotate each mail/fax source with its saved-packet status so the page
    // reflects what Hamilton has already produced.
    const mailFaxSources = Array.isArray(result?.mailFaxSources) ? result.mailFaxSources : []
    const annotated = []
    for (const src of mailFaxSources) {
      const existing = await findExistingPacket(req.db, profileId, src)
      annotated.push({
        ...src,
        packet: existing
          ? { generated: true, documentId: existing.documentId, at: existing.at }
          : { generated: false, documentId: null, at: null },
      })
    }
    return res.json({ portals, mailFaxSources: annotated, vaultStatus })
  } catch (err) {
    // getProfilePortals already degrades to { portals: [], mailFaxSources: [] }
    // internally; this is a final net so the dashboard never sees a 500.
    log.error('profile_portals_failed', { profileId, err: err?.message })
    return res.json({ portals: [], mailFaxSources: [], vaultStatus: { has_passphrase: false, is_unlocked: false, identity_email: null } })
  }
})

// ── POST: render + save a packet to the profile's Documents ────────────────────

router.post('/profiles/:id/portals/packet', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  const body = req.body || {}
  const source = body.source && typeof body.source === 'object' ? body.source : null
  if (!source) return res.status(400).json({ error: 'source required' })
  const profileName = String(body.profileName || '').trim()

  try {
    await ensureDocumentFileBytesColumn(req.db)

    // Re-use an already-saved packet for this source instead of piling up dupes.
    const existing = await findExistingPacket(req.db, profileId, source)
    if (existing) {
      return res.json({ documentId: existing.documentId, reused: true, at: existing.at })
    }

    // Render from the SHARED builder (no auto-print script in the stored copy).
    const html = buildApplicationPacketHtml({
      profileName,
      source,
      autoPrint: false,
      generatedAt: new Date().toISOString(),
    })
    const bytes = Buffer.from(html, 'utf-8')
    const docId = crypto.randomUUID()
    const name = packetDocumentName(source)

    // Insert the Document with durable bytes. Omit `status` (constrained in
    // Postgres) and let the DB default apply; processing_status='completed'
    // because the content is already final text.
    try {
      await req.db
        .prepare(
          `INSERT INTO documents
             (id, profile_id, grant_id, name, type, mime_type, file_size,
              file_bytes, extracted_text, processing_status, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          docId,
          profileId,
          source.grantId || null,
          name,
          PACKET_DOC_TYPE,
          'text/html',
          bytes.length,
          bytes,
          html,
          'completed',
          'Generated application packet (mail/fax/email).',
        )
    } catch (err) {
      // If file_bytes truly isn't available, fall back to a text-only document so
      // the save still succeeds (the printable view is always available client-side).
      if (/file_bytes|column/i.test(String(err?.message || err))) {
        await req.db
          .prepare(
            `INSERT INTO documents
               (id, profile_id, grant_id, name, type, mime_type, file_size,
                extracted_text, processing_status, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            docId, profileId, source.grantId || null, name, PACKET_DOC_TYPE,
            'text/html', bytes.length, html, 'completed',
            'Generated application packet (mail/fax/email).',
          )
      } else {
        throw err
      }
    }

    // Link it into the profile's document set (best-effort; table may not exist
    // on the most minimal test schemas).
    try {
      await req.db
        .prepare(
          `INSERT INTO profile_documents (profile_id, document_id)
           VALUES (?, ?) ON CONFLICT DO NOTHING`,
        )
        .run(profileId, docId)
    } catch { /* non-fatal */ }

    return res.json({ documentId: docId, reused: false, at: null })
  } catch (err) {
    log.error('save_packet_failed', { profileId, err: err?.message })
    return res.status(500).json({ error: 'could not save packet' })
  }
})

// ── GET: download saved packet bytes (durable; survives ephemeral disk) ────────

router.get('/profiles/:id/portals/packet/:documentId/download', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  const documentId = String(req.params?.documentId || '').trim()
  if (!profileId || !documentId) return res.status(400).json({ error: 'bad request' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }

  try {
    // Scope to THIS profile's packet documents only (defense-in-depth: profile +
    // type both bound in SQL, not just a JS check).
    const doc = await req.db
      .prepare('SELECT id, profile_id, name, file_bytes, extracted_text FROM documents WHERE id = ? AND profile_id = ? AND type = ?')
      .get(documentId, profileId, PACKET_DOC_TYPE)
    if (!doc) {
      return res.status(404).json({ error: 'not found' })
    }
    const html = doc.file_bytes
      ? (Buffer.isBuffer(doc.file_bytes) ? doc.file_bytes : Buffer.from(doc.file_bytes))
      : Buffer.from(String(doc.extracted_text || ''), 'utf-8')
    // Strip CR/LF (header-injection) + quotes from the filename.
    const fileName = `${String(doc.name || 'application-packet').replace(/[\r\n"]/g, '').slice(0, 120)}.html`
    // Serve the stored HTML SANDBOXED so it can never script the app origin
    // (stored-XSS guard): the packet body is built from funder/source text. The
    // `sandbox` CSP gives it a unique opaque origin with scripts disabled, so even
    // if any value slipped past HTML-escaping it cannot run or touch app cookies.
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data: https:; style-src 'unsafe-inline'")
    res.setHeader('Content-Disposition', `inline; filename="${fileName}"`)
    return res.send(html)
  } catch (err) {
    // Graceful degradation: a deployment missing the packet storage columns/
    // table (e.g. documents.file_bytes not yet migrated) must 404 "not found"
    // rather than 500 — there is simply no packet to serve here.
    if (/no such table|relation .* does not exist|no such column/i.test(String(err?.message || ''))) {
      return res.status(404).json({ error: 'not found' })
    }
    log.error('download_packet_failed', { profileId, documentId, err: err?.message })
    return res.status(500).json({ error: 'could not download packet' })
  }
})

// ── POST: set a portal's MERGE/COMPLETION lifecycle status ────────────────────
// The UI (or an automation) marks a portal 'merged' once its data has been
// pulled into the profile, or 'complete' when a completed application is on file
// but not yet merged. 'merged' is the only state that ends the weekly reminders.
router.post('/profiles/:id/portals/status', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const body = req.body || {}
  const portalHost = String(body.portalHost || body.host || '').trim()
  const status = String(body.status || '').trim().toLowerCase()
  if (!portalHost) return res.status(400).json({ error: 'portalHost required' })
  if (status !== PORTAL_STATUS.MERGED && status !== PORTAL_STATUS.COMPLETE) {
    return res.status(400).json({ error: 'status must be "merged" or "complete"' })
  }
  try {
    let row
    if (status === PORTAL_STATUS.MERGED) {
      // TRUTHFUL MERGE: a manual mark from the dashboard is an explicit human
      // confirmation ("I merged this"), which the store accepts as proof. The
      // store refuses any merge lacking real confirmation (returns null) so a
      // portal can never be silently/loosely marked merged.
      row = await markPortalMerged(req.db, {
        profileId, portalHost, source: 'manual',
        confirmed: true,
        evidence: typeof body.evidence === 'string' ? body.evidence.slice(0, 240) : null,
      })
      if (!row) return res.status(400).json({ error: 'merge_unconfirmed', detail: 'A merge requires explicit confirmation that the portal data was pulled into the profile.' })
    } else {
      row = await markPortalComplete(req.db, { profileId, portalHost, source: 'manual' })
    }
    if (!row) return res.status(400).json({ error: 'could not set status' })
    return res.json({ ok: true, status: row.status, portalHost: row.portal_host })
  } catch (err) {
    log.error('set_portal_status_failed', { profileId, err: err?.message })
    return res.status(500).json({ error: 'could not set portal status' })
  }
})

// ── Portal Autopilot Identity: master passphrase + identity + run ─────────────
// SECURITY: the master passphrase is accepted only over the authenticated,
// profile-scoped request, used immediately to set/unlock the vault, and is NEVER
// stored, logged, or returned. Responses carry only the public vault STATUS
// (has_passphrase / is_unlocked / identity_email), never the salt/verifier.

// GET the master-vault / autopilot-identity status for a profile.
router.get('/profiles/:id/portal-autopilot', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const status = await getMasterVaultStatus(req.db, profileId)
    return res.json({ ok: true, vault: status })
  } catch (err) {
    log.error('portal_autopilot_status_failed', { profileId, err: err?.message })
    return res.status(500).json({ error: 'could not read vault status' })
  }
})

// Set / rotate the master passphrase (and optionally the identity email). The
// passphrase is consumed here and never persisted.
router.post('/profiles/:id/portal-autopilot/passphrase', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const passphrase = String(req.body?.passphrase || '')
  if (!passphrase) return res.status(400).json({ error: 'passphrase required' })
  try {
    const identityEmail = req.body?.identityEmail ?? req.body?.identity_email
    const { status } = await setMasterPassphrase(req.db, {
      profileId, passphrase,
      identityEmail: identityEmail === undefined ? undefined : identityEmail,
    })
    return res.json({ ok: true, vault: status })
  } catch (err) {
    return res.status(400).json({ error: 'set_passphrase_failed', detail: err?.message })
  }
})

// Unlock the vault for this process (derives + caches the wrapping key). The
// passphrase is consumed and discarded.
router.post('/profiles/:id/portal-autopilot/unlock', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const passphrase = String(req.body?.passphrase || '')
  if (!passphrase) return res.status(400).json({ error: 'passphrase required' })
  try {
    const result = await unlockVault(req.db, { profileId, passphrase })
    if (!result.ok) {
      // ROOT CAUSE FIX: a failed vault unlock is a DOMAIN authorization failure
      // (wrong / unset passphrase), NOT an HTTP-session auth failure — so it must
      // be 403, never 401. The frontend APIClient treats ANY 401 on a non-/api/auth
      // endpoint as an expired access token: it force-refreshes, retries, gets the
      // SAME 401 ("Still getting 401 after refresh, giving up"), then clearToken()s
      // and marks the session expired — destroying the owner's valid login over a
      // mistyped passphrase (and firing the unlock twice on the way). 403 surfaces
      // cleanly to the unlock mutation's onError ("Unlock failed") and never touches
      // the session.
      // Do NOT distinguish "wrong passphrase" from "no passphrase set" beyond the
      // boolean — avoid an oracle. (reason is coarse-grained.)
      return res.status(403).json({ ok: false, error: 'unlock_failed', reason: result.reason || 'wrong_passphrase' })
    }
    const status = await getMasterVaultStatus(req.db, profileId)
    return res.json({ ok: true, vault: status })
  } catch (err) {
    return res.status(500).json({ error: 'unlock_failed', detail: err?.message })
  }
})

// Lock the vault (drop the in-memory wrapping key).
router.post('/profiles/:id/portal-autopilot/lock', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  lockVault(profileId)
  try {
    const status = await getMasterVaultStatus(req.db, profileId)
    return res.json({ ok: true, vault: status })
  } catch {
    return res.json({ ok: true, vault: { profile_id: profileId, has_passphrase: false, is_unlocked: false } })
  }
})

// Set / clear the autopilot identity email (independent of the passphrase).
router.post('/profiles/:id/portal-autopilot/identity', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const identityEmail = req.body?.identityEmail ?? req.body?.identity_email ?? null
    const status = await setAutopilotIdentity(req.db, { profileId, identityEmail })
    return res.json({ ok: true, vault: status })
  } catch (err) {
    return res.status(400).json({ error: 'set_identity_failed', detail: err?.message })
  }
})

// Run autopilot identity for the whole profile (every applicable portal), or for
// ONE portal when `portalHost` is supplied. A single-portal run may return a
// one-time password view for an auto_provisioned login; bulk runs never do.
router.post('/profiles/:id/portal-autopilot/run', async (req, res) => {
  const user = requireAuthenticatedUser(req, res)
  if (!user) return undefined
  const profileId = String(req.params?.id || '').trim()
  if (!profileId) return res.status(400).json({ error: 'profile id required' })
  if (!(await userMayAccessProfile(req, user, profileId))) {
    return res.status(403).json({ error: 'forbidden' })
  }
  const userId = user?.id || user?.userId || 'system_admin_token'
  const portalHost = String(req.body?.portalHost || req.body?.portal_host || '').trim()
  // PREVIEW: dryRun provisions the credential record + plans the registration but
  // never launches a browser, so the owner can preview what autopilot would do.
  const dryRun = req.body?.dryRun === true || req.body?.dry_run === true
  try {
    if (portalHost) {
      // Load the profile bundle so the signup adapter can fill name/phone fields.
      let profile = null
      try {
        const { _internal } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
        profile = await _internal.loadProfileBundle(req.db, profileId)
      } catch { profile = null }
      const result = await runAutopilotIdentityForPortal(req.db, {
        profileId, userId, portalHost, profile, dryRun,
        loginUrl: req.body?.loginUrl || req.body?.login_url || null,
      })
      return res.json({ ok: true, result })
    }
    const { results, summary } = await runAutopilotIdentityForProfile(req.db, { profileId, userId, dryRun })
    return res.json({ ok: true, results, summary })
  } catch (err) {
    log.error('portal_autopilot_run_failed', { profileId, err: err?.message })
    return res.status(500).json({ error: 'autopilot_run_failed', detail: err?.message })
  }
})

export default router
