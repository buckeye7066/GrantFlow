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
    const portals = (result?.portals || []).map((p) => {
      const key = p?.portalHost ? portalStatusKeyHost(p.portalHost) : ''
      const st = key ? statusMap.get(key) : null
      const mergeStatus = st?.status || PORTAL_STATUS.UNMERGED
      return {
        ...p,
        mergeStatus,
        isMerged: mergeStatus === PORTAL_STATUS.MERGED,
        isComplete: mergeStatus === PORTAL_STATUS.COMPLETE,
        completedAt: st?.completed_at || null,
        mergedAt: st?.merged_at || null,
      }
    })
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
    return res.json({ portals, mailFaxSources: annotated })
  } catch (err) {
    // getProfilePortals already degrades to { portals: [], mailFaxSources: [] }
    // internally; this is a final net so the dashboard never sees a 500.
    log.error('profile_portals_failed', { profileId, err: err?.message })
    return res.json({ portals: [], mailFaxSources: [] })
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
    const row = status === PORTAL_STATUS.MERGED
      ? await markPortalMerged(req.db, { profileId, portalHost, source: 'manual' })
      : await markPortalComplete(req.db, { profileId, portalHost, source: 'manual' })
    if (!row) return res.status(400).json({ error: 'could not set status' })
    return res.json({ ok: true, status: row.status, portalHost: row.portal_host })
  } catch (err) {
    log.error('set_portal_status_failed', { profileId, err: err?.message })
    return res.status(500).json({ error: 'could not set portal status' })
  }
})

export default router
