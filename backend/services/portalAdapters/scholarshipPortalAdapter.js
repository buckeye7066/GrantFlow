/**
 * scholarshipPortalAdapter.js
 *
 * Adapter for `scholarship`, `admissions`, `department`, and
 * `program_specific` portal types. These are typically the institutional
 * scholarship portal (or admissions merit award) where Yana CAN draft a
 * full package using the apply-engine, but cannot submit because the
 * portal usually requires either an SSO student login or a manual
 * essay attestation.
 */

import { ADAPTER_OUTCOMES, makeAdapterResult, detectMissingProfileFields, detectMissingDocuments } from './portalAdapterTypes.js'

const DEFAULT_REQUIRED_FIELDS = Object.freeze([
  { key: 'first_name', label: 'First name', path: 'basic_information.first_name' },
  { key: 'last_name', label: 'Last name', path: 'basic_information.last_name' },
  { key: 'email', label: 'Email', path: 'basic_information.email' },
  { key: 'state', label: 'State', path: 'basic_information.state' },
  { key: 'school_name', label: 'School', path: 'university_applications.applications.0.name' },
])

const DEFAULT_REQUIRED_DOCS = Object.freeze([
  { key: 'transcript', label: 'Transcript' },
  { key: 'personal_statement', label: 'Personal statement / essay' },
  { key: 'recommendation', label: 'Recommendation letter (if requested)', required: false },
])

export const scholarshipPortalAdapter = Object.freeze({
  name: 'scholarship_portal',
  portalTypes: ['scholarship', 'admissions', 'department', 'program_specific'],

  canHandle(portalLink) {
    return ['scholarship', 'admissions', 'department', 'program_specific'].includes(portalLink?.portal_type)
  },

  inspectRequirements({ profile, documents }) {
    const missing = [
      ...detectMissingProfileFields(profile, DEFAULT_REQUIRED_FIELDS),
      ...detectMissingDocuments(documents, DEFAULT_REQUIRED_DOCS),
    ]
    if (missing.length === 0) {
      return makeAdapterResult({
        outcome: ADAPTER_OUTCOMES.READY,
        message: 'Scholarship portal application is ready to draft from the profile and documents on file.',
      })
    }
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.BLOCKED_MISSING,
      message: 'Some profile fields/documents are still needed before drafting.',
      requirements: missing,
      safeToProceed: false,
      blockingReason: 'missing_info',
    })
  },

  prepareApplication(ctx) {
    return this.inspectRequirements(ctx)
  },

  fillApplication(ctx) {
    const inspect = this.inspectRequirements(ctx)
    if (inspect.outcome === ADAPTER_OUTCOMES.BLOCKED_MISSING) return inspect

    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.DRAFT_COMPLETED,
      message: 'Scholarship application drafted. The student must review and submit through the school portal.',
      filledFields: collectFilledFields(ctx.profile),
      submissionMethod: 'portal',
    })
  },

  // EVERY STALL HANDS BACK INSTRUCTIONS **AND A LINK** (owner rule; 2026-08-14).
  // Both branches below are stalls, and the FIRST is the common one — auto-submit
  // is OFF by default — yet it used to return a bare action with no destination,
  // while `portalLink` (carrying the very
  // `application_url` the second branch uses two lines down) sat unused in the
  // same signature. The URL-less fallback named nothing at all. A stall the
  // owner cannot act on is indistinguishable from a silent failure.
  submitApplication({ portalLink, options }) {
    const applyUrl = portalLink?.application_url || portalLink?.portal_url || portalLink?.url || null
    const manualStep = applyUrl
      ? ` To finish it yourself now, open ${applyUrl}, sign in with the student's own account, and submit.`
      : ` No portal URL is on file for this scholarship — search the school's financial-aid site for "${portalLink?.portal_name || portalLink?.funder || 'the scholarship portal'}" and submit there, then mark it submitted here.`

    if (!options?.allowSubmit) {
      return makeAdapterResult({
        outcome: ADAPTER_OUTCOMES.WAITING_FOR_USER,
        message: `Automation is off — the draft is ready for the student to use.${manualStep}`,
        safeToProceed: false,
        blockingReason: 'auto_submit_disabled',
      })
    }
    // Even when allowSubmit is true, scholarship portals almost always
    // require a student-owned login + attestation.
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.BLOCKED_LOGIN,
      message: `The school portal requires the student's own login + attestation, so Hamilton drafts but does not submit on the student's behalf.${manualStep}`,
      safeToProceed: false,
      blockingReason: 'institutional_login_required',
    })
  },

  getMissingInfo({ profile, documents }) {
    return [
      ...detectMissingProfileFields(profile, DEFAULT_REQUIRED_FIELDS),
      ...detectMissingDocuments(documents, DEFAULT_REQUIRED_DOCS),
    ]
  },

  getHumanReadableStatus({ portalLink }) {
    return `Scholarship/admissions portal (${portalLink?.application_url || 'URL unknown'}). Yana drafts the application; the student finalises and submits.`
  },
})

function collectFilledFields(profile) {
  const out = {}
  if (!profile) return out
  out.first_name = readPath(profile, 'basic_information.first_name') ?? null
  out.last_name = readPath(profile, 'basic_information.last_name') ?? null
  out.email = readPath(profile, 'basic_information.email') ?? null
  out.state = readPath(profile, 'basic_information.state') ?? null
  out.school_name = readPath(profile, 'university_applications.applications.0.name') ?? null
  out.major = profile.major ?? readPath(profile, 'basic_information.major') ?? null
  return out
}

function readPath(obj, path) {
  if (!obj) return undefined
  const parts = String(path || '').split('.')
  let cur = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    if (/^\d+$/.test(p)) cur = cur[Number(p)]
    else cur = cur[p]
  }
  return cur
}
