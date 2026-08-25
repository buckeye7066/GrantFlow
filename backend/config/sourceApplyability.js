/**
 * sourceApplyability.js — classify a funding source by whether a person can
 * actually APPLY to it, and how.
 *
 * WHY THIS EXISTS (2026-08-23). A batch of 13 Hamilton e2e runs produced ONE
 * completed application, because most profiles' pipeline sources are INFO /
 * BENEFIT pages — LIHEAP, SSDI, Medicaid, a grants.gov search-detail page —
 * with NO application surface, not fillable forms. Hamilton can only e2e a
 * source that has a real application PATH. Nothing classified a source by its
 * APPLYABILITY, so the pipeline filled with info pages and Hamilton had nothing
 * to submit. Measured read-only on prod 2026-08-23: of 381 active apply-ready
 * pipeline rows, 84 are `benefit` kind, 40 are directory/referral pointers, 35
 * are ssa.gov, 13 medicaid.gov, 10 studentaid.gov, 54 grants.gov, 15 sam.gov —
 * i.e. the pipeline is dominated by pages a person cannot fill and submit.
 *
 * THE TAXONOMY mirrors how the competition surfaces this (researched 2026-08-23,
 * WebSearch): Bold.org / Going Merry show "Apply now" only on a real
 * application vs "Learn more" on an info page; Instrumentl flags an
 * application-type and a deadline; Scholarships.com puts an "apply" link only on
 * a fillable award. The through-line is: an "apply" surface is a fillable form
 * or a packet you can send — everything else is "learn more".
 *
 *   TIER            isApplyable  meaning
 *   ------------    -----------  --------------------------------------------
 *   online_form     true         a fillable web form Hamilton can auto-submit
 *                                (a scholarship form, a U.S. Bank web form)
 *   mail_or_pdf     true         a downloadable/print packet mailed/emailed/
 *                                faxed — Hamilton assembles the packet
 *   account_portal  false        needs the PERSON to have/create a login on a
 *                                benefit portal (SSA / Medicaid / studentaid.gov
 *                                / a state benefit portal). Not cold-submittable.
 *   info_only       false        a page DESCRIBING a program with no application
 *                                surface — ssa.gov/disability, a grants.gov
 *                                search-detail page, a 211/findhelp locator, a
 *                                directory/referral pointer, an encyclopedia or
 *                                content-farm article.
 *
 * This DOES NOT hide info/account sources — a benefit program is still useful to
 * the person. It classifies + ranks so applyable sources LEAD and Hamilton
 * targets them (see listReadySources), and so the auto-submit gate never
 * cold-submits an account_portal / info_only row.
 *
 * ALIGNMENT: this REUSES the Hamilton orchestrator's `classifyFundingSource`
 * (`automation_type`: portal / pdf_docx / mail / fax / email / no_application /
 * auto_profile / unknown) rather than forking it — the applyability tier is a
 * projection of that automation_type plus host/kind signals that split a bare
 * "portal" into a real form (online_form) vs a benefit login (account_portal).
 */

import { classifyFundingSource } from '../services/hamilton/hamiltonAutomationClassifier.js'
import { isPointerKind } from './opportunityKindClasses.js'
import { classifyNonApplicationSurface } from './applicationSurfaceHosts.js'
import { isSearchEngineUrl } from './urlRules.js'

export const APPLYABILITY_TIERS = Object.freeze({
  ONLINE_FORM: 'online_form',
  MAIL_OR_PDF: 'mail_or_pdf',
  ACCOUNT_PORTAL: 'account_portal',
  INFO_ONLY: 'info_only',
})

/** The two tiers Hamilton can drive end to end. */
export const APPLYABLE_TIERS = Object.freeze([
  APPLYABILITY_TIERS.ONLINE_FORM,
  APPLYABILITY_TIERS.MAIL_OR_PDF,
])

/** True iff the tier is one Hamilton can apply/submit against. */
export function tierIsApplyable(tier) {
  return APPLYABLE_TIERS.includes(String(tier || '').trim().toLowerCase())
}

/**
 * Hosts that are ACCOUNT PORTALS — a person must have/create a login on the
 * government/benefit portal before anything can be submitted. Hamilton cannot
 * cold-submit here; the actionable next step is the person signing in (which the
 * existing waiting_for_login flow already handles). Matched on the registrable
 * host with a left boundary so `ssa.gov` never matches `notssa.gov`.
 */
export const ACCOUNT_PORTAL_HOSTS = Object.freeze([
  'ssa.gov',
  'secure.ssa.gov',
  'medicaid.gov',
  'medicare.gov',
  'mymedicare.gov',
  'healthcare.gov',
  'cms.gov',
  'studentaid.gov',
  'fafsa.gov',
  'fafsa.ed.gov',
  'va.gov',
  'login.gov',
  'id.me',
  'my.gov',
  'connect.gov',
])

/**
 * Subdomain prefixes that, on a `.gov` host, mark a self-service BENEFIT PORTAL
 * (state SNAP/TANF/Medicaid eligibility portals: fabenefits.tn.gov, access
 * portals, mybenefits, selfservice, connect). A login-walled benefit portal is
 * an account_portal, never a cold-submit form.
 */
export const BENEFIT_PORTAL_SUBDOMAIN_RX = /^(?:my|mybenefits|benefits|access|connect|selfservice|self-service|portal|account|secure|apply|fabenefits|dss|dhs)\./i

/**
 * Hosts that are INFO / LISTING / LOCATOR surfaces — a page describing programs
 * or a finder, never itself an application form. grants.gov and sam.gov detail
 * pages are federal LISTINGS (submitting needs a separate SAM/Workspace
 * registration an individual profile does not have); 211/findhelp/benefits.gov
 * are FINDERS.
 */
export const INFO_ONLY_HOSTS = Object.freeze([
  'grants.gov',
  'sam.gov',
  'beta.sam.gov',
  'benefits.gov',
  'benefitscheckup.org',
  '211.org',
  'tn211.org',
  'findhelp.org',
  'auntbertha.com',
  'usa.gov',
  'usdirectloans.org',
  'federalregister.gov',
  'propublica.org',
  // Aggregators / program-listing hosts that read as "applyable" only because the
  // default tier is online_form (measured 2026-08-24 dominating the non-hub
  // profiles' pipelines): `thegrantportal.com` is a lead-gen grant DIRECTORY;
  // `aifsabroad.com` scholarship-anchor pages require enrolling in an AIFS
  // study-abroad PROGRAM (not a per-award public form) — they still surface, they
  // just never read as a cold auto-submittable form. `linkedin.com` is never an
  // application surface (a `/redir/redirect?url=` tracking wrapper is not a form).
  // These are true finders/wrappers, NOT real per-award funders (bold.org /
  // scholarships.com serve real award pages and are deliberately NOT here).
  'thegrantportal.com',
  'aifsabroad.com',
  'linkedin.com',
])

/**
 * Real fillable-form platforms: a hit here IS an online application form even
 * when the kind/mode is silent. Scholarship & grant SaaS the fleet actually
 * encounters (academicworks = the AcademicWorks scholarship portal; SmApply,
 * CommunityForce, Submittable tenants, Formstack, JotForm, Google Forms).
 */
export const ONLINE_FORM_HOSTS = Object.freeze([
  'academicworks.com',
  'smapply.io',
  'smapply.org',
  'communityforce.com',
  'formstack.com',
  'jotform.com',
  'wufoo.com',
  'surveymonkey.com',
  'submittable.com',
  'fluidreview.com',
  'awardspring.com',
  'scholarshipamerica.org',
])

function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function resolveUrl(source) {
  return firstNonEmpty(
    source?.application_url,
    source?.apply_url,
    source?.portal_url,
    source?.url,
    source?.source_url,
    source?.evidence_url,
  )
}

function hostOf(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  try { return new URL(url).hostname.toLowerCase() } catch { return null }
}

/** host === domain OR host ends with `.domain` (a real subdomain boundary). */
function hostMatches(host, domain) {
  if (!host) return false
  return host === domain || host.endsWith(`.${domain}`)
}

function hostInList(host, list) {
  return !!host && list.some((d) => hostMatches(host, d))
}

function isAccountPortalHost(host) {
  if (!host) return false
  if (hostInList(host, ACCOUNT_PORTAL_HOSTS)) return true
  // A benefit-portal subdomain on a .gov host (state eligibility portals).
  if (/\.gov$/i.test(host) && BENEFIT_PORTAL_SUBDOMAIN_RX.test(host)) return true
  return false
}

function tierResult(tier, reason) {
  return { tier, isApplyable: tierIsApplyable(tier), reason }
}

/**
 * Classify a funding source's APPLYABILITY.
 *
 * Pure — no IO. Accepts a plain source object (a grant row, a
 * funding_opportunities row, or a merged shape). Reads url/application_url/
 * apply_url/portal_url/source_url, `opportunity_kind`, `application_mode`, plus
 * the text fields `classifyFundingSource` already reads.
 *
 * @param {object} source
 * @returns {{ tier: 'online_form'|'mail_or_pdf'|'account_portal'|'info_only',
 *             isApplyable: boolean, reason: string }}
 */
export function classifyApplyability(source) {
  if (!source || typeof source !== 'object') {
    return tierResult(APPLYABILITY_TIERS.INFO_ONLY, 'info_only:no_source')
  }

  const url = resolveUrl(source)
  const host = hostOf(url)
  const kind = String(source?.opportunity_kind ?? '').trim().toLowerCase()

  // 1. A search-engine RESULTS page is never an application surface.
  if (url && (() => { try { return isSearchEngineUrl(url) } catch { return false } })()) {
    return tierResult(APPLYABILITY_TIERS.INFO_ONLY, 'info_only:search_engine_url')
  }

  // 2. Structurally-non-application surface (encyclopedia / content farm /
  //    editorial blog). Reuses the canonical detector.
  const nonApp = url ? classifyNonApplicationSurface(url) : null
  if (nonApp) {
    return tierResult(APPLYABILITY_TIERS.INFO_ONLY, `info_only:${nonApp.reason}`)
  }

  // 3. Account-portal host (SSA / Medicaid / studentaid.gov / VA / state
  //    benefit portal). Needs the PERSON to sign in — not cold-submittable.
  if (isAccountPortalHost(host)) {
    return tierResult(APPLYABILITY_TIERS.ACCOUNT_PORTAL, `account_portal:host:${host}`)
  }

  // 4. Info / listing / locator host (grants.gov & sam.gov detail pages,
  //    benefits.gov / 211 / findhelp finders).
  if (hostInList(host, INFO_ONLY_HOSTS)) {
    return tierResult(APPLYABILITY_TIERS.INFO_ONLY, `info_only:host:${host}`)
  }

  // 5. A real fillable-form platform — an online application even if kind/mode
  //    is silent.
  if (hostInList(host, ONLINE_FORM_HOSTS)) {
    return tierResult(APPLYABILITY_TIERS.ONLINE_FORM, `online_form:host:${host}`)
  }

  // 6. A POINTER kind (directory / referral / school_portal / past_award_intel)
  //    is a list of OTHER awards, never an application surface of its own.
  if (isPointerKind(kind)) {
    return tierResult(APPLYABILITY_TIERS.INFO_ONLY, `info_only:pointer_kind:${kind}`)
  }

  // 7. Reuse Hamilton's automation_type — do NOT fork the classifier.
  const auto = classifyFundingSource({ opportunity: source, grant: source })
  const automationType = String(auto?.automation_type ?? 'unknown').toLowerCase()

  switch (automationType) {
    case 'portal':
      // A real portal with a fillable form. Host account-portal/info checks
      // above already peeled off the benefit-login and listing cases.
      return tierResult(APPLYABILITY_TIERS.ONLINE_FORM, 'online_form:automation_type:portal')
    case 'pdf_docx':
    case 'mail':
    case 'fax':
    case 'email':
      // A packet Hamilton assembles and sends (download+mail, fax, or email).
      return tierResult(APPLYABILITY_TIERS.MAIL_OR_PDF, `mail_or_pdf:automation_type:${automationType}`)
    case 'auto_profile':
      // FAFSA-linkage / institutional / nomination-only / automatic-match: the
      // "application" is the person connecting a benefit account (studentaid.gov)
      // or an institutional determination — not a cold-submittable form.
      return auto?.fafsa_link
        ? tierResult(APPLYABILITY_TIERS.ACCOUNT_PORTAL, 'account_portal:automation_type:auto_profile_fafsa')
        : tierResult(APPLYABILITY_TIERS.INFO_ONLY, 'info_only:automation_type:auto_profile')
    case 'no_application':
      return tierResult(APPLYABILITY_TIERS.INFO_ONLY, 'info_only:automation_type:no_application')
    default:
      // 8. Last resort: a BENEFIT program with no other signal needs a login /
      //    in-person application → account_portal; anything else with no surface
      //    is info_only.
      if (kind === 'benefit') {
        return tierResult(APPLYABILITY_TIERS.ACCOUNT_PORTAL, 'account_portal:benefit_kind')
      }
      return tierResult(APPLYABILITY_TIERS.INFO_ONLY, 'info_only:automation_type:unknown')
  }
}

/** Convenience: just the tier string. */
export function applyabilityTierOf(source) {
  return classifyApplyability(source).tier
}

/** Convenience: just the boolean. */
export function isApplyableSource(source) {
  return classifyApplyability(source).isApplyable
}

/**
 * A RANK for ordering — lower sorts first. Applyable tiers lead (online_form
 * before mail_or_pdf), then account_portal, then info_only. Used as a
 * tie-breaker so an applyable source ranks above an info/account source of equal
 * relevance without hiding anything.
 */
export const TIER_RANK = Object.freeze({
  [APPLYABILITY_TIERS.ONLINE_FORM]: 0,
  [APPLYABILITY_TIERS.MAIL_OR_PDF]: 1,
  [APPLYABILITY_TIERS.ACCOUNT_PORTAL]: 2,
  [APPLYABILITY_TIERS.INFO_ONLY]: 3,
})

export function applyabilityRank(source) {
  const tier = applyabilityTierOf(source)
  return TIER_RANK[tier] ?? TIER_RANK[APPLYABILITY_TIERS.INFO_ONLY]
}

// ── Coarse SQL derived-read (queryable without a column) ─────────────────────
//
// The JS classifier above is the AUTHORITY (it reads text + the shared Hamilton
// classifier). This SQL is a deliberately coarser projection over what a single
// row cheaply exposes — the resolved URL host + `opportunity_kind` — so a
// coverage query can bucket rows in the database without materialising a column.
// Dialect-agnostic: LOWER(...) LIKE only (no `~*`, which SQLite lacks). It can
// over/under-count vs the JS classifier at the margins; for a per-profile
// coverage floor that is acceptable and documented.

function likeAny(col, domains) {
  // Match `//host` or `.host` boundaries within the URL string.
  const clauses = []
  for (const d of domains) {
    clauses.push(`LOWER(${col}) LIKE '%//${d}%'`)
    clauses.push(`LOWER(${col}) LIKE '%.${d}%'`)
  }
  return clauses.length ? `(${clauses.join(' OR ')})` : '(1=0)'
}

/**
 * SQL CASE expression yielding the applyability tier for a row.
 *
 * @param {string} urlCol   an expression resolving the row's application URL
 * @param {string} kindCol  the `opportunity_kind` column expression
 */
export function applyabilityTierSql(urlCol = 'application_url', kindCol = 'opportunity_kind') {
  const k = `LOWER(COALESCE(${kindCol}, ''))`
  const pointerList = ['directory', 'referral', 'school_portal', 'past_award_intel']
  const pointerIn = pointerList.map((p) => `'${p}'`).join(', ')
  return (
    `CASE
      WHEN ${urlCol} IS NULL OR ${urlCol} NOT LIKE 'http%' THEN
        CASE WHEN ${k} = 'benefit' THEN 'account_portal' ELSE 'info_only' END
      WHEN ${likeAny(urlCol, ACCOUNT_PORTAL_HOSTS)} THEN 'account_portal'
      WHEN ${likeAny(urlCol, INFO_ONLY_HOSTS)} THEN 'info_only'
      WHEN ${likeAny(urlCol, ONLINE_FORM_HOSTS)} THEN 'online_form'
      WHEN ${k} IN (${pointerIn}) THEN 'info_only'
      WHEN ${k} = 'benefit' THEN 'account_portal'
      ELSE 'online_form'
    END`
  )
}

/** SQL boolean predicate: is this row applyable (online_form / mail_or_pdf)? */
export function applyableSql(urlCol = 'application_url', kindCol = 'opportunity_kind') {
  return `(${applyabilityTierSql(urlCol, kindCol)}) IN ('online_form', 'mail_or_pdf')`
}

export default {
  APPLYABILITY_TIERS,
  APPLYABLE_TIERS,
  ACCOUNT_PORTAL_HOSTS,
  INFO_ONLY_HOSTS,
  ONLINE_FORM_HOSTS,
  BENEFIT_PORTAL_SUBDOMAIN_RX,
  TIER_RANK,
  tierIsApplyable,
  classifyApplyability,
  applyabilityTierOf,
  isApplyableSource,
  applyabilityRank,
  applyabilityTierSql,
  applyableSql,
}
