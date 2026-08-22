/**
 * hamiltonNeedYouRelease.js
 *
 * Owner order 2026-08-22: revisit every "Needs You" card, confirm the need, and
 * if the block is NOT one of the four legitimate hand-off categories, CLEAR it
 * so Hamilton re-attempts (and, under full automation, submits).
 *
 * The four categories that LEGITIMATELY keep a card blocked:
 *   1. PHYSICAL COPY — the funder takes no portal submission; Hamilton makes a
 *      mail/fax/PDF packet with instructions.
 *   2. MISSING INFO — a required fact is genuinely absent from the profile (an
 *      UNRESOLVED missing-info ask); Hamilton has asked the owner.
 *   3. BOT WALL — a full-page bot-protection GrantFlow cannot pass even after
 *      trying (distinct from a plain CAPTCHA, which the solver now attempts).
 *   4. EXTERNAL LOGIN ON FILE — a proven existing account the person already has
 *      that is not in the vault; Hamilton has asked for it.
 *
 * Two more are kept blocked for CORRECTNESS, not because Hamilton failed — and
 * they are reported as such, never "cleared to submit":
 *   - INELIGIBLE — the eligibility gate refused it (e.g. an institution-only
 *     NOFO for an individual). Clearing it would only re-submit to a source the
 *     gate correctly rejects. Owner-endorsed 2026-08-22 (the REU case).
 *   - SUBMIT UNVERIFIED — a submit may already have gone through with no
 *     captured proof; never auto-retried (double-submission risk).
 *
 * Everything else — a filled draft that could not auto-submit, a plain CAPTCHA,
 * a login wall where Hamilton can create the account himself, a 2FA/email step
 * he reads from his own mailbox, an unreachable site, a generic block — is NOT a
 * legitimate hand-off and is RELEASED.
 *
 * Pure + deterministic: classify(task) reads only the task's status +
 * last_agent_message + whether it still has an unresolved missing-info ask.
 */

const RX = {
  physical: /printable packet|pdf_docx pathway|\bmail\b|\bfax\b|forbid(s)? agent automation|print(,| and) (sign|mail)|send yourself/i,
  botWall: /bot protection|anti-?bot|security service|cloudflare|akamai|datadome|perimeterx|managed challenge|security verification|checking your browser/i,
  ineligible: /does not meet grantflow|does not meet|profile is missing|not eligible|preflight: funding source/i,
  tos: /terms (of (service|use))? (do not|don'?t) permit|forbids? automat|policy (prohibits|forbids)/i,
}

const KEEP_STATUSES = new Set([
  'submission_verification_required', // maybe already submitted — never auto-retry
  'ready_to_print_mail', 'ready_to_email', 'ready_to_fax', // physical-copy packet ready
])

/**
 * @param {{status?:string,last_agent_message?:string}} task
 * @param {{hasUnresolvedInfo?:boolean}} ctx  — does the task still have an
 *   unresolved missing-info ask (category 2)?
 * @returns {{keep:boolean, category:string, legitimate:boolean}}
 *   category ∈ physical_copy | missing_info | bot_wall | external_login |
 *             ineligible | submit_unverified | terms_wall | releasable
 *   legitimate = one of the owner's 4 hand-off categories.
 */
export function classifyNeedYouBlock(task = {}, { hasUnresolvedInfo = false } = {}) {
  const status = String(task?.status || '').toLowerCase()
  const msg = String(task?.last_agent_message || '')

  // Safety / correctness keeps first.
  if (status === 'submission_verification_required') return keep('submit_unverified', false)
  if (KEEP_STATUSES.has(status)) return keep('physical_copy', true)
  if (RX.ineligible.test(msg)) return keep('ineligible', false)
  if (RX.tos.test(msg)) return keep('terms_wall', true) // no portal submission → physical/manual class

  // The four legitimate hand-offs.
  if (RX.physical.test(msg)) return keep('physical_copy', true) // 1
  if (status === 'waiting_for_missing_info' && hasUnresolvedInfo) return keep('missing_info', true) // 2
  if (RX.botWall.test(msg)) return keep('bot_wall', true) // 3
  // 4: an EXISTING external login on file. Only a message that says the account
  //    already exists is category 4; a plain login wall is releasable (Hamilton
  //    creates the account under his own identity under full automation).
  if (/already (have|has) (an? )?(account|login|sign[- ]?in)|existing (account|login)|account (already )?exists/i.test(msg)) {
    return keep('external_login', true)
  }

  // Everything else is not a legitimate hand-off → release.
  return { keep: false, category: 'releasable', legitimate: false }
}

function keep(category, legitimate) {
  return { keep: true, category, legitimate: Boolean(legitimate) }
}

export const NEED_YOU_KEEP_CATEGORIES = Object.freeze([
  'physical_copy', 'missing_info', 'bot_wall', 'external_login', 'ineligible', 'submit_unverified', 'terms_wall',
])
