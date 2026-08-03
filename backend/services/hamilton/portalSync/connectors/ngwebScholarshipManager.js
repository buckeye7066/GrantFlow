/**
 * portalSync/connectors/ngwebScholarshipManager.js
 *
 * REAL connector for NGWeb Solutions "Scholarship Manager" (ScholarX) — the
 * multi-tenant school scholarship portal platform at
 * `<school>.scholarships.ngwebsolutions.com`. Known tenants in this product's
 * orbit: `mtsu.scholarships.ngwebsolutions.com` (MTSU) and
 * `clevelandstatecc.scholarships.ngwebsolutions.com` (Cleveland State CC —
 * already in the LISTING_PAGES amount registry).
 *
 * WHY THIS EXISTS: the first live MTSU-tenant sync (2026-08-02, run 183195a2)
 * signed in fine and honestly reported "no structured data connector for this
 * portal yet" — 0 fields, 0 awards. This platform is where a student's own
 * school posts the scholarships they are being CONSIDERED for and the awards
 * they RECEIVE, so it earns a dedicated connector.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW THIS PLATFORM WORKS (verified live 2026-08-02 with a real signed-in
 * session on the MTSU tenant — every load-bearing phrase below is quoted from
 * those pages, not guessed):
 *   - Students CANNOT apply to individual scholarships. They complete the
 *     school's "General Scholarship Application" (plus conditional follow-on
 *     applications), and the PORTAL matches them ("Scholarship Matching is
 *     only ran on Mondays and Thursdays").
 *   - "My Opportunities" lists the scholarships the student is being
 *     considered for ("Qualified Opportunities N").
 *   - "My Awards" / Award Information posts actual awards after committee
 *     review.
 * So the read surfaces are: application status, qualified opportunities, and
 * awards — and an empty list mid-cycle is a REAL state, not a read failure.
 *
 * EXTRACTION STRATEGY (same rule as studentaid.js): navigate known
 * authenticated surfaces, classify each landing by its DESTINATION (a redirect
 * to the public CMS landing or a sign-in URL is authoritative sign-out proof;
 * page content never is), derive deterministic quote-anchored facts, and let
 * the shared fabrication-guarded LLM extractor read award/opportunity items.
 * Every stage pattern is USER-RECORD phrasing — a CTA telling the student to
 * DO a thing is evidence they have NOT done it.
 */

import { normalizeHost } from '../../hamiltonCredentialSessionService.js'
import { extractPortalDataWithLLM } from '../llmPageExtract.js'

export const id = 'ngweb_scholarship_manager'
export const label = 'School scholarship portal (Scholarship Manager)'
// Any tenant of the platform: <school>.scholarships.ngwebsolutions.com.
export const hostMatch = /(^|\.)scholarships\.ngwebsolutions\.com$/i

// Tenants authenticate through the school's own SSO (MTSU: PipelineMT →
// Microsoft; CSCC: its own IdP). A saved username/password can never drive
// this headlessly — only a captured session can.
export const requiresSession = true

// Mid-cycle, the honest terminal state is partially_synced: the platform's
// own matching runs twice a week and awards post after committee review, so
// this connector deliberately never certifies a terminal `merged`.
export const supportsFullMerge = false
export const requiredReadDomains = []

// The authenticated ScholarX surfaces (paths are tenant-relative; verified on
// the MTSU tenant 2026-08-02).
const NAV_PATHS = Object.freeze([
  { path: '/ScholarX_StudentLanding.aspx', name: 'landing' },
  { path: '/ScholarX_StudentPortal.aspx?bypass=1', name: 'applications' },
  { path: '/Applicants/MyOpportunities', name: 'opportunities' },
  { path: '/scholarx_studentaward.aspx', name: 'awards' },
])

// ── Landing classification — destination-based, the studentaid rule ─────────
// Signed-out signature VERIFIED LIVE: a private request (e.g.
// /Applicants/MyOpportunities) is answered with the public CMS landing
// /CMXAdmin/Cmx_Content.aspx?cpId=<n>. That page has plenty of text and no
// "please sign in" sentence, so content heuristics read it as authenticated —
// only the URL tells the truth.
const PUBLIC_CMS_RE = /\/cmxadmin\/cmx_content\.aspx/i
const SIGNIN_URL_RE = /\/(account\/login|login|signin|sign-in|auth|chameleonsms\/chm_logout)/i

export function classifyLanding(requested, landed) {
  if (!landed) return 'signed_out'
  let a
  let b
  try {
    a = new URL(requested)
    b = new URL(landed)
  } catch {
    return String(requested) === String(landed) ? 'served' : 'signed_out'
  }
  if (a.origin !== b.origin) return 'foreign'
  if (SIGNIN_URL_RE.test(b.pathname)) return 'signed_out'
  // A private request answered with the public CMS landing is the silent
  // bounce — but a DIRECT request for that CMS page is just the home page.
  if (PUBLIC_CMS_RE.test(b.pathname) && !PUBLIC_CMS_RE.test(a.pathname)) return 'signed_out'
  return 'served'
}

// ── Access classification ────────────────────────────────────────────────────
// The strongest in-account proof this platform renders: the signed-in header
// is "<Student Name> | Logout" with "Session expires in NN minutes." — the
// public pages carry neither. (Verified on every authenticated page read.)
const SIGNED_IN_HEADER_RE = /\|\s*Logout\b/i
const SESSION_TIMER_RE = /\bsession expires in\s+\d+\s+minutes?\b/i
const SIGNIN_WALL_RE = /\b(please (sign|log) in|you must (sign|log) in|log in to (your|the) (account|portal)|use your .{0,40}(username|credentials) .{0,20}to log in)\b/i
const BLOCKED_RE = /\b(access denied|reference #[0-9a-f.]+|unusual activity|request (was )?blocked|forbidden)\b/i

export function classifyAccess({ url = '', title = '', text = '' } = {}) {
  const hay = `${title}\n${text}`
  if (BLOCKED_RE.test(hay)) return 'blocked'
  if (SIGNED_IN_HEADER_RE.test(String(text)) || SESSION_TIMER_RE.test(String(text))) return 'authenticated'
  if (SIGNIN_WALL_RE.test(hay)) return 'signin_wall'
  if (SIGNIN_URL_RE.test(String(url))) return 'signin_wall'
  return 'unknown'
}

// ── Deterministic, quote-anchored facts ──────────────────────────────────────
// General-application status. USER-RECORD phrasing only:
//   - "Thank you for your submission of the <school> Scholarship
//     Application(s)." (the Award Information page, VERIFIED) → submitted.
//   - "Sorry, currently there are no applications available." (My
//     Applications, VERIFIED) → no application is currently open for them.
// The landing page's "Step 1: Complete the General Scholarship Application"
// is CTA copy and deliberately matches nothing here.
const APPLICATION_SUBMITTED_RE = /\bthank you for your submission of the\b[^.]{0,120}\bscholarship application/i
const NO_OPEN_APPLICATIONS_RE = /\b(sorry,? )?currently,? there are no applications available\b/i

export function deriveApplicationStatus(text) {
  const hay = String(text || '')
  const submitted = hay.match(APPLICATION_SUBMITTED_RE)
  if (submitted) return { status: 'submitted', evidence: String(submitted[0]).trim().slice(0, 200) }
  const none = hay.match(NO_OPEN_APPLICATIONS_RE)
  if (none) return { status: 'no_open_applications', evidence: String(none[0]).trim().slice(0, 200) }
  return null
}

// "Qualified Opportunities N" — the portal's own eligibility verdict. A count
// of 0 with "No Opportunities Found" is a REAL answer (matching runs Mon/Thu),
// never a read failure.
const QUALIFIED_COUNT_RE = /\bqualified opportunities\b[^0-9]{0,10}(\d{1,4})\b/i
const NO_OPPORTUNITIES_RE = /\bno opportunities found\b/i

export function deriveQualifiedOpportunities(text) {
  const hay = String(text || '')
  const m = hay.match(QUALIFIED_COUNT_RE)
  if (m) {
    const count = Number(m[1])
    if (Number.isFinite(count)) return { count, evidence: String(m[0]).trim().slice(0, 120) }
  }
  if (NO_OPPORTUNITIES_RE.test(hay)) return { count: 0, evidence: 'No Opportunities Found' }
  return null
}

/** "mtsu.scholarships.ngwebsolutions.com" → "mtsu" (the school tenant slug). */
export function tenantSlug(host) {
  const h = normalizeHost(host)
  if (!h || !hostMatch.test(h)) return null
  const first = h.split('.')[0]
  return first && first !== 'scholarships' ? first : null
}

// ScholarX is classic ASP.NET WebForms with some client rendering; a settled
// page is small (a few hundred chars). Poll until the text stops growing.
const SETTLE_POLLS = 6
const SETTLE_INTERVAL_MS = 700

async function gotoQuiet(page, url, log) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    let last = -1
    for (let i = 0; i < SETTLE_POLLS; i++) {
      const len = await page.evaluate(() => (document.body?.innerText || '').length).catch(() => 0)
      if (len > 0 && len === last) break
      last = len
      await page.waitForTimeout?.(SETTLE_INTERVAL_MS)
    }
    log?.(`navigated to ${url}`)
    return true
  } catch (err) {
    log?.(`navigation failed: ${url}`, { error: err?.message })
    return false
  }
}

async function readText(page) {
  try {
    const snap = await page.evaluate(() => ({ text: document.body?.innerText || '', title: document.title || '' }))
    if (typeof snap === 'string') return { text: snap, title: '' }
    return { text: String(snap?.text || ''), title: String(snap?.title || '') }
  } catch {
    return { text: '', title: '' }
  }
}

function safeUrl(page) {
  try { return page.url() } catch { return null }
}

/**
 * READ: application status, the portal's own qualified-opportunity list, and
 * any posted awards. Qualified opportunities and awards both ride `awards[]`
 * (they land as profile-scoped funding_opportunities via the school-portal
 * import path — a scholarship the school itself says this student is in
 * consideration for IS a real opportunity for them).
 */
export async function read(page, ctx = {}) {
  const log = ctx.log || (() => {})
  const host = normalizeHost(ctx.portalHost) || null
  const base = host ? `https://${host}` : null
  const fields = []
  const awards = []
  const notFound = []
  const raw = { pages: [], llm: null, derived: {} }

  if (!base) {
    return {
      fields, awards, notFound: [{ kind: 'nav', name: 'portal', reason: 'no portal host supplied to the connector' }],
      raw, access: 'unknown', domains: {},
    }
  }

  // 1) Gather text from the authenticated surfaces, recording per-page access.
  //    `pages` carries url/landed/title/chars/access only — never page text.
  let corpus = ''
  const pageTexts = {}
  for (const nav of NAV_PATHS) {
    const url = `${base}${nav.path}`
    const ok = await gotoQuiet(page, url, log)
    if (!ok) continue
    const snap = await readText(page)
    const landed = safeUrl(page) || url
    const landing = classifyLanding(url, landed)
    const access = landing !== 'served'
      ? 'signin_wall'
      : classifyAccess({ url: landed, title: snap.title, text: snap.text })
    raw.pages.push({ url, landed, title: snap.title, chars: snap.text.length, access, landing })
    if (access !== 'authenticated') continue
    corpus += `\n\n### ${url}\n${snap.text}`
    pageTexts[nav.name] = snap.text
  }

  const seen = raw.pages.map((p) => p.access)
  const accessState = seen.includes('authenticated') ? 'authenticated'
    : seen.includes('blocked') ? 'blocked'
      : seen.includes('signin_wall') ? 'signin_wall'
        : 'unknown'
  raw.access = accessState

  if (!corpus.trim()) {
    const reason = accessState === 'signin_wall'
      ? 'NOT SIGNED IN: the portal answered private pages with its public landing or a sign-in URL. The saved session is expired or was not accepted — capture a fresh one with a watched login. (This is NOT evidence about the student\'s scholarships.)'
      : accessState === 'blocked'
        ? 'BLOCKED: the portal refused this datacenter browser. Nothing about the student\'s scholarships can be concluded from this run.'
        : 'no readable text on any portal page'
    notFound.push({ kind: 'status', name: 'scholarship_manager', reason, access: accessState })
    return { fields, awards, notFound, raw, access: accessState, domains: {} }
  }

  // 2) Deterministic derivations, each anchored to a verbatim quote.
  const appStatus = deriveApplicationStatus(corpus)
  const qualified = deriveQualifiedOpportunities(pageTexts.opportunities || corpus)
  raw.derived = { applicationStatus: appStatus, qualifiedOpportunities: qualified }

  if (appStatus) {
    log(`ngweb: general application status "${appStatus.status}" evidenced by "${appStatus.evidence}"`)
  } else {
    notFound.push({ kind: 'status', name: 'general_application', reason: 'no user-record application-status phrase found on the pages read (status left unknown, never defaulted)' })
  }

  if (qualified) {
    log(`ngweb: portal reports ${qualified.count} qualified opportunit${qualified.count === 1 ? 'y' : 'ies'}`)
    if (qualified.count === 0) {
      notFound.push({
        kind: 'opportunities',
        name: 'qualified_opportunities',
        reason: `the portal itself currently lists 0 qualified opportunities ("${qualified.evidence}") — its matching runs only on Mondays and Thursdays, so this is the portal's real answer today, not a read failure`,
      })
    }
  } else {
    notFound.push({ kind: 'opportunities', name: 'qualified_opportunities', reason: 'could not read the Qualified Opportunities count from the My Opportunities page' })
  }

  // 3) Item extraction (opportunity/award rows) via the shared
  //    fabrication-guarded extractor. It refuses listing/marketing entries
  //    without user-specific evidence, which is exactly right here: the public
  //    557-item Scholarships Search catalog must never be read as HER awards.
  const llm = await extractPortalDataWithLLM(page, {
    log,
    navCandidates: NAV_PATHS.map((n) => `${base}${n.path}`),
  })
  raw.llm = llm.raw
  const rejected = Array.isArray(llm.rejected) ? llm.rejected : []
  for (const a of llm.awards || []) {
    awards.push({
      title: a.title,
      amount: a.amount,
      amountDisplay: a.amountDisplay || null,
      status: a.status || null,
      sponsor: a.sponsor || null,
      sourceUrl: a.sourceUrl || safeUrl(page),
    })
  }
  for (const f of llm.fields || []) {
    if (fields.some((x) => x.sectionKey === f.sectionKey && x.field === f.field)) continue
    fields.push(f)
  }
  for (const reason of llm.notFound || []) notFound.push({ kind: 'llm', name: 'extraction', reason })

  const domains = {
    identity: { complete: accessState === 'authenticated' },
    applications: { complete: Boolean(appStatus), evidence: appStatus?.evidence || null },
    opportunities: { complete: Boolean(qualified), count: qualified?.count ?? null },
    awards: { complete: awards.length > 0, awards: awards.length },
  }

  log(`ngweb read complete (${accessState}): ${fields.length} fields, ${awards.length} awards (${rejected.length} rejected), ${notFound.length} notFound`)
  return {
    fields, awards, notFound, rejected, raw, access: accessState, domains,
    // First-class umbrella-application fact: the orchestrator reflects a
    // verified submission onto every governed grant/task (owner rule
    // 2026-08-02 — generalApplicationCoverage.js). Never dug out of `raw`.
    generalApplication: appStatus,
    tenant: tenantSlug(host),
  }
}

/**
 * WRITE: report the household's accepted OUTSIDE awards to the school, via the
 * shared global reporter (fills, never submits without explicit authorization).
 * Schools require outside-scholarship reporting, so this is the real
 * portal-ward direction for this platform. If the tenant exposes no reporting
 * form, the reporter's honest skip triggers the mail/fax packet fallback.
 *
 * Note what write is NOT here: this platform's own application flow ("you can
 * NOT apply individually to scholarships" — the portal's words) is the
 * student's to complete, and this connector never fills or submits it.
 */
export async function write(page, ctx = {}, data = {}) {
  const log = ctx.log || (() => {})
  const host = normalizeHost(ctx.portalHost) || null
  if (!host) {
    return { written: [], skipped: [{ target: 'outside_awards', reason: 'no portal host supplied to the connector' }] }
  }
  // Land on an authenticated surface first; prove we are signed in before
  // touching anything.
  const url = `https://${host}/ScholarX_StudentLanding.aspx`
  const ok = await gotoQuiet(page, url, log)
  const snap = ok ? await readText(page) : { text: '', title: '' }
  const landed = safeUrl(page) || url
  if (!ok || classifyLanding(url, landed) !== 'served' || classifyAccess({ url: landed, ...snap }) !== 'authenticated') {
    return {
      written: [],
      skipped: [{ target: 'outside_awards', reason: 'not signed in: the portal did not serve an authenticated page, so nothing was filled' }],
    }
  }
  const { reportOutsideAwards } = await import('../outsideAwardReporter.js')
  const res = await reportOutsideAwards(page, {
    sources: Array.isArray(data?.fundingSources) ? data.fundingSources : [],
    allowSubmit: data?.allowSubmit === true,
    log,
  })
  return { written: res.written, skipped: res.skipped, submitted: res.submitted }
}

/**
 * Claim a credential by tenant host. Deliberately NO label-text claim: a
 * label like "MTSU Scholarships" must resolve by HOST to this connector (the
 * platform tenant), never by the word "MTSU" to the mtsu.edu connector — this
 * connector is registered ahead of mtsu in the registry for exactly that
 * reason.
 * @param {{ host?:string, username?:string, label?:string }} ctx
 */
export function matchesCredential({ host } = {}) {
  const h = normalizeHost(host)
  return !!h && hostMatch.test(h)
}

export function matchesHost(host) {
  const h = normalizeHost(host)
  return !!h && hostMatch.test(h)
}

/** @type {import('../types.js').PortalConnector} */
const connector = {
  id, label, hostMatch, requiresSession, supportsFullMerge, requiredReadDomains,
  matchesCredential, read, write,
}

export default connector
