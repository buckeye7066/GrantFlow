/**
 * yanaContactEnrichment.js
 *
 * Closes the contact gap for outbound prospects. Discovery sources (e.g.
 * ProPublica 990) yield a nonprofit's IDENTITY but not a contact channel. This
 * module finds the org's homepage + a contact email so a prospect can graduate
 * from `needs_enrichment` to a `qualified` lead John can actually reach.
 *
 * Live web access is OFF by default and dependency-injected, exactly like
 * Robert (robertSourceDiscovery). The enricher takes:
 *   - searchProvider({ query }) => [{ url, title, snippet }]   (find homepage)
 *   - fetcher(url)             => string (HTML)                (read homepage)
 * With neither configured (and/or YANA_ALLOW_LIVE_WEB off) enrichment is an
 * honest NOOP: prospects stay `needs_enrichment` with a clear reason, never a
 * fabricated contact. An operator wires a real provider (key) to activate it.
 */

import { createLogger } from '../../utils/logger.js'
import { homepageNameScore, isExcludedEmail, isExcludedUrl, isPlausibleHomepage } from './prospectExclusions.js'
import { enrichOrgContact } from '../shared/orgContactEnrichment.js'

const log = createLogger('yanaContactEnrichment')

export function readEnvBool(env, key, fallback) {
  const raw = env?.[key]
  if (raw === null || raw === undefined || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

// Emails we never treat as a real org contact channel.
const JUNK_EMAIL_RE = /(example\.(com|org)|sentry\.io|\.png|\.jpg|\.gif|@2x|wixpress\.com|godaddy|domain|hostmaster|abuse@|postmaster@|no-?reply)/i
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

/** Extract candidate contact emails from page HTML. Prefers mailto: links. */
export function extractEmailsFromHtml(html) {
  if (!html || typeof html !== 'string') return []
  const found = new Set()
  const mailto = html.matchAll(/mailto:([^"'?>\s]+)/gi)
  for (const m of mailto) {
    const e = String(m[1]).trim().toLowerCase()
    if (e && !JUNK_EMAIL_RE.test(e)) found.add(e)
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    const e = String(m[0]).trim().toLowerCase()
    if (e && !JUNK_EMAIL_RE.test(e)) found.add(e)
  }
  // Prefer info@/contact@/hello@ style mailboxes.
  return Array.from(found).sort((a, b) => {
    const score = (x) => (/^(info|contact|hello|outreach|grants|development|admin)@/.test(x) ? 0 : 1)
    return score(a) - score(b)
  })
}

/**
 * Strip a homepage's HTML down to a short, clean text excerpt John's AI composer
 * can use to speak to the org's actual mission/accomplishments. Drops scripts,
 * styles, and tags; collapses whitespace; caps length.
 */
export function htmlToText(html, maxChars = 1200) {
  if (!html || typeof html !== 'string') return null
  // Decode entities BEFORE stripping tags: decoding after strip lets inert
  // encoded text ("&lt;script&gt;") reappear as a live tag the strip step
  // already ran past (js/double-escaping + js/bad-tag-filter).
  const text = html
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return null
  return text.slice(0, maxChars)
}

/** Heuristic: is this search result the org's own homepage (not a directory)? */
function looksLikeOfficialSite(url) {
  if (!/^https?:\/\//i.test(url)) return false
  return !/(propublica\.org|guidestar|charitynavigator|linkedin\.com|facebook\.com|twitter\.com|x\.com|instagram\.com|wikipedia\.org|\.gov\/|idealist\.org|cause\w*\.com|\/search\?)/i.test(url)
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.searchProvider] async ({ query }) => [{ url, title, snippet }]
 * @param {Function} [deps.fetcher]        async (url) => string (HTML)
 * @param {object}   [deps.env]            defaults to process.env
 */
export function makeContactEnricher(deps = {}) {
  const env = deps.env || process.env
  const allowLiveWeb = readEnvBool(env, 'YANA_ALLOW_LIVE_WEB', false)
  const searchProvider = typeof deps.searchProvider === 'function' ? deps.searchProvider : null
  const fetcher = typeof deps.fetcher === 'function' ? deps.fetcher : null
  // Enrichment is live only when the operator opted in AND a provider is wired.
  const enabled = Boolean(allowLiveWeb && searchProvider)

  return {
    enabled,
    /**
     * @returns {Promise<{ ok: boolean, website_url?: string, email?: string, reason?: string }>}
     */
    async enrich(prospect) {
      if (!allowLiveWeb) return { ok: false, reason: 'live_web_disabled' }
      if (!searchProvider) return { ok: false, reason: 'no_search_provider' }
      const name = prospect?.organization_name
      if (!name) return { ok: false, reason: 'no_name' }

      const query = [name, prospect.city, prospect.state, 'official site'].filter(Boolean).join(' ')
      let results
      try {
        results = await searchProvider({ query })
      } catch (err) {
        log.warn(`enrich search failed for "${name}": ${err?.message || err}`)
        return { ok: false, reason: 'search_failed' }
      }

      // Candidate homepages: real-looking, not a directory, not an excluded
      // competitor/aggregator (e.g. the org's Instrumentl listing). Keep each
      // result's TITLE — it's what lets a legitimate abbreviated domain
      // (upenn.edu titled "University of Pennsylvania") prove itself.
      const candidates = (results || [])
        .map((r) => ({ url: String(r?.url || '').trim(), title: String(r?.title || '') }))
        .filter((c) => c.url && looksLikeOfficialSite(c.url) && !isExcludedUrl(c.url))
      if (candidates.length === 0) return { ok: false, reason: 'no_homepage_found' }
      candidates.sort((a, b) => homepageNameScore(b.url, name) - homepageNameScore(a.url, name))

      // REQUIRE a plausible match, don't merely prefer one. Sorting alone has no
      // floor: when nothing matched the org, candidates[0] was still accepted and
      // its email scraped, so unrelated sites' addresses were attached to real
      // orgs (ten universities sharing helpdesk@franklin.edu; a newspaper's
      // address on fourteen nonprofits). An unenriched lead waits harmlessly at
      // needs_enrichment; a lead carrying a stranger's address makes John draft
      // outreach to the wrong organization.
      const match = candidates.find((c) => isPlausibleHomepage(c, name))
      if (!match) {
        log.info(`enrich: no plausible homepage for "${name}" (best: ${candidates[0].url}) — leaving unenriched`)
        return { ok: false, reason: 'no_plausible_homepage' }
      }
      const homepage = match.url

      let email = null
      let excerpt = null
      // Evidence: the exact public page the email was scraped from. NEVER a
      // fabricated address — only what the org itself publishes.
      let emailSourceUrl = null
      if (fetcher) {
        try {
          const html = await fetcher(homepage)
          const found = extractEmailsFromHtml(html).find((e) => !isExcludedEmail(e)) || null
          email = found
          if (found) emailSourceUrl = homepage
          excerpt = htmlToText(html)
        } catch (err) {
          log.warn(`enrich fetch failed for ${homepage}: ${err?.message || err}`)
        }

        // Most orgs (nonprofits, FQHCs, clinics) expose only a phone number and a
        // "Contact Us" LINK on their homepage — the email lives one click deep on
        // /contact, /about, etc. If the homepage yielded no email, probe those
        // standard contact pages on the SAME site and scrape them too. This reuses
        // the tested multi-page crawler (shared/orgContactEnrichment) so we stay
        // same-domain and never grab a third party's address. Without this step the
        // pipeline stalls at `no_contact_source` and no leads reach John.
        if (!email) {
          try {
            const fetchImpl = async (url) => {
              try { const h = await fetcher(url); return { ok: !!h, text: h || '' } }
              catch { return { ok: false, text: '' } }
            }
            const deep = await enrichOrgContact({ website: homepage }, { fetchImpl, delayMs: 0 })
            const deepEmail = deep?.email && !isExcludedEmail(deep.email) ? deep.email : null
            if (deepEmail) {
              email = deepEmail
              emailSourceUrl = deep.email_source_url || deep.source_url || homepage
            }
          } catch (err) {
            log.warn(`enrich contact-page probe failed for ${homepage}: ${err?.message || err}`)
          }
        }
      }
      return { ok: true, website_url: homepage, email, email_source_url: email ? emailSourceUrl : null, excerpt }
    },
  }
}

// A default enricher resolved from env. No concrete search provider ships in
// the repo (live web is operator-supplied), so this is an honest NOOP until one
// is injected. Boot/wiring can replace it via setDefaultContactEnricher().
let defaultEnricher = makeContactEnricher()
export function getDefaultContactEnricher() { return defaultEnricher }
export function setDefaultContactEnricher(enricher) {
  if (enricher && typeof enricher.enrich === 'function') defaultEnricher = enricher
}
