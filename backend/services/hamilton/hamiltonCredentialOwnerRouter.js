/**
 * hamiltonCredentialOwnerRouter.js
 *
 * When an admin imports a consolidated password export (e.g. one person's
 * Chrome vault that actually contains logins for several family members /
 * organizations), every credential should land in a central ADMIN vault so
 * the admin can assist anyone — AND, where the owner can be identified, a
 * copy should also be routed into that individual profile's vault so Hamilton
 * picks it up automatically when it works that profile's portals.
 *
 * This module is the pure, side-effect-free classification layer. Given a
 * credential's non-secret identifiers (username/email, portal host, label) and
 * a compiled set of per-profile routing rules, it returns the profile ids that
 * own the credential. It NEVER sees or touches the plaintext password.
 *
 * Matching is intentionally conservative: short, ambiguous tokens ("jw", "j",
 * "white") are NOT used as rules by callers — a credential that can't be
 * confidently attributed simply stays in the admin vault only. Mis-routing a
 * real login into the wrong person's vault is worse than not routing it, and
 * the admin vault is always the safety net.
 *
 * Rule shape (a "route def"):
 *   {
 *     profileId: 'profile-demo-health-education',
 *     label: 'Demo Research Owner',     // human-readable, for reporting
 *     match: {
 *       usernames:        ['portal-owner@example.invalid'], // exact, lowercased
 *       usernamePrefixes: ['demo-owner', 'demo-lab'], // username startsWith
 *       emailDomains:     ['example.invalid'],        // part after '@'
 *       hosts:            ['example.invalid'],        // host == / endsWith / includes
 *       keywords:         ['demoresearchowner'],      // substring of user/label/host
 *     },
 *   }
 */

function lc(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase()
}

/**
 * Compile raw route defs into a normalized, fast-to-match shape. Lowercases
 * everything once up front and strips a leading '@' from email domains so a
 * rule author can write either 'serenova.org' or '@serenova.org'.
 */
export function compileRoutes(routeDefs) {
  if (!Array.isArray(routeDefs)) return []
  return routeDefs
    .filter((d) => d && d.profileId)
    .map((d) => {
      const m = d.match || {}
      return {
        profileId: String(d.profileId),
        label: d.label ? String(d.label) : String(d.profileId),
        usernames: new Set((m.usernames || []).map(lc).filter(Boolean)),
        usernamePrefixes: (m.usernamePrefixes || []).map(lc).filter(Boolean),
        emailDomains: (m.emailDomains || []).map((x) => lc(x).replace(/^@/, '')).filter(Boolean),
        hosts: (m.hosts || []).map(lc).filter(Boolean),
        keywords: (m.keywords || []).map(lc).filter(Boolean),
      }
    })
}

/**
 * Return the de-duplicated list of profile ids that own a credential.
 *
 * A rule matches when ANY of its facets matches:
 *   - exact username, or
 *   - username starts with one of usernamePrefixes, or
 *   - the username's email domain is listed, or
 *   - the host equals / is a subdomain of / contains a listed host, or
 *   - a keyword appears anywhere in username / label / host.
 *
 * A single credential can legitimately match more than one profile (e.g. a
 * `owner@example.invalid` login belongs to both a demo owner and a demo lab),
 * so the result is a list, not a single id.
 *
 * @param {{username?:string, host?:string, label?:string}} cred
 * @param {ReturnType<typeof compileRoutes>} compiled
 * @returns {string[]} owning profile ids (possibly empty)
 */
export function classifyOwners({ username = '', host = '', label = '' } = {}, compiled = []) {
  const u = lc(username)
  const h = lc(host)
  const l = lc(label)
  const dom = u.includes('@') ? u.slice(u.indexOf('@') + 1) : ''
  const out = []
  for (const r of compiled) {
    let hit = false
    if (u && r.usernames.has(u)) hit = true
    else if (u && r.usernamePrefixes.some((p) => u.startsWith(p))) hit = true
    else if (dom && r.emailDomains.includes(dom)) hit = true
    else if (h && r.hosts.some((x) => h === x || h.endsWith(`.${x}`) || h.includes(x))) hit = true
    else if (r.keywords.some((k) => (u && u.includes(k)) || (l && l.includes(k)) || (h && h.includes(k)))) hit = true
    if (hit) out.push(r.profileId)
  }
  return [...new Set(out)]
}
