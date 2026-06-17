/**
 * externalApplicationAdapter.js
 *
 * Adapter for `external_application` portals — opportunities hosted on
 * generic scholarship marketplaces (CommonApp, Going Merry, Scholarship
 * Owl, etc.) where Yana CAN draft a full application package using the
 * apply-engine, but the user must finalise + submit through the external
 * site (Yana never holds the user's marketplace credentials).
 *
 * This adapter is safe-by-default: prepareApplication seeds the apply
 * engine with sections + checklist; fillApplication populates them from
 * the profile; submitApplication is always blocked with a clear
 * instruction.
 */

import { ADAPTER_OUTCOMES, makeAdapterResult, detectMissingProfileFields, detectMissingDocuments } from './portalAdapterTypes.js'

const DEFAULT_REQUIRED_FIELDS = Object.freeze([
  { key: 'first_name', label: 'First name', path: 'basic_information.first_name' },
  { key: 'last_name', label: 'Last name', path: 'basic_information.last_name' },
  { key: 'email', label: 'Email', path: 'basic_information.email' },
  { key: 'date_of_birth', label: 'Date of birth', path: 'basic_information.date_of_birth' },
  { key: 'state', label: 'State', path: 'basic_information.state' },
  { key: 'school_name', label: 'School', path: 'university_applications.applications.0.name' },
])

const DEFAULT_REQUIRED_DOCS = Object.freeze([
  { key: 'transcript', label: 'Transcript' },
  { key: 'personal_statement', label: 'Personal statement / essay' },
])

export const externalApplicationAdapter = Object.freeze({
  name: 'external_application',
  portalTypes: ['external_application'],

  canHandle(portalLink, opportunity) {
    if (portalLink?.portal_type === 'external_application') return true
    const url = opportunity?.application_url || opportunity?.source_url || ''
    return /commonapp\.org|scholarships\.com|fastweb\.com|goingmerry\.com|appily\.com|niche\.com|bigfuture|college[\s-]?board|scholarshipowl|cappex/i.test(url)
  },

  inspectRequirements({ profile, documents }) {
    const missing = [
      ...detectMissingProfileFields(profile, DEFAULT_REQUIRED_FIELDS),
      ...detectMissingDocuments(documents, DEFAULT_REQUIRED_DOCS),
    ]
    if (missing.length === 0) {
      return makeAdapterResult({
        outcome: ADAPTER_OUTCOMES.READY,
        message: 'External application can be drafted from the profile and documents on file.',
      })
    }
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.BLOCKED_MISSING,
      message: 'Some profile fields/documents are still needed before Yana can draft the application.',
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

    const filled = {
      first_name: readPath(ctx.profile, 'basic_information.first_name') ?? null,
      last_name: readPath(ctx.profile, 'basic_information.last_name') ?? null,
      email: readPath(ctx.profile, 'basic_information.email') ?? null,
      state: readPath(ctx.profile, 'basic_information.state') ?? null,
      school_name: readPath(ctx.profile, 'university_applications.applications.0.name') ?? null,
    }

    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.DRAFT_COMPLETED,
      message: 'Application draft prepared — please log in to the external site to finalise and submit.',
      filledFields: filled,
      submissionMethod: 'portal',
    })
  },

  submitApplication() {
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.WAITING_FOR_USER,
      message:
        'External marketplaces require the student to submit through their own account. Yana will not submit on the student\'s behalf.',
      safeToProceed: false,
      blockingReason: 'external_user_submission_only',
    })
  },

  getMissingInfo({ profile, documents }) {
    return [
      ...detectMissingProfileFields(profile, DEFAULT_REQUIRED_FIELDS),
      ...detectMissingDocuments(documents, DEFAULT_REQUIRED_DOCS),
    ]
  },

  getHumanReadableStatus({ portalLink }) {
    return `External application portal (${portalLink?.application_url || 'URL unknown'}). Yana drafts the application, but the student must submit through the external site.`
  },
})

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
