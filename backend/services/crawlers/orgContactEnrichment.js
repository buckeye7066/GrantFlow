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
// Domains that are obviously placeholders or third-party (not the org).
const JUNK_DOMAIN_RX = /(example\.(com|org|net)|sentry\.|wixpress\.com|\.png$|\.jpe?g$|\.gif$|\.svg$|\.webp$|\.css$|\.js$)/i
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
    return true
  })
}

/**
 * Choose the best org contact email: same-domain first, then role addresses,
 * then anything left. Returns null if nothing usable.
 */
export function pickBestOrgEmail(emails, { domain = null } = {}) {
  const list = Array.isArray(emails) ? emails : []
  if (!list.length) return null
  const score = (e) => {
    let s = 0
    if (domain && emailDomain(e) === domain) s += 100
    if (ROLE_LOCALS.has(localPart(e))) s += 10
    return s
  }
  return [...list].sort((a, b) => score(b) - score(a))[0]
}

const realDelay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t?.unref) t.unref() })

/**
 * Enrich one org with a public contact email by reading its own site.
 *
 * @returns {Promise<{email:string, source_url:string}|null>}
 */
export async function enrichOrgEmail(org, {
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

  for (const path of paths) {
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
    const best = pickBestOrgEmail(extractContactEmails(res.text), { domain })
    if (best) return { email: best, source_url: url }
  }
  return null
}

export const __testing__ = { ROLE_LOCALS, JUNK_LOCALS, localPart, emailDomain }
