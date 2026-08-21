/**
 * hamiltonIdentity.js
 *
 * Hamilton's OWN contact identity, and the two-phase portal identity policy
 * that full automation runs on.
 *
 * WHY THIS EXISTS
 * ---------------
 * Owner order 2026-08-20: "Full automation means full automation."
 *
 * Portal account creation kept stopping at email/SMS verification because
 * Hamilton registered accounts under the PROFILE's email and phone, and
 * Hamilton cannot read a profile owner's mailbox. So every signup that gated on
 * a verification code became a human handoff, and "full automation" stopped
 * short of creating the account it existed to create.
 *
 * The fix is to split identity into two phases:
 *
 *   PHASE 1 - REGISTRATION. Hamilton creates the account with the profile's
 *   NAME, LOGIN and PASSWORD (from the vault - the account must belong to the
 *   applicant) but with HIS OWN email and phone. Verification codes therefore
 *   arrive somewhere Hamilton can actually read, and signup completes.
 *
 *   PHASE 2 - HANDOVER. Once the account exists AND the application has been
 *   submitted, Hamilton edits the portal profile over to the applicant's real
 *   email and phone, and keeps his own as the SECONDARY contact so he retains
 *   access for future submissions and status checks.
 *
 * Both phases are gated on the profile having full automation switched on. With
 * it off, nothing here applies and Hamilton stops exactly where he stops today.
 *
 * WHAT THIS MODULE WILL NOT DO
 * ----------------------------
 * It never fabricates identity proofing. A portal that demands an SSN, a
 * government ID, an FSA ID, Login.gov or ID.me still hands off to a human -
 * using Hamilton's mailbox for a verification code is not the same thing as
 * impersonating someone to an identity proofer, and this module keeps that line.
 */

/**
 * Hamilton's own contact details. Owner-supplied 2026-08-20; env vars override
 * so a different deployment can point Hamilton at its own mailbox and number
 * without a code change.
 */
export const HAMILTON_IDENTITY = Object.freeze({
  email: process.env.HAMILTON_IDENTITY_EMAIL || 'Hamilton@axiombiolabs.org',
  phone: process.env.HAMILTON_IDENTITY_PHONE || '423-504-7778',
  displayName: process.env.HAMILTON_IDENTITY_NAME || 'Hamilton (Axiom BioLabs)',
})

/** Digits-only form, for portals that reject punctuation in phone fields. */
export function hamiltonPhoneDigits() {
  return String(HAMILTON_IDENTITY.phone || '').replace(/\D+/g, '')
}

/**
 * Is this profile authorized for full automation?
 *
 * Mirrors `resolveSubmissionDecision` in hamiltonAuthorizationStore, which is
 * the authority at the irreversible boundary. Note the shape: `submit_applications`
 * is an authorization TYPE (one of HAMILTON_AUTHORIZATION_TYPES), while
 * `allow_auto_submit` and `require_human_review` are OPTIONS carried on the
 * grant row - they are not types and never will be. A stored human-review
 * preference is an unconditional veto.
 *
 * This is a read-only predicate for choosing an identity strategy. It is NOT a
 * substitute for calling `resolveSubmissionDecision` immediately before a
 * portal click, which is what actually gates submission.
 */
export function hasFullAutomation(authorizations) {
  const active = (Array.isArray(authorizations) ? authorizations : []).filter(
    (a) => a && a.scope === 'profile' && !a.revoked_at,
  )
  if (active.some((a) => a.options?.require_human_review === true)) return false
  const submit = active.find((a) => a.authorization_type === 'submit_applications')
  if (!submit) return false
  return active.some((a) => a.options?.allow_auto_submit === true)
}

/**
 * PHASE 1 - the identity Hamilton registers a NEW portal account with.
 *
 * The applicant's name/login/password, Hamilton's email/phone. Returns null
 * when full automation is off, so callers fall back to today's behaviour rather
 * than silently using Hamilton's contact details without authorization.
 */
export function registrationIdentity({ profile, vaultLogin, fullAutomation }) {
  if (!fullAutomation) return null
  const p = profile || {}
  const v = vaultLogin || {}
  return {
    phase: 'registration',
    // The account belongs to the applicant.
    fullName: v.full_name || p.full_name || p.name || '',
    username: v.username || p.email || '',
    password: v.password || null,
    // The contact channels belong to Hamilton, so verification reaches him.
    email: HAMILTON_IDENTITY.email,
    phone: HAMILTON_IDENTITY.phone,
    phoneDigits: hamiltonPhoneDigits(),
    contactOwner: 'hamilton',
    rationale:
      'Verification codes must reach Hamilton for signup to complete unattended; '
      + 'the applicant\'s own contact details are written back after submission.',
  }
}

/**
 * PHASE 2 - the edit Hamilton applies to the portal profile after submission.
 *
 * `ready` is false until the account exists AND the application has actually
 * been submitted, because the owner's sequence is explicit: create the account,
 * fill it out, submit, and only then hand the contact details over.
 */
export function handoverIdentity({
  profile,
  vaultLogin,
  fullAutomation,
  accountCreated,
  applicationSubmitted,
}) {
  const p = profile || {}
  const v = vaultLogin || {}
  const blockers = []
  if (!fullAutomation) blockers.push('full automation is not enabled for this profile')
  if (!accountCreated) blockers.push('the portal account has not been created yet')
  if (!applicationSubmitted) blockers.push('the application has not been submitted yet')

  const primaryEmail = v.identity_email || p.email || ''
  const primaryPhone = p.phone || v.phone || ''
  if (!primaryEmail) blockers.push('the profile has no email to hand over to')

  return {
    phase: 'handover',
    ready: blockers.length === 0,
    blockers,
    // What the portal profile becomes.
    primary: {
      fullName: v.full_name || p.full_name || p.name || '',
      email: primaryEmail,
      phone: primaryPhone,
    },
    // Hamilton STAYS, as secondary, or he loses submission access.
    secondary: {
      email: HAMILTON_IDENTITY.email,
      phone: HAMILTON_IDENTITY.phone,
      role: 'secondary_contact',
      reason:
        'Hamilton keeps a secondary contact on the portal so he retains access '
        + 'to submit and to read status notifications for this profile.',
    },
  }
}
