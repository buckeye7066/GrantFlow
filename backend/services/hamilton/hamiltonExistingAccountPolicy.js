/**
 * hamiltonExistingAccountPolicy.js
 *
 * Owner doctrine 2026-08-22, condition 4: when a portal requires a login for an
 * account the APPLICANT ALREADY HAS but that is NOT in the vault — the canonical
 * case is FAFSA / studentaid.gov, where a person has exactly one federal FSA ID
 * bound to their identity — Hamilton must ASK the profile owner for that login
 * the same way he asks for any missing information. He must NOT try to create a
 * second account (it is identity-bound; a duplicate is impossible or harmful).
 *
 * This is the DISTINCTION between the two login situations:
 *   - EXISTING account, not in vault  → ASK for the login (condition 4).
 *   - NO account yet                  → Hamilton creates one under his own
 *                                        identity and proceeds (not this module).
 *
 * Two signals mean "existing account, ask for it":
 *   1. IDENTITY-BOUND host — a portal from the registry below where a person
 *      inherently has a single pre-existing account (federal aid, IRS, SSA,
 *      identity providers). Hamilton never creates accounts on these.
 *   2. An "account already exists" signal observed on the page / from a signup
 *      attempt (the signup adapter's `already_exists` outcome).
 *
 * Pure + data-driven. Records nothing itself; the caller records the missing-
 * info ask and surfaces it. Never fabricates a credential.
 */

// Registry: hosts where the applicant owns a single identity-bound account that
// Hamilton must never re-create. Matched on registrable suffix so subdomains
// (studentaid.gov, fafsa.ed.gov, sa.www4.irs.gov) are covered.
export const IDENTITY_BOUND_ACCOUNT_HOSTS = Object.freeze([
  'studentaid.gov',
  'fafsa.gov',
  'fafsa.ed.gov',
  'fsapartners.ed.gov',
  'irs.gov',
  'ssa.gov',
  'login.gov',
  'id.me',
  'my.gov',
  'benefits.gov',
])

function registrableMatch(host, suffix) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '')
  const s = String(suffix || '').toLowerCase()
  return h === s || h.endsWith(`.${s}`)
}

/** Is this a portal where the applicant already owns an identity-bound account? */
export function isIdentityBoundAccountHost(host) {
  if (!host) return false
  return IDENTITY_BOUND_ACCOUNT_HOSTS.some((s) => registrableMatch(host, s))
}

// "An account with this email already exists" family. Mirrors the signup
// adapter's ALREADY_EXISTS_RX so the two agree on what the copy means.
const ALREADY_EXISTS_RX = /\b(already\s+(registered|have\s+an?\s+account|exists|in\s+use|taken)|account\s+already|email\s+(is\s+)?already\s+(registered|taken|in\s+use)|an\s+account\s+with\s+(this|that)\s+email|user(name)?\s+(already\s+)?(exists|taken)|duplicate\s+account)\b/i

export function pageSignalsExistingAccount(text) {
  return ALREADY_EXISTS_RX.test(String(text || ''))
}

/**
 * Decide whether a login wall is an EXISTING-account ask (condition 4).
 * @param {{host?:string, signupOutcome?:string, pageText?:string}} input
 * @returns {{ask:boolean, reason:string|null}}
 *   reason ∈ identity_bound_host | account_already_exists | null
 */
export function requiresExistingExternalLogin({ host = null, signupOutcome = null, pageText = null } = {}) {
  if (String(signupOutcome || '').toLowerCase() === 'already_exists') {
    return { ask: true, reason: 'account_already_exists' }
  }
  if (isIdentityBoundAccountHost(host)) {
    return { ask: true, reason: 'identity_bound_host' }
  }
  if (pageSignalsExistingAccount(pageText)) {
    return { ask: true, reason: 'account_already_exists' }
  }
  return { ask: false, reason: null }
}

/**
 * The missing-info ask (kind 'login') for an existing external login. Deep-links
 * to the saved-logins / vault surface where the owner supplies it. Never invents
 * a value; the owner enters it. Keyed per host so N portals dedupe cleanly.
 */
export function buildExistingLoginAsk({ host = null, reason = 'identity_bound_host' } = {}) {
  const where = host || 'this portal'
  const detail = reason === 'account_already_exists'
    ? `An account already exists at ${where} for this applicant. Hamilton will NOT create a second account — please add the existing login (username + password) on the Saved portal logins card and Hamilton will sign in and finish.`
    : `${where} uses an account the applicant already has (e.g. a federal FSA ID). Hamilton never creates one of these — please add the existing login on the Saved portal logins card and Hamilton will sign in and finish.`
  return {
    kind: 'login',
    key: `portal_login:${host || 'unknown'}`,
    label: `Sign-in needed for ${where}`,
    description: detail,
    required: true,
  }
}

export const _internal = { registrableMatch, ALREADY_EXISTS_RX }
