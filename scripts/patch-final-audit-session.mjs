import fs from 'node:fs'

const file = 'scripts/vercel-final-authenticated-audit.mjs'
let source = fs.readFileSync(file, 'utf8')

function replaceOnce(label, before, after) {
  if (source.includes(after)) {
    console.log(`[final-audit-session] ${label} already present`)
    return
  }
  if (!source.includes(before)) {
    throw new Error(`[final-audit-session] ${label} anchor not found`)
  }
  source = source.replace(before, after)
  console.log(`[final-audit-session] applied ${label}`)
}

replaceOnce(
  'session metadata parameter',
  'async function runBrowserAudit(accessToken, refreshToken, userPayload) {',
  'async function runBrowserAudit(accessToken, refreshToken, userPayload, sessionMeta = {}) {',
)

replaceOnce(
  'browser token expiry persistence',
  `  await context.addInitScript(({ access, refresh, activeProfile }) => {\n    window.localStorage.setItem('grantflow:access-token', access)\n    if (refresh) window.localStorage.setItem('grantflow:refresh-token', refresh)\n    if (activeProfile) window.localStorage.setItem('grantflow:active-profile-id', activeProfile)\n  }, {\n    access: accessToken,\n    refresh: refreshToken,\n    activeProfile: userPayload?.active_profile_id || null,\n  })`,
  `  const accessExpiryMs = (() => {\n    const direct = sessionMeta?.accessExpires ?? sessionMeta?.access_expires\n    if (direct !== undefined && direct !== null) {\n      const numeric = Number(direct)\n      if (Number.isFinite(numeric)) {\n        if (numeric > 1e12) return numeric\n        if (numeric > 1e9) return numeric * 1000\n        if (numeric > 0) return Date.now() + numeric * 1000\n      }\n      const parsed = Date.parse(String(direct))\n      if (Number.isFinite(parsed)) return parsed\n    }\n    try {\n      const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'))\n      if (Number.isFinite(Number(payload?.exp))) return Number(payload.exp) * 1000\n    } catch { /* fall through to expiresIn */ }\n    const expiresIn = Number(sessionMeta?.expiresIn ?? sessionMeta?.expires_in)\n    return Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 5 * 60 * 1000)\n  })()\n\n  await context.addInitScript(({ access, refresh, activeProfile, accessExpiry }) => {\n    window.localStorage.setItem('grantflow:access-token', access)\n    if (refresh) window.localStorage.setItem('grantflow:refresh-token', refresh)\n    window.localStorage.setItem('grantflow:access-expiry', String(accessExpiry))\n    if (activeProfile) window.localStorage.setItem('grantflow:active-profile-id', activeProfile)\n  }, {\n    access: accessToken,\n    refresh: refreshToken,\n    activeProfile: userPayload?.active_profile_id || userPayload?.activeProfileId || null,\n    accessExpiry: accessExpiryMs,\n  })`,
)

replaceOnce(
  'same-origin API authorization and safe refresh',
  `  await context.route('**/*', async (route) => {\n    const request = route.request()\n    const method = request.method().toUpperCase()\n    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue()\n    let pathname = clean(request.url(), 300)\n    try { pathname = new URL(request.url()).pathname } catch { /* keep redacted fallback */ }\n    const redFlag = /submit|attest|authoriz|payment|billing|purchase|checkout|portal-sync\\/(?:write|sync)|auto-?submit|\\/approve|credential|vault/i.test(pathname)\n    blocked.push({ method, pathname, red_flag: redFlag })\n    return route.abort('blockedbyclient')\n  })`,
  `  await context.route('**/*', async (route) => {\n    const request = route.request()\n    const method = request.method().toUpperCase()\n    let parsed = null\n    try { parsed = new URL(request.url()) } catch { /* keep null */ }\n    const pathname = parsed?.pathname || clean(request.url(), 300)\n    const sameOrigin = parsed?.origin === new URL(BASE_URL).origin\n    const headers = { ...request.headers() }\n    if (sameOrigin && pathname.startsWith('/api/') && accessToken) {\n      headers.authorization = \\`Bearer \\${accessToken}\\`\n    }\n    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {\n      return route.continue({ headers })\n    }\n    // Session refresh is the only browser mutation allowed. It is scoped to the\n    // dedicated audit account, carries no profile data, and preserves the exact\n    // same read-only identity while long browser evidence collection runs.\n    if (sameOrigin && method === 'POST' && pathname === '/api/auth/refresh') {\n      return route.continue({ headers })\n    }\n    const redFlag = /submit|attest|authoriz|payment|billing|purchase|checkout|portal-sync\\/(?:write|sync)|auto-?submit|\\/approve|credential|vault/i.test(pathname)\n    blocked.push({ method, pathname, red_flag: redFlag })\n    return route.abort('blockedbyclient')\n  })`,
)

replaceOnce(
  'direct bearer token for browser API reads',
  `  const apiGet = async (pathname, profileId = null) => page.evaluate(async ({ pathname, profileId }) => {\n    try {\n      const token = window.localStorage.getItem('grantflow:access-token')\n      const headers = { Accept: 'application/json' }\n      if (token) headers.Authorization = \\`Bearer \\${token}\\``,
  `  const apiGet = async (pathname, profileId = null) => page.evaluate(async ({ pathname, profileId, token }) => {\n    try {\n      const headers = { Accept: 'application/json' }\n      if (token) headers.Authorization = \\`Bearer \\${token}\\``,
)

replaceOnce(
  'pass direct bearer token into browser API reads',
  `  }, { pathname, profileId })`,
  `  }, { pathname, profileId, token: accessToken })`,
)

replaceOnce(
  'pre-browser issued-token verification',
  `  refreshToken = auth.json.refreshToken\n  if (auth.json?.user?.is_admin === true || auth.json?.user?.role === 'admin') {`,
  `  refreshToken = auth.json.refreshToken\n  const tokenIdentity = await requestJson('/api/auth/me', { token: accessToken, timeoutMs: 30_000 })\n  if (!tokenIdentity.ok) {\n    throw new Error(\\`issued access token failed immediate identity verification (\\${tokenIdentity.status}): \\${tokenIdentity.error || 'unknown'}\\`)\n  }\n  evidence.token_identity = {\n    status: tokenIdentity.status,\n    ok: true,\n    is_admin: tokenIdentity.json?.isAdmin === true || tokenIdentity.json?.is_admin === true || tokenIdentity.json?.role === 'admin',\n    accessible_profile_count: Number(tokenIdentity.json?.accessibleProfileCount ?? tokenIdentity.json?.accessible_profile_count ?? tokenIdentity.json?.profiles?.length ?? 0),\n  }\n  if (auth.json?.user?.is_admin === true || auth.json?.user?.role === 'admin') {`,
)

replaceOnce(
  'pass session metadata to browser audit',
  '  evidence.browser = await runBrowserAudit(accessToken, refreshToken, auth.json.user)',
  '  evidence.browser = await runBrowserAudit(accessToken, refreshToken, auth.json.user, auth.json)',
)

fs.writeFileSync(file, source)
console.log('[final-audit-session] browser session bootstrap hardened')
