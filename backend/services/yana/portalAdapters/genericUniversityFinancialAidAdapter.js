/**
 * genericUniversityFinancialAidAdapter.js
 *
 * Financial-aid / bursar / student-account portals are virtually
 * always behind institutional SSO and almost always require manual
 * intervention. Yana treats every page as needing supervised login
 * unless the URL clearly points at a public application form.
 */

import { basePortalBrowserAdapter } from './basePortalBrowserAdapter.js'

export const genericUniversityFinancialAidAdapter = Object.freeze({
  ...basePortalBrowserAdapter,
  name: 'generic_university_financial_aid',
  portalTypes: ['financial_aid', 'student_account', 'bursar', 'graduate_school'],

  canHandle(portalLink) {
    return ['financial_aid', 'student_account', 'bursar', 'graduate_school']
      .includes(portalLink?.portal_type)
  },

  async detectGate(page) {
    if (!page) return null
    const url = (await page.url?.()) || ''
    const looksLikeFafsaOrStudentLogin = /studentaid|fafsa|sso|cas|onestop|netid|self[-_]?service/i.test(url)
    if (looksLikeFafsaOrStudentLogin) {
      return { kind: 'login', reason: `Financial-aid URL "${url}" requires supervised student login — Yana never logs in for the student.` }
    }
    return basePortalBrowserAdapter.detectGate(page)
  },
})
