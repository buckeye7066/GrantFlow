/**
 * genericAdmissionsPortalAdapter.js
 *
 * Admissions / applicant portals (Slate, CommonApp instances, Liaison,
 * Acuity). Yana can usually fill the form, but the final submit is
 * always behind a student-only signature/attestation, so submission
 * defers to the student.
 */

import { basePortalBrowserAdapter } from './basePortalBrowserAdapter.js'

export const genericAdmissionsPortalAdapter = Object.freeze({
  ...basePortalBrowserAdapter,
  name: 'generic_admissions_portal',
  portalTypes: ['admissions', 'external_application'],

  canHandle(portalLink) {
    return ['admissions', 'external_application'].includes(portalLink?.portal_type)
  },

  async detectGate(page) {
    if (!page) return null
    const url = (await page.url?.()) || ''
    if (/login|signin|account|portal\.commonapp\.org/i.test(url)) {
      return { kind: 'login', reason: `Admissions URL "${url}" requires applicant login` }
    }
    return basePortalBrowserAdapter.detectGate(page)
  },
})
