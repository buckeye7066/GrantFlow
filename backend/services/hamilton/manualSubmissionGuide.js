/**
 * manualSubmissionGuide.js
 *
 * Owner directive 2026-08-03: whenever Hamilton cannot finish a submission
 * herself, the PROFILE OWNER must receive concrete instructions and links on
 * how to finish it manually — never a silent parked task.
 *
 * buildManualCompletionGuide(task, extras) is a PURE step builder: it reads
 * only stored facts (task status, recorded portal/application URL, generated
 * packet documents, mailing instructions, unresolved missing-info items) and
 * composes an ordered, honest "finish it yourself" plan. It NEVER invents a
 * URL — when no verified portal link exists it says so and routes through the
 * funder-contact packet instead.
 *
 * The final step of every guide is the honest record step: "Mark submitted"
 * records that YOU submitted it and transmits nothing to the funder (the
 * #1113 copy rule) — so the tracker stops waiting and lifecycle reporting
 * stays truthful.
 *
 * Total over statuses: any non-terminal, non-active status yields at least
 * the generic finish plan, so a new hand-back status can never silently
 * produce "no guidance".
 */

// Statuses where the ball is in the HUMAN's court and a guide applies.
// (blocked_* / waiting_* / needs_* / ready_to_* are matched by prefix too.)
const HANDBACK_PREFIXES = ['blocked', 'waiting', 'needs', 'ready_to']
const ACTIVE_STATUSES = new Set([
  'ready_to_start', 'queued', 'running', 'launching_portal', 'filling_portal',
  'preflight', 'in_progress',
])
const TERMINAL_STATUSES = new Set([
  'submitted', 'completed', 'complete', 'done', 'failed', 'cancelled',
  'canceled', 'archived', 'rejected', 'closed',
])

export function taskNeedsHumanFinish(status) {
  const s = String(status || '').toLowerCase()
  if (!s || TERMINAL_STATUSES.has(s) || ACTIVE_STATUSES.has(s)) return false
  return HANDBACK_PREFIXES.some((p) => s.startsWith(p))
}

const MARK_SUBMITTED_STEP = {
  action: 'record',
  text: 'Once the funder has it, record it in GrantFlow: open this funding source in your tracker and use "Mark submitted". This records that YOU submitted it (it transmits nothing to the funder) so the tracker stops waiting and your reports stay accurate.',
}

function portalStep(portalUrl, { title = null } = {}) {
  if (portalUrl) {
    return {
      action: 'open_portal',
      url: portalUrl,
      text: `Open the application page${title ? ` for "${title}"` : ''} and sign in if it asks (signing in side-by-side with Hamilton watching lets her capture the session and resume future work herself).`,
    }
  }
  return {
    action: 'find_portal',
    text: 'No verified application link is on record for this funder — confirm the real application page with the funder directly (their own website or phone/email in the packet) before sending anything. GrantFlow deliberately never guesses a portal link.',
  }
}

function packetStep(task) {
  const hasPacket = Boolean(task?.output_pdf_document_id || task?.output_docx_document_id || task?.output_document_id)
  if (!hasPacket) return null
  return {
    action: 'download_packet',
    document_id: task.output_pdf_document_id || task.output_docx_document_id || task.output_document_id,
    text: 'Download the application packet Hamilton already prepared (under this profile’s Documents). It contains the drafted answers/sections — copy from it rather than starting from scratch.',
  }
}

function mailingText(task) {
  const mi = task?.mailing_instructions
  if (!mi || typeof mi !== 'object') return null
  const addr = mi.mailing_address || mi.address || null
  const email = mi.email || null
  const fax = mi.fax || null
  const parts = []
  if (addr) parts.push(`mail it to: ${addr}`)
  if (email) parts.push(`email it to: ${email}`)
  if (fax) parts.push(`fax it to: ${fax}`)
  return parts.length ? parts.join('; ') : null
}

/**
 * @param {object} task            applicationTaskStore rowToTask shape
 * @param {object} [extras]
 * @param {string} [extras.title]      resolved funding-source title
 * @param {string} [extras.portalUrl]  best verified portal/application URL (nullable)
 * @param {Array}  [extras.missingItems] unresolved missing-info rows [{label,key,kind,required}]
 * @returns {{ headline: string, why: string, steps: Array<{action:string,text:string,url?:string,document_id?:string}> }|null}
 *          null when the task is active/terminal (no guide applies).
 */
export function buildManualCompletionGuide(task, extras = {}) {
  if (!task || !taskNeedsHumanFinish(task.status)) return null
  const status = String(task.status || '').toLowerCase()
  const title = extras.title || null
  const portalUrl = extras.portalUrl || null
  const missing = Array.isArray(extras.missingItems) ? extras.missingItems.filter(Boolean) : []
  const steps = []
  let headline
  let why

  const missingNames = missing
    .map((m) => m.label || m.key || (String(m.kind || '') === 'document' ? 'a document' : 'a detail'))
    .slice(0, 6)

  if (status === 'waiting_for_missing_info' || status === 'blocked_missing_info') {
    headline = 'Hamilton needs a few details, or you can finish it yourself'
    why = missingNames.length
      ? `The application still needs: ${missingNames.join(', ')}${missing.length > missingNames.length ? ', …' : ''}. Hamilton could not find these on the profile.`
      : 'The application still has required questions Hamilton could not answer from the profile.'
    steps.push({
      action: 'fill_profile',
      text: missingNames.length
        ? `Fastest path: add ${missingNames.join(', ')} to the profile (use "Go there" on each flagged item) — Hamilton can resume draft preparation on her next pass; final portal Submit remains yours.`
        : 'Fastest path: answer the flagged items on the profile — Hamilton can resume draft preparation on her next pass; final portal Submit remains yours.',
    })
    steps.push({ ...portalStep(portalUrl, { title }), text: `Or finish it yourself now: ${portalStep(portalUrl, { title }).text}` })
    const pk = packetStep(task)
    if (pk) steps.push(pk)
    steps.push({ action: 'submit', text: 'Answer the remaining questions on the portal and click Submit there.' })
    steps.push(MARK_SUBMITTED_STEP)
  } else if (status === 'ready_to_print_mail' || status === 'ready_to_email' || status === 'ready_to_fax') {
    const verb = status === 'ready_to_print_mail' ? 'print and mail' : status === 'ready_to_email' ? 'email' : 'fax'
    headline = `Your completed packet is ready — ${verb} it to the funder`
    why = 'This funder does not take an online submission Hamilton can drive; she prepared the complete packet instead.'
    const pk = packetStep(task)
    if (pk) steps.push(pk)
    const dest = mailingText(task)
    steps.push({
      action: 'send',
      text: dest
        ? `Sign where required, then ${dest}.`
        : `Sign where required, then ${verb} it to the funder (the packet's cover page lists the destination; if it doesn't, confirm with the funder directly).`,
    })
    steps.push(MARK_SUBMITTED_STEP)
  } else if (status === 'waiting_for_review') {
    headline = 'Hamilton filled everything she could — the final review and submit click are yours'
    why = task.last_agent_message || 'Hamilton saved a draft instead of submitting (review requested or submit authority withheld).'
    steps.push(portalStep(portalUrl, { title }))
    const pk = packetStep(task)
    if (pk) steps.push(pk)
    steps.push({
      action: 'submit',
      text: 'Review the saved draft on the portal (or paste from the packet), complete anything it still flags, and click Submit there.',
    })
    steps.push({
      action: 'human_handoff',
      text: 'Hamilton can prepare and save future drafts, but final portal review, signatures, attestations, Submit, and confirmation remain your visible handoff.',
    })
    steps.push(MARK_SUBMITTED_STEP)
  } else if (status === 'waiting_for_login' || status === 'blocked_login_required' || status === 'blocked_2fa' || status === 'blocked_captcha') {
    const what = status === 'blocked_2fa' ? 'a two-factor code' : status === 'blocked_captcha' ? 'a CAPTCHA' : 'a sign-in'
    headline = `The portal wants ${what} only a human can provide`
    why = 'Hamilton never bypasses sign-in walls, 2FA, or CAPTCHAs — one human sign-in unblocks her.'
    steps.push({
      action: 'sign_in',
      url: portalUrl || undefined,
      text: `Sign in once${portalUrl ? ' at the portal link' : ''} side-by-side with Hamilton watching (Portals → this portal → sign in). Hamilton can reuse the authorized session to resume draft preparation; final Submit remains yours.`,
    })
    steps.push({
      action: 'submit',
      text: 'Or finish it yourself while you’re signed in: complete the remaining fields (the packet below has the drafted answers) and click Submit on the portal.',
    })
    const pk = packetStep(task)
    if (pk) steps.push(pk)
    steps.push(MARK_SUBMITTED_STEP)
  } else if (status === 'blocked_terms_or_policy') {
    headline = 'The portal requires terms only you can accept'
    why = 'Legal terms/attestations are yours to read and accept — Hamilton never accepts them for you.'
    steps.push(portalStep(portalUrl, { title }))
    steps.push({ action: 'accept_terms', text: 'Read and accept the portal’s terms, then either re-run Hamilton on this task or finish the remaining fields and submit yourself.' })
    const pk = packetStep(task)
    if (pk) steps.push(pk)
    steps.push(MARK_SUBMITTED_STEP)
  } else {
    // Generic hand-back (unknown blocked/waiting status): still a complete plan.
    headline = 'Hamilton is stuck here — here’s how to finish it yourself'
    why = task.last_agent_message || 'Automation stopped on this application and needs a human to carry it over the line.'
    steps.push(portalStep(portalUrl, { title }))
    const pk = packetStep(task)
    if (pk) steps.push(pk)
    steps.push({ action: 'submit', text: 'Complete the application on the portal (paste from the packet where it helps) and click Submit there.' })
    steps.push(MARK_SUBMITTED_STEP)
  }

  return { headline, why, steps }
}

export default { buildManualCompletionGuide, taskNeedsHumanFinish }
