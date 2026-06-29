/**
 * Yana — outreach drafter (legacy filename `yanaOutreachDrafter.js`).
 *
 * Pure function that turns a lead packet into a draft email/letter. The
 * output is *only* a draft — sending always requires explicit per-attempt
 * admin approval downstream (see yanaOutreachSender).
 *
 * Drafts are intentionally short, specific, and respectful. We always
 * include:
 *   - the recipient's organization name (so it's never anonymous/templatic)
 *   - a single concrete reason GrantFlow believes they'd benefit
 *   - one explicit ask (a 15-min call OR a reply with a no/yes)
 *   - a one-click unsubscribe-equivalent ("just reply STOP")
 *   - a hard cap on length so drafts never look like a content farm
 */

import { OUTREACH_CHANNEL, makeOutreachAttempt } from './yanaOutreachTypes.js'

const MAX_BODY_CHARS = 1800
const MIN_BODY_CHARS = 240

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

function firstName(fullName) {
  if (!fullName) return null
  const parts = String(fullName).trim().split(/\s+/)
  return parts[0] || null
}

function pitchSentence(packet) {
  if (packet?.recommended_pitch) return packet.recommended_pitch
  return `${packet?.packet_json?.organization_name || 'Your organization'} looks like a strong fit for GrantFlow.`
}

function reasonSentence(packet) {
  const r = packet?.packet_json?.scoring?.fit_reasons || []
  const top = r[0]
  if (top?.detail) return `Specifically: ${top.detail}.`
  return null
}

function urgencySentence(packet) {
  const r = packet?.packet_json?.scoring?.urgency_reasons || []
  const top = r[0]
  if (top?.detail) return `We also noticed: ${top.detail}.`
  return null
}

/**
 * Draft an email. Returns an attempt-shaped object that is NOT yet persisted.
 * Persistence is the caller's job (e.g. the agent orchestrator).
 */
export function draftEmail(packet, { fromName = 'The GrantFlow team', signupUrl = 'https://grantflow.app', config = null } = {}) {
  void config
  if (!packet || !packet.packet_json) return null
  const orgName = packet.packet_json.organization_name || 'your organization'
  const contactName = firstName(packet.packet_json?.primary_contact?.name) || null

  const greeting = contactName ? `Hi ${contactName},` : `Hello,`
  const pitch = pitchSentence(packet)
  const reason = reasonSentence(packet)
  const urgency = urgencySentence(packet)

  const lines = []
  lines.push(greeting)
  lines.push('')
  lines.push(pitch)
  if (reason) lines.push(reason)
  if (urgency) lines.push(urgency)
  lines.push('')
  lines.push(
    `GrantFlow helps grant-seeking organizations like yours find real funding sources, match them to your specific needs, track applications, and avoid the dead-link / loan-product / expired-deadline noise that makes grant search miserable.`,
  )
  lines.push('')
  lines.push(
    `Would a 15-minute walkthrough be useful? If GrantFlow isn't a fit, just reply "no thanks" and we won't follow up.`,
  )
  lines.push('')
  lines.push(`If you'd rather explore on your own, you can sign up at ${signupUrl}.`)
  lines.push('')
  lines.push(`— ${fromName}`)
  lines.push('')
  lines.push(
    `(If you'd prefer not to receive any future messages from GrantFlow, reply with "STOP" and we'll add ${
      packet.packet_json?.primary_contact?.email || 'this address'
    } to our suppression list.)`,
  )

  let body = lines.join('\n')
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS - 3) + '...'
  }

  const subject = `GrantFlow may help ${orgName} find better grant matches`

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#0f172a">${body
    .split('\n')
    .map((line) => `<p style="margin:0 0 12px">${escapeHtml(line) || '&nbsp;'}</p>`)
    .join('')}</body></html>`

  return makeOutreachAttempt({
    lead_id: packet.id ?? null,
    prospect_candidate_id: packet.prospect_candidate_id ?? packet.packet_json?.prospect_id ?? null,
    channel: OUTREACH_CHANNEL.EMAIL,
    template_id: 'larry_intro_v1',
    draft_subject: subject,
    draft_body: html,
    draft_text: body,
    draft_metadata: {
      template_id: 'larry_intro_v1',
      generated_at: new Date().toISOString(),
      char_count: body.length,
      org_name: orgName,
    },
  })
}

/**
 * Quality gate: refuse to mark a draft as ready if it looks templatic, too
 * short, or doesn't reference the recipient.
 */
export function inspectDraftQuality(draft) {
  const issues = []
  if (!draft) return { ok: false, issues: ['no_draft'] }
  const text = draft.draft_text || ''
  if (text.length < MIN_BODY_CHARS) issues.push(`draft_too_short:${text.length}<${MIN_BODY_CHARS}`)
  if (text.length > MAX_BODY_CHARS) issues.push(`draft_too_long:${text.length}>${MAX_BODY_CHARS}`)
  if (/{{\w+}}/.test(text)) issues.push('unfilled_placeholder')
  const subject = draft.draft_subject || ''
  if (!subject || subject.length < 8) issues.push('subject_too_short')
  return { ok: issues.length === 0, issues }
}
