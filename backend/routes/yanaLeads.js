/**
 * /api/yana-contacts/* — owner-contacts → Yana leads.
 *
 * Admin-only. Lets the owner seed Yana's lead pipeline from people they already
 * know (email contacts; any social contacts they can export). See
 * yanaContactsImport.js for the connection reality (FB/IG friend lists are not
 * available via any API — manual export only).
 */
import express from 'express'
import { importContactsAsLeads, OWNER_SEED_CONTACTS, parseContactsCsv } from '../services/yana/yanaContactsImport.js'
import { createLogger } from '../utils/logger.js'

const router = express.Router()
const log = createLogger('route:yana-contacts')

function requireAdmin(req, res) {
  if (req.ctx?.isAdmin === true) return true
  res.status(403).json({ error: 'admin_required' })
  return false
}

// Import an explicit list of contacts (emails, optionally with names).
//   body: { contacts: [{email,name?}|"email", ...], source?: 'owner_email'|'owner_social'|... }
router.post('/import', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    // Accept an explicit list OR a pasted/uploaded CSV (Google/Outlook export).
    const contacts = Array.isArray(req.body?.contacts)
      ? req.body.contacts
      : (req.body?.csv ? parseContactsCsv(String(req.body.csv)) : [])
    const source = String(req.body?.source || 'owner_contacts').slice(0, 40)
    const result = await importContactsAsLeads(req.db, { contacts, source, actorUserId: req.ctx?.userId || null })
    log.info('contacts imported', { source, ...result, details: undefined })
    res.json({ ok: true, ...result })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

// Seed the owner's own four addresses as the first leads (idempotent).
router.post('/seed-owner', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const result = await importContactsAsLeads(req.db, {
      contacts: OWNER_SEED_CONTACTS, source: 'owner_email', actorUserId: req.ctx?.userId || null,
    })
    res.json({ ok: true, seeded: OWNER_SEED_CONTACTS, ...result, details: undefined })
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message })
  }
})

export default router
