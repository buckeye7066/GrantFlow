/**
 * yana/prospectExclusions.js
 *
 * A single source of truth for "organizations / domains we must NOT treat as a
 * prospect or contact channel." Two failure modes this guards against:
 *
 *   1. Enrichment picking a grant-tech COMPETITOR or an aggregator/directory as
 *      an org's "homepage" (e.g. a nonprofit's Instrumentl listing), then
 *      scraping a contact email off it — so John drafts outreach to a competitor.
 *   2. A lead qualifying on a junk/social/infra email domain.
 *
 * Used by yanaContactEnrichment (reject bad homepages) and johnYanaBridge (drop
 * excluded leads before drafting — defense in depth). Extend at runtime with
 * YANA_EXCLUDED_DOMAINS (comma-separated).
 */

// Grant-tech competitors + aggregators/directories + social + job boards + infra
// mailboxes. These are never a GrantFlow PROSPECT and never an org's real site.
const DEFAULT_EXCLUDED_DOMAINS = Object.freeze([
  // Grant discovery / nonprofit-tech competitors & data aggregators
  'instrumentl.com', 'grantwatch.com', 'grantstation.com', 'candid.org', 'guidestar.org',
  'foundationcenter.org', 'submittable.com', 'goodgrants.com', 'grants.gov', 'sam.gov',
  'idealist.org', 'causeiq.com', 'charitynavigator.org', 'propublica.org', 'givebutter.com',
  'classy.org', 'donorbox.org', 'networkforgood.com', 'fluxx.io', 'blackbaud.com',
  'bloomerang.co', 'neoncrm.com', 'kindful.com', 'every.org', 'justgiving.com', 'gofundme.com',
  // Social / encyclopedias / directories / job boards
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com',
  'tiktok.com', 'pinterest.com', 'wikipedia.org', 'indeed.com', 'glassdoor.com',
  'ziprecruiter.com', 'crunchbase.com', 'bbb.org', 'yelp.com', 'mapquest.com', 'manta.com',
  // Builders' infra mailboxes / generic junk domains
  'wixpress.com', 'sentry.io', 'google.com', 'gstatic.com', 'cloudflare.com', 'godaddy.com',
  'domain.com', 'example.com', 'example.org', 'wordpress.com', 'squarespace.com',
])

function parseEnvList(name) {
  return String(process.env[name] || '')
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export function getExcludedDomains() {
  return new Set([...DEFAULT_EXCLUDED_DOMAINS, ...parseEnvList('YANA_EXCLUDED_DOMAINS')])
}

/** Pull a bare hostname from an email address or URL. */
export function domainOf(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  if (raw.includes('@')) return raw.split('@').pop() || null
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    return u.hostname.replace(/^www\./, '') || null
  } catch {
    return raw.replace(/^www\./, '').split('/')[0] || null
  }
}

/** True if a domain is the excluded one or a subdomain of it. */
export function isExcludedDomain(domain, excluded = getExcludedDomains()) {
  const d = String(domain || '').trim().toLowerCase().replace(/^www\./, '')
  if (!d) return false
  for (const ex of excluded) {
    if (d === ex || d.endsWith('.' + ex)) return true
  }
  return false
}

export function isExcludedEmail(email, excluded = getExcludedDomains()) {
  return isExcludedDomain(domainOf(email), excluded)
}

export function isExcludedUrl(url, excluded = getExcludedDomains()) {
  return isExcludedDomain(domainOf(url), excluded)
}

/** Significant lowercase tokens from an org name (drops stopwords). */
const NAME_STOPWORDS = new Set([
  'the', 'of', 'and', 'for', 'a', 'an', 'inc', 'foundation', 'fund', 'trust',
  'association', 'society', 'organization', 'org', 'nonprofit', 'corporation',
  'corp', 'group', 'center', 'centre', 'council', 'committee', 'services',
])
export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !NAME_STOPWORDS.has(t))
}

/**
 * Score how well a candidate homepage URL matches an org name (higher = better).
 * Rewards the hostname containing one of the org's significant name tokens, so
 * "knoxed.org" beats a random directory for "Knox Education Foundation".
 */
export function homepageNameScore(url, orgName) {
  const host = domainOf(url)
  if (!host) return 0
  const bare = host.split('.').slice(0, -1).join('') // drop TLD, join labels
  let score = 0
  for (const tok of nameTokens(orgName)) {
    if (bare.includes(tok)) score += Math.min(tok.length, 8)
  }
  return score
}

/**
 * Tokens that identify a CATEGORY of organization rather than a specific one.
 * They are kept in `nameTokens` (they carry real ranking signal) but must never
 * be sufficient ON THEIR OWN to conclude a site belongs to an org: "University
 * of Minnesota" and "Franklin University" share `university` while being
 * completely different institutions.
 */
const GENERIC_ORG_TOKENS = new Set([
  'university', 'universities', 'college', 'school', 'academy', 'institute',
  'hospital', 'medical', 'medicine', 'health', 'healthcare', 'clinic',
  'research', 'laboratory', 'laboratories', 'science', 'sciences',
  'children', 'childrens', 'community', 'regional', 'memorial', 'general',
  'national', 'american', 'america', 'usa', 'state', 'city', 'county',
  'church', 'ministries', 'ministry', 'department', 'district', 'board',
  'public', 'international', 'global', 'united', 'first', 'new',
])

/** Org-name tokens that actually identify THIS org (drops category words). */
export function distinctiveNameTokens(name) {
  const toks = nameTokens(name)
  const distinctive = toks.filter((t) => !GENERIC_ORG_TOKENS.has(t))
  // An org named entirely from category words (e.g. "Community Health Center")
  // has nothing distinctive; fall back rather than rejecting everything.
  return distinctive.length ? distinctive : toks
}

/**
 * Is `url` plausibly the official site OF `orgName`?
 *
 * The enricher used to SORT candidate homepages by homepageNameScore and then
 * take the top one unconditionally — a preference with no floor, so when NO
 * result matched the org it still accepted the best of a bad lot and scraped a
 * stranger's contact email. That is how ten different universities ended up
 * sharing `helpdesk@franklin.edu`, and a newspaper's address landed on fourteen
 * nonprofits. Getting NO email is recoverable (the lead waits at
 * needs_enrichment); emailing the WRONG organization is not.
 *
 * Requires at least one DISTINCTIVE org token to appear in the hostname or in
 * the search result's title. The title is what rescues legitimate abbreviated
 * domains (upenn.edu titled "University of Pennsylvania"), which a hostname-only
 * check would wrongly reject.
 */
export function isPlausibleHomepage({ url, title = '' } = {}, orgName) {
  const host = domainOf(url)
  if (!host || !orgName) return false
  const bare = host.split('.').slice(0, -1).join('')
  const haystack = `${bare} ${String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')}`
  return distinctiveNameTokens(orgName).some((tok) => haystack.includes(tok))
}
