/**
 * universityFinancialAidAdapter.js
 *
 * Adapter for `financial_aid`, `student_account`, `bursar`, and
 * `graduate_school` portal types — institutional aid portals that
 * always require a student-owned login (SSO, FAFSA SAID, school
 * portal). Yana never logs in on the student's behalf.
 *
 * Workflow:
 *   - inspect: detect FAFSA gating, missing profile data, and the
 *     mandatory student login.
 *   - prepare/fill: write a checklist of next-actions the student
 *     must perform inside the institutional portal.
 *   - submit: ALWAYS blocked. The portal owns submission.
 */

import { ADAPTER_OUTCOMES, makeAdapterResult, detectMissingProfileFields } from './portalAdapterTypes.js'
import { makeBlockedLoginResult } from './basePortalAdapter.js'

const DEFAULT_REQUIRED_FIELDS = Object.freeze([
  { key: 'first_name', label: 'First name', path: 'basic_information.first_name' },
  { key: 'last_name', label: 'Last name', path: 'basic_information.last_name' },
  { key: 'date_of_birth', label: 'Date of birth', path: 'basic_information.date_of_birth' },
  { key: 'school_name', label: 'School', path: 'university_applications.applications.0.name' },
])

export const universityFinancialAidAdapter = Object.freeze({
  name: 'university_financial_aid',
  portalTypes: ['financial_aid', 'student_account', 'bursar', 'graduate_school'],

  canHandle(portalLink) {
    return ['financial_aid', 'student_account', 'bursar', 'graduate_school'].includes(portalLink?.portal_type)
  },

  inspectRequirements({ profile, portalLink, opportunity }) {
    const requirements = []

    // Always require a student login — Yana cannot bypass institutional auth.
    requirements.push({
      kind: 'login',
      key: `${portalLink?.portal_type || 'financial_aid'}_login`,
      label: `${portalLink?.portal_type === 'financial_aid' ? 'Financial aid' : portalLink?.portal_type === 'bursar' ? 'Bursar' : 'Student account'} portal login`,
      description:
        portalLink?.application_url
          ? `Log in to ${portalLink.application_url} (the school's portal). Yana cannot log in on your behalf.`
          : 'Student must log in to the school portal — Yana cannot log in on the student\'s behalf.',
      required: true,
    })

    // FAFSA gating for federal need-based aid
    if (
      /need[-\s]?based|fafsa|work[-\s]?study|pell/i.test(`${opportunity?.title || ''} ${opportunity?.description || ''}`)
      && !readPath(profile, 'household.fafsa_filed')
    ) {
      requirements.push({
        kind: 'attestation',
        key: 'fafsa_filed',
        label: 'Confirm FAFSA filed for current year',
        description: 'Need-based institutional aid almost always requires a current-year FAFSA.',
        required: true,
      })
    }

    // Missing profile fields
    requirements.push(...detectMissingProfileFields(profile, DEFAULT_REQUIRED_FIELDS))

    return makeBlockedLoginResult({
      message:
        portalLink?.portal_type === 'financial_aid'
          ? 'Yana cannot directly submit institutional financial-aid applications — the student must log in to the school portal.'
          : portalLink?.portal_type === 'bursar'
          ? 'Bursar/account portals require a student login. Yana will list the next steps but cannot submit payments.'
          : 'Institutional portals require a student login. Yana will list the next steps but cannot submit on the student\'s behalf.',
      requirements,
    })
  },

  prepareApplication(ctx) { return this.inspectRequirements(ctx) },
  fillApplication(ctx) { return this.inspectRequirements(ctx) },

  submitApplication() {
    return makeAdapterResult({
      outcome: ADAPTER_OUTCOMES.BLOCKED_LOGIN,
      message: 'Institutional aid portals never accept third-party submissions.',
      safeToProceed: false,
      blockingReason: 'institutional_login_required',
    })
  },

  getMissingInfo(ctx) {
    return this.inspectRequirements(ctx).requirements
  },

  getHumanReadableStatus({ portalLink }) {
    if (!portalLink?.application_url) {
      return 'Institutional aid portal — student login required. URL not yet known.'
    }
    return `Institutional aid portal (${portalLink.application_url}). The student must log in directly; Yana will track the application but cannot submit.`
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
