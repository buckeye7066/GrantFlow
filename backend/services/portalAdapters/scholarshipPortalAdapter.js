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

  submitApplication({ portalLink, options }) {
    if (!options?.allowSubmit) {
      return makeAdapterResult({
        outcome: ADAPTER_OUTCOMES.WAITING_FOR_USER,
        message: 'Auto-submit not enabled — the student must approve the draft before submission.',
        safeToProceed: false,
        blockingReason: 'auto_submit_disabled',
      })
    }
    // Even when allowSubmit is true, scholarship portals almost always
    // require a student-owned login + attestation.
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.BLOCKED_LOGIN,
      message:
        portalLink?.application_url
          ? `Open ${portalLink.application_url} and submit the application; the school portal requires the student's own login + attestation.`
          : 'School scholarship portal requires the student to submit. Yana drafts but does not submit on the student\'s behalf.',
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
