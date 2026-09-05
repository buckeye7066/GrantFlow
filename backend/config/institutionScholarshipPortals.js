/**
 * institutionScholarshipPortals.js — WHERE A STUDENT'S OWN SCHOOL TAKES ITS
 * SCHOLARSHIP APPLICATION, and what login that portal needs.
 *
 * Owner order 2026-09-05: Hamilton must submit end to end. Live run that day
 * for a student COMMITTED to MTSU: four MTSU-sponsored scholarship rows point
 * at generic mtsu.edu pages (/scholarships, /applynow, /graduate/funding,
 * education.mtsu.edu/scholarships). From each, the engine followed
 * "Apply to MTSU" into the Slate ADMISSIONS portal (apply.mtsu.edu) and parked
 * at a Microsoft single sign-on wall — an admissions application for a student
 * who is already admitted, on a portal that does not take scholarship
 * applications at all. MTSU's scholarships are applied for ONCE, through the
 * NGWeb "Scholarship Manager" General Application at
 * mtsu.scholarships.ngwebsolutions.com, behind the student's PipelineMT login.
 *
 * This registry names that portal per institution. It is CURATED (the same
 * tenants `portalSync/generalApplicationCoverage.js` governs), never guessed
 * from a slug: a school that is not listed simply keeps the row's own URL.
 * The login hint names the vault kinds the profile owner must fill so the
 * login wall says exactly what is missing instead of "could not sign in".
 */
import { institutionDistinctiveTokens } from './profileInstitutions.js'

export const INSTITUTION_SCHOLARSHIP_PORTALS = Object.freeze([
  Object.freeze({
    institution: 'Middle Tennessee State University',
    aliases: ['MTSU'],
    domains: ['mtsu.edu'],
    platform: 'ngweb_scholarship_manager',
    portal_url: 'https://mtsu.scholarships.ngwebsolutions.com/',
    portal_host: 'mtsu.scholarships.ngwebsolutions.com',
    login_hint: 'this portal takes the student’s PipelineMT (MTSU) login — add it to the identity vault as University SSO username/password, or sign in once side-by-side',
    vault_kinds: ['sso_username', 'sso_password'],
    umbrella: 'One General Application covers every MTSU scholarship; students cannot apply to individual awards there.',
  }),
  Object.freeze({
    institution: 'Cleveland State Community College',
    aliases: ['CSCC', 'CLSCC'],
    domains: ['clevelandstatecc.edu'],
    platform: 'ngweb_scholarship_manager',
    portal_url: 'https://clevelandstatecc.scholarships.ngwebsolutions.com/',
    portal_host: 'clevelandstatecc.scholarships.ngwebsolutions.com',
    login_hint: 'this portal takes the student’s CougarNet (Cleveland State) login — add it to the identity vault as University SSO username/password, or sign in once side-by-side',
    vault_kinds: ['sso_username', 'sso_password'],
    umbrella: 'One General Application covers every Cleveland State scholarship.',
  }),
])

/** Hosts that ARE scholarship-application platforms; a row already there is never re-routed. */
export const SCHOLARSHIP_PLATFORM_HOST_RX = /(?:^|\.)(?:scholarships\.ngwebsolutions\.com|academicworks\.com|scholarshipuniverse\.com|blackbaudawardmanagement\.com|awardspring\.com|scholarsapply\.org|smarterselect\.com|submittable\.com)$/i

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

function sameInstitution(a, b) {
  const x = institutionDistinctiveTokens(a)
  const y = institutionDistinctiveTokens(b)
  if (x.size === 0 || y.size === 0 || x.size !== y.size) return false
  for (const t of x) if (!y.has(t)) return false
  return true
}

/** The registry entry for an institution name (or alias), or null. */
export function resolveInstitutionScholarshipPortal(institutionName) {
  const name = String(institutionName ?? '').trim()
  if (!name) return null
  const upper = name.toUpperCase()
  for (const entry of INSTITUTION_SCHOLARSHIP_PORTALS) {
    if (sameInstitution(entry.institution, name)) return entry
    if (entry.aliases.some((alias) => alias.toUpperCase() === upper)) return entry
  }
  return null
}

/** The registry entry whose portal host serves `url`, or null. */
export function institutionPortalForUrl(url) {
  const host = hostOf(url)
  if (!host) return null
  return INSTITUTION_SCHOLARSHIP_PORTALS.find((e) => host === e.portal_host || host.endsWith(`.${e.portal_host}`)) ?? null
}

/** True when `url` sits on one of the institution's own web domains. */
export function urlOnInstitutionDomain(url, entry) {
  const host = hostOf(url)
  if (!host || !entry) return false
  return entry.domains.some((d) => host === d || host.endsWith(`.${d}`))
}

/** True when `url` is already on a scholarship-application platform host. */
export function urlOnScholarshipPlatform(url) {
  const host = hostOf(url)
  return Boolean(host) && SCHOLARSHIP_PLATFORM_HOST_RX.test(host)
}

export default {
  INSTITUTION_SCHOLARSHIP_PORTALS,
  resolveInstitutionScholarshipPortal,
  institutionPortalForUrl,
  urlOnInstitutionDomain,
  urlOnScholarshipPlatform,
}
