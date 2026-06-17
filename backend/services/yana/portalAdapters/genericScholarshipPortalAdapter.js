/**
 * genericScholarshipPortalAdapter.js
 *
 * Browser adapter for institutional scholarship portals (Slate,
 * AcademicWorks, Blackbaud, Foundation, etc.) and admissions merit
 * scholarship pages. Inherits everything from the base adapter and
 * adjusts a few heuristics:
 *   - login is more likely to be CAS / SSO
 *   - many scholarship portals embed Google / Microsoft SSO buttons
 *   - "save draft" buttons frequently say "Save & Continue Later"
 */

import { basePortalBrowserAdapter } from './basePortalBrowserAdapter.js'

export const genericScholarshipPortalAdapter = Object.freeze({
  ...basePortalBrowserAdapter,
  name: 'generic_scholarship_portal',
  portalTypes: ['scholarship', 'admissions', 'department', 'program_specific'],

  canHandle(portalLink) {
    return ['scholarship', 'admissions', 'department', 'program_specific']
      .includes(portalLink?.portal_type)
  },

  async detectGate(page) {
    const base = await basePortalBrowserAdapter.detectGate(page)
    if (base) return base
    try {
      const sso = page.locator('button:has-text("Sign in with"), a:has-text("Sign in with")')
      if (await sso.count()) {
        return { kind: 'login', reason: 'Scholarship portal exposes SSO sign-in buttons — supervised login required' }
      }
    } catch { /* ignore */ }
    return null
  },
})
