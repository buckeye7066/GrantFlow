/**
 * safeUrl — shared URL-safety helpers used everywhere we render a portal /
 * application "log in" link or hand a host to Hamilton's saved-login flow.
 *
 * Two small, well-scoped helpers so the same scheme-validation and host
 * extraction is used consistently across funding-source and college surfaces
 * (mirrors the per-component safeHttpUrl that used to live in
 * PipelinePotentialBreakdown.jsx).
 */

/**
 * Return a clean href for `u` only when it is an http(s) URL — blocks
 * javascript:/data:/file: scheme injection from stored application_url /
 * portal_url values. Returns null for anything that isn't a valid http(s) URL.
 *
 * @param {unknown} u
 * @returns {string|null}
 */
export function safeHttpUrl(u) {
  if (!u) return null
  try {
    const p = new URL(String(u).trim())
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null
  } catch {
    return null
  }
}

/**
 * Extract the registrable-ish host from a URL (e.g. "mtsu.edu" from
 * "https://login.mtsu.edu/sign-in"), with the leading "www." stripped. This is
 * the value SavedLoginsCard matches a saved credential against (host or any
 * subdomain), so we hand it the bare host rather than the full URL.
 *
 * Returns null when the input isn't a usable http(s) URL.
 *
 * @param {unknown} u
 * @returns {string|null}
 */
export function hostFromUrl(u) {
  const href = safeHttpUrl(u)
  if (!href) return null
  try {
    const host = new URL(href).hostname.replace(/^www\./i, "")
    return host || null
  } catch {
    return null
  }
}
