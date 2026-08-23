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

// ── Outreach-email selection (the SUPPLY-side fix) ──────────────────────────
//
// The plausibility GATE (isPlausibleHomepage / enforceLeadContactPlausibility)
// is the last line of defense; it strips a bad recipient AFTER John has already
// drafted to it, so the owner's mailbox ends up empty. The real cure is to never
// attach a bad recipient in the first place. Three failure classes were measured
// in prod 2026-08-23, each on a CORRECTLY-selected homepage:
//   - WRONG ORG:   `info@indiantypefoundry.com` scraped off the (right) homepage
//     `reynoldsburgeducationfoundation.org` — a font vendor's address embedded in
//     the page's CSS/fonts. Its registrable domain differs from the org's site.
//   - MALFORMED:   `u@penn.php` scraped off `upenn.edu` — `.php` is a file
//     extension the naive email regex mistook for a TLD, and `u` a 1-char local.
//   - GENERIC-ONLY: `webmaster@luriechildrens.org` / `webadmin@berkeley.edu` —
//     right domain, but a web-infra mailbox that is not an outreach contact.
//
// chooseOutreachEmail() encodes the fix: a recipient must (1) be on the org's
// OWN verified-homepage registrable domain, (2) be a realistically-shaped
// mailbox, and (3) be a real outreach/person channel — a bare web-infra mailbox
// is a weak fallback, never a first choice. When none qualifies it returns
// ok:false so the lead stays needs_enrichment (owner sees it as needs-contact)
// instead of being drafted-then-archived.

/**
 * Registrable domain (~eTLD+1) of an email/URL/host. Collapses `www.x.berkeley.edu`
 * and `berkeley.edu` to the same key so a same-org test is subdomain-robust, while
 * a small multi-part public-suffix set keeps `foo.co.uk` from collapsing to `co.uk`.
 */
export function registrableDomain(value) {
  const d = domainOf(value)
  if (!d) return null
  const parts = d.split('.').filter(Boolean)
  if (parts.length <= 2) return d
  const MULTI_PART_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'org.au', 'edu.au',
    'gov.au', 'co.nz', 'org.nz', 'co.za',
  ])
  const last2 = parts.slice(-2).join('.')
  return MULTI_PART_SUFFIXES.has(last2) ? parts.slice(-3).join('.') : last2
}

// A "TLD" that is really a file/script extension — a scrape mistaking a path or
// asset URL for an email domain (`u@penn.php`, `x@logo.png`).
const FILE_EXT_TLD_RE = /\.(php\d?|aspx?|jsp|cgi|s?html?|xml|json|md|txt|png|jpe?g|gif|svg|webp|bmp|ico|css|js|mjs|woff2?|ttf|eot|otf|pdf|zip|map)$/i

/**
 * Strict mailbox shape: a plausible local part and a real-looking TLD. Stricter
 * than isValidEmail (which accepts `u@penn.php` because `.php` matches `[a-z]{2,}`).
 */
export function isRealisticContactEmail(email) {
  const e = String(email || '').trim().toLowerCase()
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return false
  const [local, domain] = e.split('@')
  if (!local || local.length < 2) return false               // `u@…` single-char junk
  if (!domain || domain.split('.').some((label) => !label)) return false // `a@b..com`
  if (FILE_EXT_TLD_RE.test(domain)) return false             // `u@penn.php`
  return true
}

// Real outreach mailboxes, ranked best-first — a grants/development desk is the
// ideal cold-outreach target for GrantFlow. Order is the ranking.
const OUTREACH_LOCALS = [
  'grants', 'grant', 'development', 'devoffice', 'foundation', 'giving',
  'philanthropy', 'donations', 'donate', 'advancement', 'partnerships',
  'partner', 'programs', 'program', 'outreach', 'community', 'contact',
  'contactus', 'connect', 'hello', 'info', 'inquiries', 'inquiry', 'general',
  'office', 'main', 'team', 'mail', 'communications', 'comms', 'media', 'press',
]
const OUTREACH_LOCAL_RANK = new Map(OUTREACH_LOCALS.map((l, i) => [l, i]))

// Web-infrastructure / systems mailboxes: right domain but NOT an outreach
// contact. A weak fallback only — never a first choice (owner rule 2026-08-23).
const WEAK_CONTACT_LOCALS = new Set([
  'webmaster', 'webadmin', 'web', 'website', 'sysadmin', 'hostmaster', 'root',
  'noc', 'it', 'ithelp', 'helpdesk', 'support', 'tech', 'techsupport',
  'administrator', 'domains', 'dns', 'security', 'privacy', 'legal', 'compliance',
])

/** Classify a mailbox's local part: 'weak' | 'outreach' | 'person'. */
export function classifyContactLocal(email) {
  const local = String(email || '').split('@')[0].toLowerCase().trim()
  if (!local) return 'weak'
  const head = local.split(/[._-]/)[0] // `web.strategiccommunication` → `web`
  if (WEAK_CONTACT_LOCALS.has(local) || WEAK_CONTACT_LOCALS.has(head)) return 'weak'
  if (OUTREACH_LOCAL_RANK.has(local)) return 'outreach'
  return 'person' // a named-person / office mailbox — a real human channel
}

/**
 * Does an email's domain plausibly BELONG to this org? True when it is on the
 * org's own verified-homepage registrable domain, OR when the domain itself
 * passes the same whole-name plausibility bar the recipient gate enforces
 * (`isPlausibleHomepage`) — so a legitimate org whose email domain differs from
 * its website domain (foo.org site, @foomail.org mail) is kept, while a
 * third-party vendor address embedded in the page (info@indiantypefoundry.com on
 * a school's homepage) is refused. This deliberately mirrors
 * enforceLeadContactPlausibility: enrichment only ever produces a recipient the
 * gate would keep, so the two can never disagree.
 */
function emailDomainBelongsToOrg(email, { orgDomain, orgName } = {}) {
  const emailReg = registrableDomain(email)
  if (!emailReg) return false
  const homeReg = registrableDomain(orgDomain)
  if (homeReg && emailReg === homeReg) return true
  if (orgName) {
    const domain = domainOf(email)
    if (domain && isPlausibleHomepage({ url: `https://${domain}`, title: '' }, orgName)) return true
  }
  return false
}

/**
 * Choose the best REACHABLE outreach email for an org from scraped candidates.
 *
 * @param {string[]} emails    scraped candidate addresses
 * @param {object} opts
 * @param {string} opts.orgDomain  the org's OWN verified homepage (url/host/domain)
 * @param {string} [opts.orgName]  the org's name (enables whole-name domain plausibility)
 * @returns {{ok:boolean, email?:string, generic?:boolean, reason?:string}}
 *   ok:true  → a real, org-owned outreach/person contact (safe to draft to)
 *   ok:false → nothing usable; `generic:true` means an org-owned web-infra
 *              mailbox exists but is too weak to draft (surface as needs-contact)
 */
export function chooseOutreachEmail(emails, { orgDomain, orgName } = {}) {
  if (!registrableDomain(orgDomain) && !orgName) return { ok: false, reason: 'no_org_identity' }
  const owned = (Array.isArray(emails) ? emails : [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => isRealisticContactEmail(e) && !isExcludedEmail(e))
    // The recipient must belong to the org — its own site domain, or a domain
    // that passes the whole-name plausibility bar. Refuses a vendor's address.
    .filter((e) => emailDomainBelongsToOrg(e, { orgDomain, orgName }))
  if (!owned.length) return { ok: false, reason: 'no_org_owned_contact' }

  const rank = (e) => {
    const kind = classifyContactLocal(e)
    if (kind === 'weak') return 1000
    if (kind === 'person') return 500
    return 100 + (OUTREACH_LOCAL_RANK.get(e.split('@')[0].toLowerCase()) ?? 99)
  }
  const sorted = [...new Set(owned)].sort((a, b) => rank(a) - rank(b))
  const best = sorted[0]
  if (classifyContactLocal(best) === 'weak') {
    return { ok: false, generic: true, email: best, reason: 'only_generic_web_mailbox' }
  }
  return { ok: true, email: best, generic: false }
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
  'education', 'educational',
  // Org SUFFIXES / legal forms. These matter twice over, because the COVERAGE
  // rule now requires every distinctive token to be explained: leaving a suffix
  // in the distinctive set demands the org's domain spell it out, and no real
  // org does — `rivertownyouth.org` IS the Rivertown Youth Coalition, and
  // `leaderscu.com` IS Leaders Education Foundation Inc. Treating a category
  // word as REQUIRED is the mirror of the original bug (treating it as
  // sufficient); both come from this list being incomplete.
  'foundation', 'foundations', 'coalition', 'council', 'councils',
  'association', 'associations', 'alliance', 'society', 'trust',
  'fund', 'funds', 'inc', 'incorporated', 'llc', 'ltd', 'corporation',
  'organization', 'organizations', 'center', 'centers', 'centre',
  'network', 'services', 'initiative',
])

/** Org-name tokens that actually identify THIS org (drops category words). */
export function distinctiveNameTokens(name) {
  const toks = nameTokens(name)
  const distinctive = toks.filter((t) => !GENERIC_ORG_TOKENS.has(t))
  // An org named entirely from category words (e.g. "Community Health Center")
  // has nothing distinctive; fall back rather than rejecting everything.
  return distinctive.length ? distinctive : toks
}

/** Every >=3-char word of an org name, INCLUDING category words and stopwords. */
function allNameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3)
}

/** Shortest abbreviation of an org token we will credit inside a hostname. */
const MIN_ABBREV_LEN = 4
/** Leftover hostname text this long names a DIFFERENT entity, not an abbreviation. */
const MAX_UNEXPLAINED_HOST_LEN = 4

/**
 * Hostname text left over once every word of the org's name is accounted for.
 *
 * Each org token is removed whole where present, else by its longest >=4-char
 * PREFIX ("penn" for "pennsylvania" inside `upenn`) — that is what a legitimate
 * abbreviated domain looks like. What survives is text the org's own name cannot
 * explain: `decaturwatchfest26` minus "decatur" leaves "watchfest26", which is a
 * watch festival, not the Decatur County Education Foundation.
 *
 * Only LETTERS count as leftover identity — hyphens, digits and separators
 * (`riverbend-org.test`, `decaturwatchfest26`) name nobody.
 */
function unexplainedHostText(bare, orgName) {
  let rest = bare
  // Longest first so "pennsylvania" is consumed before its own prefix "penn".
  const toks = allNameTokens(orgName).sort((a, b) => b.length - a.length)
  for (const tok of toks) {
    if (rest.includes(tok)) {
      rest = rest.split(tok).join('')
      continue
    }
    for (let len = tok.length - 1; len >= MIN_ABBREV_LEN; len--) {
      const prefix = tok.slice(0, len)
      if (rest.includes(prefix)) {
        rest = rest.split(prefix).join('')
        break
      }
    }
  }
  return rest.replace(/[^a-z]/g, '')
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
 * The first fix required ONE distinctive token in the hostname or title. That
 * replaced "no floor" with a floor of one word, which is no floor at all for the
 * org names Yana actually discovers: a single shared surname or place name let
 * `willienelson.com` answer for the "Willie Julie Educational Foundation",
 * `johnson.edu` for the "Johnson City Area Arts Council", and
 * `robertsoncountyfuneralhome.com` for the "Robertson Community Health
 * Foundation" — 8 of 10 live drafts on 2026-07-15 passed that gate. One shared
 * word is a coincidence; identity has to be argued from the WHOLE name.
 *
 * Two conditions must now BOTH hold:
 *  1. COVERAGE — every distinctive org token appears in the hostname or the
 *     search-result title. The title is what rescues legitimate abbreviated
 *     domains (upenn.edu titled "University of Pennsylvania").
 *  2. HOST ANCHOR — the hostname carries no substantial text the org's name
 *     cannot explain. This is what stops the title alone from authorizing an
 *     unrelated host: worldatlas.com has a page titled "Ohio", but "worldatlas"
 *     is not anything the "Ohio Education Foundation" is named after.
 */
export function isPlausibleHomepage({ url, title = '' } = {}, orgName) {
  const host = domainOf(url)
  if (!host || !orgName) return false
  const bare = host.split('.').slice(0, -1).join('')
  const haystack = `${bare} ${String(title || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ')}`

  const distinctive = distinctiveNameTokens(orgName)
  if (!distinctive.length) return false
  if (!distinctive.every((tok) => haystack.includes(tok))) return false

  return unexplainedHostText(bare, orgName).length < MAX_UNEXPLAINED_HOST_LEN
}
