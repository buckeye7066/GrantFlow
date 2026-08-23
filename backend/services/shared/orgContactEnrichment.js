/**
 * orgContactEnrichment.js — discover an organization's PUBLIC contact email.
 *
 * Many discovery sources (e.g. ProPublica) give an org's identity but no email,
 * so Yana's funnel can't qualify them (email is a required gate). This enriches
 * such an org by reading the contact email the org PUBLISHES on its OWN website
 * (its stated inbound-contact channel) — appropriate for B2B outreach to an
 * organization, and bounded so it never becomes a scraper:
 *
 *   - SAME DOMAIN ONLY — only the org's own site is fetched; a small fixed set
 *     of likely pages (home, /contact, /about). No following arbitrary links.
 *   - ROLE ADDRESSES PREFERRED — info@/contact@/grants@… over a named person's
 *     address; personal-looking and noreply/junk addresses are dropped.
 *   - POLITE — robots.txt is honored per page and a per-domain delay applies.
 *   - INJECTABLE — fetchImpl/robotsCheck/delay are injected so it is fully
 *     testable offline; never throws.
 */

const EMAIL_RX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const MAILTO_RX = /mailto:([^"'>\s?]+)/gi

// Local parts that signal a role/inbox address (good org contacts).
const ROLE_LOCALS = new Set([
  'info', 'contact', 'contactus', 'hello', 'admin', 'office', 'mail', 'inquiries',
  'inquiry', 'general', 'support', 'grants', 'development', 'foundation', 'giving',
  'donations', 'outreach', 'programs', 'main', 'team',
])
// Never use these.
const JUNK_LOCALS = new Set(['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster', 'abuse'])
// Web-infrastructure mailboxes: right domain but not an outreach contact. A weak
// fallback only — never a first choice (owner rule 2026-08-23). Kept distinct
// from JUNK_LOCALS (which are never usable) so pickBestOrgEmail can rank them last.
const WEAK_LOCALS = new Set([
  'webmaster', 'webadmin', 'web', 'website', 'sysadmin', 'hostmaster', 'root',
  'noc', 'it', 'ithelp', 'helpdesk', 'tech', 'techsupport', 'administrator',
  'domains', 'dns', 'hostperson',
])
// Domains that are obviously placeholders or third-party (not the org). The
// file/asset extensions catch a scrape that mistook a path or asset URL for an
// email domain — `u@penn.php`, `x@logo.png` — where the naive regex read the
// extension as a TLD.
const JUNK_DOMAIN_RX = /(example\.(com|org|net)|sentry\.|wixpress\.com|\.(png|jpe?g|gif|svg|webp|bmp|ico|css|js|mjs|php\d?|aspx?|jsp|cgi|s?html?|xml|json|md|txt|woff2?|ttf|eot|otf|pdf|zip|map)$)/i
// Likely pages that carry a contact address.
const DEFAULT_PATHS = ['', '/contact', '/contact-us', '/about', '/about-us', '/contact.html']

export function domainOf(websiteOrUrl) {
  const s = String(websiteOrUrl || '').trim()
  if (!s) return null
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try { return new URL(withScheme).host.toLowerCase().replace(/^www\./, '') } catch { return null }
}

function localPart(email) { return String(email).split('@')[0]?.toLowerCase() || '' }
function emailDomain(email) { return String(email).split('@')[1]?.toLowerCase().replace(/^www\./, '') || '' }

/** Extract candidate emails from HTML. Pure. */
export function extractContactEmails(html) {
  const text = String(html || '')
  const found = new Set()
  let m
  while ((m = MAILTO_RX.exec(text))) {
    const e = decodeURIComponent(m[1].split('?')[0]).trim().toLowerCase()
    if (e) found.add(e)
  }
  for (const e of text.match(EMAIL_RX) || []) found.add(e.trim().toLowerCase())
  return [...found].filter((e) => {
    if (JUNK_LOCALS.has(localPart(e))) return false
    if (JUNK_DOMAIN_RX.test(e)) return false
    if (e.length > 254) return false
    // Realistic shape: a >=2-char local and a real-looking TLD (2-24 letters).
    // Refuses the single-char / file-extension-TLD junk a naive scrape produces
    // (`u@penn.php` — `u` is 1 char AND `.php` is caught above).
    if (!/^[a-z0-9._%+-]{2,}@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return false
    if (emailDomain(e).split('.').some((label) => !label)) return false
    return true
  })
}

/**
 * Choose the best org contact email for an org whose OWN site is `domain`.
 *
 * When a `domain` is given the result is REQUIRED to be on that same domain —
 * a third-party address embedded in the org's page (a font vendor, an analytics
 * provider, the `info@indiantypefoundry.com`-scraped-off-a-school class) is
 * refused rather than returned as a last resort. A bare web-infra mailbox
 * (webmaster@/webadmin@) ranks BELOW a real role/person address and is only
 * chosen when nothing better shares the domain. Returns null if nothing usable.
 */
export function pickBestOrgEmail(emails, { domain = null } = {}) {
  const list = Array.isArray(emails) ? emails : []
  if (!list.length) return null
  const score = (e) => {
    let s = 0
    if (domain && emailDomain(e) === domain) s += 100 // strong same-domain preference
    if (ROLE_LOCALS.has(localPart(e))) s += 10
    if (WEAK_LOCALS.has(localPart(e))) s -= 50 // web-infra mailbox: last resort
    return s
  }
  // Returns the best available candidate (same-domain preferred, web-infra
  // demoted). Callers that must GUARANTEE the recipient belongs to the org
  // re-validate through prospectExclusions.chooseOutreachEmail (which applies
  // the whole-name plausibility bar); this function only ranks.
  return [...list].sort((a, b) => score(b) - score(a))[0]
}

// ── Phone extraction ────────────────────────────────────────────────────────
const TEL_RX = /tel:\+?([0-9.\-()\s]{7,})/gi
const PHONE_RX = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1)
  if (d.length !== 10) return null
  if (/^(\d)\1{9}$/.test(d)) return null // 0000000000 / 1111111111 etc
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
}

/** Extract normalized US phone numbers (tel: links first). Pure. */
export function extractPhones(html) {
  const text = String(html || '')
  const out = []
  const seen = new Set()
  const add = (raw) => { const p = normalizePhone(raw); if (p && !seen.has(p)) { seen.add(p); out.push(p) } }
  let m
  while ((m = TEL_RX.exec(text))) add(m[1])
  for (const raw of text.match(PHONE_RX) || []) add(raw)
  return out
}

// ── Contact name + title extraction (conservative — needs an explicit role) ──
const ROLE_TITLES = [
  'Executive Director', 'Development Director', 'Director of Development', 'Grants Manager',
  'Grant Manager', 'Program Director', 'Chief Executive Officer', 'Executive Officer',
  'President', 'CEO', 'Founder', 'Director', 'Coordinator', 'Manager', 'Administrator',
]
const NAME = "[A-Z][a-z]+(?:\\s+[A-Z][A-Za-z.'-]+){1,2}"
const TITLE_ALT = ROLE_TITLES.map((t) => t.replace(/ /g, '\\s+')).join('|')
const TITLE_THEN_NAME = new RegExp(`(${TITLE_ALT})\\s*[:\\-–]\\s*(${NAME})`)
const NAME_THEN_TITLE = new RegExp(`(${NAME})\\s*,\\s*(${TITLE_ALT})`)

function stripTags(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/gi, ' ').replace(/\s+/g, ' ').trim()
}

// Common words that greedily attach to the front of a captured name.
const NAME_STOPWORDS = new Set(['contact', 'reach', 'email', 'call', 'meet', 'our', 'the', 'welcome', 'about', 'please'])
function cleanName(raw) {
  let words = String(raw || '').trim().split(/\s+/)
  while (words.length > 2 && NAME_STOPWORDS.has(words[0].toLowerCase())) words = words.slice(1)
  return words.join(' ')
}

/** Best-effort {name, title} of an org contact person, or null. Pure. */
export function extractContactName(html) {
  const text = stripTags(html)
  let m = TITLE_THEN_NAME.exec(text)
  if (m) return { name: cleanName(m[2]), title: m[1].replace(/\s+/g, ' ').trim() }
  m = NAME_THEN_TITLE.exec(text)
  if (m) return { name: cleanName(m[1]), title: m[2].replace(/\s+/g, ' ').trim() }
  return null
}

const realDelay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t?.unref) t.unref() })

/**
 * Enrich one org with public contact details (email + phone + contact person)
 * by reading a small fixed set of its OWN pages. Returns whatever it found, or
 * null if nothing usable. Never throws.
 *
 * @returns {Promise<{email:string|null, phone:string|null, contact_name:string|null,
 *                    contact_title:string|null, source_url:string|null}|null>}
 */
export async function enrichOrgContact(org, {
  fetchImpl,
  robotsCheck = null,
  delay = realDelay,
  delayMs = 1000,
  userAgent = 'GrantFlow Crawler/1.0 (+contact: support@grantflow.app)',
  paths = DEFAULT_PATHS,
} = {}) {
  const domain = domainOf(org?.website || org?.website_url)
  if (!domain || typeof fetchImpl !== 'function') return null
  const origin = `https://${domain}`
  const robotsFetchText = async (u) => {
    const r = await fetchImpl(u, { responseType: 'text' })
    return { ok: r.ok === true, text: r.text || '' }
  }

  let email = null
  let phone = null
  let contact = null
  let sourceUrl = null
  // The exact page the EMAIL was found on (sourceUrl is "first page with any
  // contact signal", which a homepage phone number can claim first). Callers
  // persisting evidence for a scraped email should prefer this.
  let emailSourceUrl = null

  for (const path of paths) {
    if (email && phone && contact) break
    const url = `${origin}${path}`
    if (robotsCheck) {
      let verdict
      try { verdict = await robotsCheck(url, { fetchText: robotsFetchText, userAgent }) } catch { verdict = { allowed: true } }
      if (verdict && verdict.allowed === false) continue
    }
    let res
    try { res = await fetchImpl(url, { responseType: 'text' }) } catch { res = null }
    if (delayMs) await delay(delayMs)
    if (!res || res.ok !== true || !res.text) continue

    if (!email) { const e = pickBestOrgEmail(extractContactEmails(res.text), { domain }); if (e) { email = e; emailSourceUrl = url; sourceUrl = sourceUrl || url } }
    if (!phone) { const p = extractPhones(res.text)[0]; if (p) { phone = p; sourceUrl = sourceUrl || url } }
    if (!contact) { const c = extractContactName(res.text); if (c) { contact = c; sourceUrl = sourceUrl || url } }
  }

  if (!email && !phone && !contact) return null
  return {
    email,
    phone,
    contact_name: contact?.name || null,
    contact_title: contact?.title || null,
    source_url: sourceUrl,
    email_source_url: emailSourceUrl,
  }
}

/** Back-compat: email-only enrichment (wraps enrichOrgContact). */
export async function enrichOrgEmail(org, opts) {
  const r = await enrichOrgContact(org, opts)
  return r?.email ? { email: r.email, source_url: r.email_source_url || r.source_url } : null
}

export const __testing__ = { ROLE_LOCALS, JUNK_LOCALS, localPart, emailDomain }
