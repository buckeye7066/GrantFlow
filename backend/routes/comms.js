/**
 * comms.js — user-facing messaging (mounted at /api/comms).
 *
 *  - POST /contact                 : email the GrantFlow owner alias from a
 *                                    user's profile (reply-to = the user).
 *  - GET  /me/:profileId/contacts  : the profile's emails + SMS phones/opt-in.
 *  - POST /me/:profileId/sms        : the user opts a phone IN or OUT of SMS.
 *
 * Authenticated; profile-scoped routes check the caller can access the profile.
 */

import express from 'express'
import { ensureAuth } from '../middleware/auth.js'
import { formatError } from '../middleware/errorHandler.js'
import { getAccessibleProfileIds } from '../utils/accessControl.js'
import { sendEmail } from '../services/email.js'
import {
  ownerAliasEmail,
  resolveProfileContacts,
  setPhoneOptIn,
} from '../services/comms/commsService.js'

const router = express.Router()
router.use(ensureAuth)

async function canAccessProfile(req, profileId) {
  if (req.ctx?.isAdmin === true) return true
  const accessible = await getAccessibleProfileIds(req.db, req.user)
  return accessible === null || accessible.has(String(profileId))
}

function callerEmail(req) {
  return req.user?.email ?? req.user?.primary_email ?? null
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Email the owner alias from a profile. Reply-to is the user so the owner can
// just hit reply.
router.post('/contact', async (req, res) => {
  try {
    const { profileId = null, subject = null, message = null } = req.body ?? {}
    if (!message || !String(message).trim()) return res.status(400).json({ error: 'Message is required' })
    if (profileId && !(await canAccessProfile(req, profileId))) {
      return res.status(403).json({ error: 'Not authorized for this profile' })
    }

    const fromUser = callerEmail(req)
    const who = req.user?.display_name || req.user?.full_name || fromUser || 'A GrantFlow user'
    let profileName = null
    if (profileId) {
      try {
        const row = await req.db.prepare('SELECT display_name FROM profiles WHERE id = ? LIMIT 1').get(String(profileId))
        profileName = row?.display_name || null
      } catch { /* best-effort */ }
    }

    const subjectLine = subject && String(subject).trim()
      ? `GrantFlow message: ${String(subject).trim()}`
      : `GrantFlow message from ${who}`
    const text = [
      `From: ${who}${fromUser ? ` <${fromUser}>` : ''}`,
      profileName ? `Profile: ${profileName}` : null,
      profileId ? `Profile ID: ${profileId}` : null,
      '', String(message).trim(),
    ].filter((l) => l !== null).join('\n')
    const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#0f172a;line-height:1.5">
      <p style="color:#475569;font-size:13px">From: <strong>${esc(who)}</strong>${fromUser ? ` &lt;${esc(fromUser)}&gt;` : ''}${profileName ? `<br/>Profile: ${esc(profileName)}` : ''}</p>
      <hr style="border:none;border-top:1px solid #e2e8f0"/>
      <p style="white-space:pre-wrap">${esc(String(message).trim())}</p>
    </div>`

    const result = await sendEmail({
      to: ownerAliasEmail(),
      subject: subjectLine,
      text, html,
      replyTo: fromUser || undefined,
    })
    if (!result.ok) {
      return res.status(result.skipped ? 503 : 502).json({ ok: false, error: result.error || 'send_failed' })
    }
    res.json({ ok: true })
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// Read a profile's contact channels (emails + phones with opt-in state).
router.get('/me/:profileId/contacts', async (req, res) => {
  try {
    const profileId = String(req.params.profileId)
    if (!(await canAccessProfile(req, profileId))) return res.status(403).json({ error: 'Not authorized' })
    const contacts = await resolveProfileContacts(req.db, profileId)
    res.json(contacts)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

// The user opts a phone IN or OUT of SMS for their own profile.
router.post('/me/:profileId/sms', async (req, res) => {
  try {
    const profileId = String(req.params.profileId)
    if (!(await canAccessProfile(req, profileId))) return res.status(403).json({ error: 'Not authorized' })
    const { phone, optIn } = req.body ?? {}
    if (!phone) return res.status(400).json({ error: 'phone is required' })
    const result = await setPhoneOptIn(req.db, { profileId, phone: String(phone), optIn: Boolean(optIn) })
    res.status(result.ok ? 200 : 400).json(result)
  } catch (error) {
    res.status(500).json(formatError(error))
  }
})

export default router
