/**
 * portalSessionProfiles.js
 *
 * REGISTRY: what we know about each portal's SESSION, and — critically — how to
 * ask that portal "am I still signed in?" in a way whose answer means something.
 *
 * WHY THIS EXISTS (measured 2026-08-01, prod + live probes)
 * ---------------------------------------------------------
 * `hamiltonSessionKeepAlive` decided a session was still alive like this:
 *
 *     navigate to  meta.landing_url || `https://${portal_host}/`
 *     category = classifyBlocker(pageText, finalUrl).category
 *     if (category is an auth challenge)  -> expired
 *     else                                -> "refreshed" (session is alive!)
 *
 * Two independent defects made that verdict meaningless:
 *
 *   1. `landing_url` is READ here and WRITTEN NOWHERE in the entire backend
 *      (verified by grep, 2026-08-01). So every probe has always navigated to
 *      the portal's PUBLIC ROOT — a marketing page that renders identically
 *      whether or not you hold a session.
 *
 *   2. The verdict treated "the classifier found no signal" (`unknown`) as
 *      POSITIVE PROOF OF LIFE. `classifyBlocker` returns `unknown` for any page
 *      it has no rule for — which is most pages, including public homepages AND
 *      studentaid.gov's own sign-in page.
 *
 * Live evidence, captured with the repo's own `launchPortalBrowser` +
 * `classifyBlocker` and a context holding ZERO cookies (i.e. a definitively
 * dead session):
 *
 *   https://collegefortn.org/      -> classify=missing_required_document -> "REFRESHED"
 *   https://leic.tennessee.edu/    -> classify=unknown                   -> "REFRESHED"
 *   https://studentaid.gov/        -> classify=unknown, 1914 chars of
 *                                     "Manage and Repay Your Federal Student
 *                                      Loans"                            -> "REFRESHED"
 *
 * All three report a healthy session while holding no session at all. Prod
 * carries the residue: `hamilton_saved_sessions` metadata shows
 * `keepalive_refreshes: 11` (studentaid.gov), `9` (scholarships.com), `9`
 * (leic.tennessee.edu) — none of which is evidence of anything.
 *
 * The one probe that DOES carry information, same run:
 *
 *   https://studentaid.gov/my-activity/  ->  302 to
 *   https://studentaid.gov/fsa-id/sign-in/landing?redirectTo=%2Fmy-activity
 *
 * That is a POSITIVE, structural death signal: we asked for an auth-gated path
 * and the portal moved us to a sign-in surface. It is also exactly the signal
 * the owner measured by hand (authenticated at T+30s, bounced at T+~20min).
 *
 * THE RULE THIS REGISTRY ENCODES
 * ------------------------------
 * Liveness is only ever claimed from a POSITIVE observation:
 *
 *   - we requested a path that REQUIRES authentication, and
 *   - we were not moved to a sign-in surface, and
 *   - the page rendered real content.
 *
 * Anything else is `unverified` — never "alive", never "dead". A host with no
 * `authProbePath` here can never produce a lifetime observation, and that is
 * correct: we would be guessing. Silence is not proof, in either direction
 * (the same rule `AMOUNT_STATUS_NONE_PUBLISHED` encodes for award amounts).
 *
 * ADDING A HOST: give it an `authProbePath` that 302s to a login page when
 * signed out and renders account content when signed in. Verify BOTH states by
 * hand before adding it — an authProbePath that is actually public silently
 * converts this whole module back into the fabrication it exists to prevent.
 */

/**
 * URL-path fragments that mean "this is a sign-in surface". Matched against the
 * FINAL url after redirects, case-insensitively. Structural (a path), never
 * page copy — copy varies per portal and per A/B test; the redirect does not.
 *
 * Deliberately requires a path SEGMENT shape (`/sign-in`, `/login`) rather than
 * a bare substring so a content page like `/how-to-log-in-help` is not read as
 * a wall.
 */
export const SIGN_IN_URL_PATTERNS = Object.freeze([
  /\/fsa-id\/sign-in(\/|$|\?)/i,
  /\/sign[-_]?in(\/|$|\?)/i,
  /\/log[-_]?in(\/|$|\?)/i,
  /\/login(\/|$|\?)/i,
  /\/signon(\/|$|\?)/i,
  /\/sso\/(login|signin|authenticate)(\/|$|\?)/i,
  /\/auth\/(login|signin)(\/|$|\?)/i,
  /\/account\/login(\/|$|\?)/i,
  /\/idp\/|\/adfs\/|\/oauth2\/authorize/i,
  /login\.microsoftonline\.com/i,
  /accounts\.google\.com\/(signin|o\/oauth2)/i,
])

/**
 * Same-origin paths a READ-ONLY session probe may follow when a portal moves
 * an auth-gated request to its sign-in surface. These extend navigation only;
 * they never grant credential, profile-field, upload, or submit authority.
 *
 * Keep this list deliberately narrower than SIGN_IN_URL_PATTERNS: external SSO
 * origins need their own reviewed origin contract and are not inferred here.
 */
export const SESSION_PROBE_SIGN_IN_PATH_PREFIXES = Object.freeze([
  '/fsa-id/sign-in',
  '/sign-in',
  '/signin',
  '/sign_in',
  '/log-in',
  '/login',
  '/log_in',
  '/signon',
  '/sso/login',
  '/sso/signin',
  '/sso/authenticate',
  '/auth/login',
  '/auth/signin',
  '/account/login',
  '/idp',
  '/adfs',
  '/oauth2/authorize',
])

/**
 * Per-host session knowledge. Keyed by registrable domain (eTLD+1) or exact
 * host; `resolvePortalSessionProfile` prefers the exact host.
 *
 *   authProbePath        A path that REQUIRES authentication. Requesting it
 *                        while signed out must land on a sign-in surface.
 *                        null = we have no honest way to test this host.
 *   observedLifetimeMs   Best current estimate of how long a captured session
 *                        stays authenticated. SEED ONLY — the measured ledger
 *                        (portalSessionLifetime.js) supersedes it once real
 *                        observations exist.
 *   lifetimeSource       'measured' | 'seed' — provenance for the estimate, so
 *                        no surface can present a guess as a measurement.
 *   syncOnCapture        true when the session is too short-lived to survive
 *                        until a scheduled run, so the ONLY reliable moment to
 *                        sync is immediately after a human captures it.
 */
export const PORTAL_SESSION_PROFILES = Object.freeze({
  'studentaid.gov': Object.freeze({
    host: 'studentaid.gov',
    label: 'Federal Student Aid',
    authProbePath: '/my-activity/',
    // Owner-measured 2026-08-01: authenticated at T+30s, bounced to
    // /fsa-id/sign-in/landing at T+~20min with no intervening activity.
    observedLifetimeMs: 20 * 60 * 1000,
    lifetimeSource: 'seed',
    syncOnCapture: true,
    notes: 'Akamai-fronted federal portal. Short session + hostile to repeated '
      + 'datacenter probing — sync while warm, do not try to keep it warm.',
  }),
  'cssprofile.collegeboard.org': Object.freeze({
    host: 'cssprofile.collegeboard.org',
    label: 'CSS Profile',
    authProbePath: null,
    observedLifetimeMs: null,
    lifetimeSource: 'seed',
    syncOnCapture: true,
    notes: 'College Board SSO. No verified auth-gated probe path yet.',
  }),
  'scholarships.com': Object.freeze({
    host: 'scholarships.com',
    label: 'Scholarships.com',
    authProbePath: null,
    observedLifetimeMs: null,
    lifetimeSource: 'seed',
    syncOnCapture: false,
    notes: 'Cloudflare-fronted (live probe 2026-08-01 returned a 403 '
      + '"Just a moment..." interstitial to a plain fetch). Probe verdicts here '
      + 'are inconclusive by default.',
  }),
})

/** Used for any host with no registry entry: nothing is assumed. */
export const DEFAULT_SESSION_PROFILE = Object.freeze({
  host: null,
  label: null,
  authProbePath: null,
  observedLifetimeMs: null,
  lifetimeSource: 'seed',
  syncOnCapture: false,
  notes: 'No registry entry — liveness can never be positively confirmed, so '
    + 'the keep-alive probe reports `unverified` and records no observation.',
})

/**
 * Resolve the session profile for a host. Exact host wins; otherwise the
 * registrable-domain entry; otherwise the default. Pure, never throws.
 *
 * @param {string} host  a hostname (not a URL)
 * @returns {object} a frozen profile (never null)
 */
export function resolvePortalSessionProfile(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
  if (!h) return DEFAULT_SESSION_PROFILE
  if (PORTAL_SESSION_PROFILES[h]) return PORTAL_SESSION_PROFILES[h]
  // Suffix match on registrable domain: a session captured on
  // `studentaid.gov` must resolve for `www.studentaid.gov`.
  for (const key of Object.keys(PORTAL_SESSION_PROFILES)) {
    if (h === key || h.endsWith(`.${key}`)) return PORTAL_SESSION_PROFILES[key]
  }
  return DEFAULT_SESSION_PROFILE
}

/**
 * Is `url` a sign-in surface? Structural (final URL after redirects) — the one
 * signal that survives copy changes and A/B tests. Pure, never throws.
 */
export function isSignInSurfaceUrl(url) {
  const s = String(url || '').trim()
  if (!s) return false
  return SIGN_IN_URL_PATTERNS.some((rx) => rx.test(s))
}

/**
 * The absolute URL to probe for a host, or null when this host has no honest
 * auth-gated path (in which case the caller MUST NOT claim liveness).
 */
export function authProbeUrlForHost(host) {
  const profile = resolvePortalSessionProfile(host)
  if (!profile.authProbePath) return null
  const h = String(host || '').trim().toLowerCase()
  if (!h) return null
  return `https://${h}${profile.authProbePath}`
}

export default {
  PORTAL_SESSION_PROFILES,
  DEFAULT_SESSION_PROFILE,
  SIGN_IN_URL_PATTERNS,
  SESSION_PROBE_SIGN_IN_PATH_PREFIXES,
  resolvePortalSessionProfile,
  isSignInSurfaceUrl,
  authProbeUrlForHost,
}
