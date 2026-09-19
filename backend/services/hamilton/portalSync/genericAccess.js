import { registrableDomain } from '../hamiltonPortalCredentialService.js'
/** A fallback credential for a different portal cannot redirect this portal's session. */
export function genericCredentialLoginUrl(ctx = {}) {
  const raw = ctx.credential?.login_url || ctx.credential?.loginUrl || null
  if (!raw) return null
  try {
    const wanted = new URL('https://' + ctx.portalHost).hostname.replace(/^www\./, '')
    const binding = ctx.credential?.portal_host
    const boundHost = binding ? new URL('https://' + binding).hostname.replace(/^www\./, '') : null
    const url = new URL(raw)
    const loginHost = url.hostname.replace(/^www\./, '')
    const domain = registrableDomain(wanted)
    if (boundHost !== wanted) {
      if (!domain || registrableDomain(loginHost) !== domain ||
          (boundHost && registrableDomain(boundHost) !== domain)) return null
      // A parent institution's public homepage is not a child's portal login.
      if (wanted.endsWith('.' + loginHost) && url.pathname === '/' && !url.search) return null
    }
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

/** Observe authenticated account controls; a saved session or readable page is not proof. */
export async function observeGenericAccess(page, ctx = {}, requestedUrl) {
  let snapshot = null
  let landed = ''
  try {
    landed = page.url()
    const read = () => page.evaluate(() => {
      const visible = element => {
        const style = window.getComputedStyle(element)
        return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
      }
      const controls = Array.from(document.querySelectorAll('a,button,input[type="submit"],[role="button"],[role="link"]'))
        .slice(0,2000).filter(visible)
      const labels = controls.map(element => String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0,200))
      const text = (document.body?.innerText || '').slice(0,16000)
      return {
        title: String(document.title || '').slice(0,160), chars: text.length,
        hasLogout: labels.some(label => /^(?:log\s*out|sign\s*out)(?:\s|$)/i.test(label)),
        hasAccountNavigation: labels.some(label => /\b(?:my|your)\s+(?:account|profile|applications?|dashboard)\b|^(?:dashboard|applicant home)$/i.test(label)),
        hasPassword: Array.from(document.querySelectorAll('input[type="password"]')).some(visible),
        hasSignInPrompt: /\b(?:please|must)\s+(?:sign|log)\s*in\b|\b(?:sign|log)\s*in\s+to\s+(?:your|the)\s+(?:account|portal)\b/i.test(text),
        blocked: /\b(?:access denied|request (?:was )?blocked|unusual activity|verify you are human)\b/i.test(text),
      }
    })
    snapshot = await read()
    // MTSU's sign-in view is a JavaScript shell at DOMContentLoaded. Wait only
    // for an empty shell, under a fixed bound, then observe the actual controls.
    if (snapshot?.chars === 0 && typeof page.waitForFunction === 'function') {
      try { await page.waitForFunction(() => Boolean(document.body?.innerText?.trim()), undefined, { timeout: 3000 }) } catch { /* Empty stays unknown. */ }
      snapshot = await read()
    }
    landed = page.url()
  } catch { /* A failed observation is unknown, never authenticated. */ }
  let expectedHost = ''
  let actualHost = ''
  let signInUrl = false
  try {
    expectedHost = new URL('https://' + ctx.portalHost).hostname.replace(/^www\./,'')
    const target = new URL(landed)
    if (target.protocol === 'https:') actualHost = target.hostname.replace(/^www\./,'')
    signInUrl = /\/(?:login|signin|sign-in|account\/login)(?:\/|$)/i.test(target.pathname)
  } catch { /* Malformed URLs cannot prove account access. */ }
  const expectedDomain = registrableDomain(expectedHost)
  let savedHost = ''
  try {
    const saved = new URL(genericCredentialLoginUrl(ctx) || '')
    if (saved.protocol === 'https:' && registrableDomain(saved.hostname) === expectedDomain) savedHost = saved.hostname.replace(/^www\./,'')
  } catch { /* Missing login URL grants no additional host scope. */ }
  // Trust the requested portal and its own descendants, or its explicitly saved
  // same-domain login host. Never trust every sibling tenant of a shared domain.
  const samePortal = expectedDomain && registrableDomain(actualHost) === expectedDomain &&
    (actualHost === expectedHost || actualHost.endsWith('.' + expectedHost) || (savedHost && actualHost === savedHost))
  let access = 'unknown'
  if (snapshot?.blocked === true) access = 'blocked'
  else if (snapshot?.hasPassword === true || ((snapshot?.hasSignInPrompt === true || signInUrl) && snapshot?.hasLogout !== true)) access = 'signin_wall'
  else if (ctx.hasSession === true && samePortal &&
      snapshot?.hasLogout === true && snapshot?.hasAccountNavigation === true) access = 'authenticated'
  const safeUrl = value => {
    try { const url = new URL(value); return (url.origin + url.pathname).slice(0,1000) } catch { return null }
  }
  return {
    access,
    can_follow_account_entry: Boolean(ctx.hasSession === true && samePortal && snapshot &&
      snapshot.blocked !== true && snapshot.hasPassword !== true),
    page: { url: safeUrl(requestedUrl), landed: safeUrl(landed), title: snapshot?.title || null,
      chars: Number.isFinite(snapshot?.chars) ? snapshot.chars : null, access },
  }
}

/** Find a visible, same-origin account entry using the existing session. */
export async function findGenericAccountEntry(page, requestedUrl) {
  try {
    const requested = new URL(requestedUrl)
    const current = new URL(page.url())
    if (requested.protocol !== 'https:' || current.protocol !== 'https:' || requested.username || requested.password ||
        requested.hostname.replace(/^www\./,'') !== current.hostname.replace(/^www\./,'') || current.port !== requested.port) return null
    const currentDocument = new URL(current); currentDocument.hash = ''
    const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .slice(0,2000).filter(element => {
        const style = window.getComputedStyle(element)
        const text = String(element.innerText || element.getAttribute('aria-label') || '').trim()
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0 &&
          /^(?:(?:log\s*in|sign\s*in)(?:\s+with\s+campus\s+id)?|my account|account home|dashboard)$/i.test(text)
      }).map(element => element.href).slice(0,8))
    for (const value of Array.isArray(candidates) ? candidates : []) {
      const target = new URL(value)
      if (target.protocol !== 'https:' || target.origin !== current.origin || target.username || target.password) continue
      target.hash = ''
      if (target.href === currentDocument.href || /logout|signout|sign-out|submit|payment|purchase|delete|apply/i.test(target.pathname + target.search)) continue
      return target.href
    }
  } catch { /* A missing or unreadable account entry is not a successful login. */ }
  return null
}

// The read and write phases share the same bounded session-reuse path.
export async function observeAccountEntry(page, ctx, requestedUrl) {
  let observed = await observeGenericAccess(page, ctx, requestedUrl)
  const visited = new Set()
  try { visited.add(page.url()) } catch { /* Observation remains fail-closed. */ }
  // The live MTSU flow is public home -> Login -> Log in with Campus ID.
  // Two safe GET entries are enough; no arbitrary crawl or login form is allowed.
  for (let hop = 0; hop < 2 && ['unknown', 'signin_wall'].includes(observed.access) && observed.can_follow_account_entry; hop++) {
    const entry = await findGenericAccountEntry(page, requestedUrl)
    if (!entry || visited.has(entry)) break
    visited.add(entry)
    try {
      await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 30000 })
      requestedUrl = entry
      observed = await observeGenericAccess(page, ctx, entry)
    } catch { break }
  }
  return observed
}
