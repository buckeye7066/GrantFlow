/**
 * Prod 2026-09-06: the engine reached MTSU's scholarship portal
 * (mtsu.scholarships.ngwebsolutions.com), found no form on the PUBLIC landing
 * page (the form is behind the school SSO), and the unknown-method resolver
 * "rescued" the task to mtsu.edu/financial-aid/tels/ — a state-aid information
 * page — which was then decomposed into nine already-catalogued awards. A
 * registered school portal IS the application surface; a form-less landing
 * there is a login wall to park, never a page to replace.
 */
import { describe, it, expect } from 'vitest'
import { resolveUnknownMethod } from '../services/hamilton/hamiltonHardStopResolver.js'
import { resolveInstitutionScholarshipPortal } from '../config/institutionScholarshipPortals.js'

const mtsu = resolveInstitutionScholarshipPortal('Middle Tennessee State University')

describe('resolveUnknownMethod — a registered school portal is never rescued to a public page', () => {
  it('blocks as a login wall naming the portal and its login hint; the rescue search is never called', async () => {
    let searched = 0
    const ctx = {
      taskId: 't1', profileId: 'p1', portalUrl: mtsu.portal_url,
      opportunity: { id: 'o1', title: 'DREAM Scholarship', sponsor: 'Middle Tennessee State University', application_url: 'https://mtsu.edu/scholarships' },
      classification: { automation_type: 'portal', resolved_url: mtsu.portal_url, own_institution_portal: mtsu },
      _urlRescueDeps: { searchWebImpl: async () => { searched += 1; return [{ url: 'https://www.mtsu.edu/financial-aid/tels/', title: 'TELS' }] }, checkUrlImpl: async () => ({ status: 'ok', code: 200 }) },
    }
    const d = await resolveUnknownMethod(null, ctx, { kind: 'no_application_form', url: mtsu.portal_url, detail: 'This page has no application form to fill' })
    expect(d.outcome).toBe('blocked')
    expect(d.strategy).toBe('own_portal_login_not_reached')
    expect(d.retry).toBe(false)
    expect(d.detail).toMatch(/mtsu\.scholarships\.ngwebsolutions\.com/)
    expect(d.detail).toMatch(/PipelineMT/)
    expect(d.payload).toMatchObject({ portal_host: mtsu.portal_host, blocker_kind: 'login' })
    expect(searched).toBe(0)
  })

  it('an ordinary funder (no own-institution portal) still gets the rescue search', async () => {
    let searched = 0
    const ctx = {
      taskId: 't2', profileId: 'p1', portalUrl: 'https://funder.org/about',
      opportunity: { id: 'o2', title: 'Widget Scholarship', sponsor: 'Widget Foundation' },
      classification: { automation_type: 'portal', resolved_url: 'https://funder.org/about', own_institution_portal: null },
      _urlRescueDeps: { searchWebImpl: async () => { searched += 1; return [] }, checkUrlImpl: async () => ({ status: 'ok' }) },
    }
    const d = await resolveUnknownMethod(null, ctx, { kind: 'no_application_form', url: 'https://funder.org/about' })
    expect(searched).toBeGreaterThan(0)
    expect(d.strategy).not.toBe('own_portal_login_not_reached')
  })
})
