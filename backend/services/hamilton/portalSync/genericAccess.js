/** Observe authenticated account controls; a saved session or readable page is not proof. */
export async function observeGenericAccess(page, ctx = {}, requestedUrl) {
  let snapshot = null
  let landed = ''
  try {
    landed = page.url()
    snapshot = await page.evaluate(() => {
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
  let access = 'unknown'
  if (snapshot?.blocked === true) access = 'blocked'
  else if (snapshot?.hasPassword === true || ((snapshot?.hasSignInPrompt === true || signInUrl) && snapshot?.hasLogout !== true)) access = 'signin_wall'
  else if (ctx.hasSession === true && expectedHost && actualHost === expectedHost &&
      snapshot?.hasLogout === true && snapshot?.hasAccountNavigation === true) access = 'authenticated'
  const safeUrl = value => {
    try { const url = new URL(value); return (url.origin + url.pathname).slice(0,1000) } catch { return null }
  }
  return {
    access,
    page: { url: safeUrl(requestedUrl), landed: safeUrl(landed), title: snapshot?.title || null,
      chars: Number.isFinite(snapshot?.chars) ? snapshot.chars : null, access },
  }
}
