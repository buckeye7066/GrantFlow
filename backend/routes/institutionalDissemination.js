import express from 'express'
import { ensureAuth, ensureAdmin } from '../middleware/auth.js'
import { buildInstitutionalNewsletterBundle } from '../services/dissemination/institutionalNewsletter.js'

const router = express.Router()
router.use(ensureAuth)
router.use(ensureAdmin)

function metadata(value) {
  try { return JSON.parse(String(value || '{}')) || {} } catch { return {} }
}

async function loadServerOwnedRecipients(db, requested = []) {
  const ids = [...new Set((Array.isArray(requested) ? requested : []).map((entry) =>
    String(typeof entry === 'string' ? entry : entry?.profile_id ?? entry?.id ?? '').trim()).filter(Boolean))]
  const rows = []
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400)
    const placeholders = batch.map(() => '?').join(', ')
    rows.push(...await db.prepare(
      `SELECT p.id AS profile_id, p.display_name, u.primary_email, u.metadata
         FROM profiles p
         JOIN users u ON u.id = p.user_id
        WHERE p.id IN (${placeholders}) AND COALESCE(p.status, 'active') = 'active'`, // audit:allow dynamic-sql -- placeholders only
    ).all(...batch))
  }
  return rows.map((row) => {
    const preferences = metadata(row.metadata)
    return {
      profile_id: row.profile_id,
      display_name: row.display_name,
      email: row.primary_email,
      active: true,
      email_opt_in: preferences.newsletter_email_opt_in === true,
      email_consent_at: preferences.newsletter_email_consent_at,
    }
  })
}

router.post('/newsletter-bundle', async (req, res, next) => {
  try {
    const recipients = await loadServerOwnedRecipients(req.db, req.body?.recipients)
    return res.json(buildInstitutionalNewsletterBundle({ ...req.body, recipients }))
  } catch (error) {
    if (!error.status) error.status = 400
    return next(error)
  }
})

export default router
