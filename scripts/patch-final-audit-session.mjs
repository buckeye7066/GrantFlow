import fs from 'node:fs'

const file = 'scripts/vercel-final-authenticated-audit.mjs'
let source = fs.readFileSync(file, 'utf8')
const block = (...lines) => lines.join('\n')

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
  block(
    "  await context.addInitScript(({ access, refresh, activeProfile }) => {",
    "    window.localStorage.setItem('grantflow:access-token', access)",
    "    if (refresh) window.localStorage.setItem('grantflow:refresh-token', refresh)",
    "    if (activeProfile) window.localStorage.setItem('grantflow:active-profile-id', activeProfile)",
    '  }, {',
    '    access: accessToken,',
    '    refresh: refreshToken,',
    '    activeProfile: userPayload?.active_profile_id || null,',
    '  })',
  ),
  block(
    '  const accessExpiryMs = (() => {',
    '    const direct = sessionMeta?.accessExpires ?? sessionMeta?.access_expires',
    '    if (direct !== undefined && direct !== null) {',
    '      const numeric = Number(direct)',
    '      if (Number.isFinite(numeric)) {',
    '        if (numeric > 1e12) return numeric',
    '        if (numeric > 1e9) return numeric * 1000',
    '        if (numeric > 0) return Date.now() + numeric * 1000',
    '      }',
    '      const parsed = Date.parse(String(direct))',
    '      if (Number.isFinite(parsed)) return parsed',
    '    }',
    '    try {',
    "      const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'))",
    '      if (Number.isFinite(Number(payload?.exp))) return Number(payload.exp) * 1000',
    '    } catch { /* fall through to expiresIn */ }',
    '    const expiresIn = Number(sessionMeta?.expiresIn ?? sessionMeta?.expires_in)',
    '    return Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 5 * 60 * 1000)',
    '  })()',
    '',
    '  await context.addInitScript(({ access, refresh, activeProfile, accessExpiry }) => {',
    "    window.localStorage.setItem('grantflow:access-token', access)",
    "    if (refresh) window.localStorage.setItem('grantflow:refresh-token', refresh)",
    "    window.localStorage.setItem('grantflow:access-expiry', String(accessExpiry))",
    "    if (activeProfile) window.localStorage.setItem('grantflow:active-profile-id', activeProfile)",
    '  }, {',
    '    access: accessToken,',
    '    refresh: refreshToken,',
    '    activeProfile: userPayload?.active_profile_id || userPayload?.activeProfileId || null,',
    '    accessExpiry: accessExpiryMs,',
    '  })',
  ),
)

replaceOnce(
  'same-origin API authorization and safe refresh',
  block(
    "  await context.route('**/*', async (route) => {",
    '    const request = route.request()',
    '    const method = request.method().toUpperCase()',
    "    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return route.continue()",
    '    let pathname = clean(request.url(), 300)',
    '    try { pathname = new URL(request.url()).pathname } catch { /* keep redacted fallback */ }',
    '    const redFlag = /submit|attest|authoriz|payment|billing|purchase|checkout|portal-sync\\/(?:write|sync)|auto-?submit|\\/approve|credential|vault/i.test(pathname)',
    '    blocked.push({ method, pathname, red_flag: redFlag })',
    "    return route.abort('blockedbyclient')",
    '  })',
  ),
  block(
    "  await context.route('**/*', async (route) => {",
    '    const request = route.request()',
    '    const method = request.method().toUpperCase()',
    '    let parsed = null',
    '    try { parsed = new URL(request.url()) } catch { /* keep null */ }',
    '    const pathname = parsed?.pathname || clean(request.url(), 300)',
    '    const sameOrigin = parsed?.origin === new URL(BASE_URL).origin',
    '    const headers = { ...request.headers() }',
    "    if (sameOrigin && pathname.startsWith('/api/') && accessToken) {",
    "      headers.authorization = 'Bearer ' + accessToken",
    '    }',
    "    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {",
    '      return route.continue({ headers })',
    '    }',
    '    // Session refresh is the only browser mutation allowed. It is scoped to the',
    '    // dedicated audit account and preserves the same read-only identity.',
    "    if (sameOrigin && method === 'POST' && pathname === '/api/auth/refresh') {",
    '      return route.continue({ headers })',
    '    }',
    '    const redFlag = /submit|attest|authoriz|payment|billing|purchase|checkout|portal-sync\\/(?:write|sync)|auto-?submit|\\/approve|credential|vault/i.test(pathname)',
    '    blocked.push({ method, pathname, red_flag: redFlag })',
    "    return route.abort('blockedbyclient')",
    '  })',
  ),
)

replaceOnce(
  'direct bearer token for browser API reads',
  block(
    '  const apiGet = async (pathname, profileId = null) => page.evaluate(async ({ pathname, profileId }) => {',
    '    try {',
    "      const token = window.localStorage.getItem('grantflow:access-token')",
    "      const headers = { Accept: 'application/json' }",
    '      if (token) headers.Authorization = `Bearer ${token}`',
  ),
  block(
    '  const apiGet = async (pathname, profileId = null) => page.evaluate(async ({ pathname, profileId, token }) => {',
    '    try {',
    "      const headers = { Accept: 'application/json' }",
    "      if (token) headers.Authorization = 'Bearer ' + token",
  ),
)

replaceOnce(
  'pass direct bearer token into browser API reads',
  '  }, { pathname, profileId })',
  '  }, { pathname, profileId, token: accessToken })',
)

replaceOnce(
  'pre-browser issued-token verification',
  block(
    '  refreshToken = auth.json.refreshToken',
    "  if (auth.json?.user?.is_admin === true || auth.json?.user?.role === 'admin') {",
  ),
  block(
    '  refreshToken = auth.json.refreshToken',
    "  const tokenIdentity = await requestJson('/api/auth/me', { token: accessToken, timeoutMs: 30_000 })",
    '  if (!tokenIdentity.ok) {',
    "    throw new Error('issued access token failed immediate identity verification (' + tokenIdentity.status + '): ' + (tokenIdentity.error || 'unknown'))",
    '  }',
    '  evidence.token_identity = {',
    '    status: tokenIdentity.status,',
    '    ok: true,',
    "    is_admin: tokenIdentity.json?.isAdmin === true || tokenIdentity.json?.is_admin === true || tokenIdentity.json?.role === 'admin',",
    '    accessible_profile_count: Number(tokenIdentity.json?.accessibleProfileCount ?? tokenIdentity.json?.accessible_profile_count ?? tokenIdentity.json?.profiles?.length ?? 0),',
    '  }',
    "  if (auth.json?.user?.is_admin === true || auth.json?.user?.role === 'admin') {",
  ),
)

replaceOnce(
  'pass session metadata to browser audit',
  '  evidence.browser = await runBrowserAudit(accessToken, refreshToken, auth.json.user)',
  '  evidence.browser = await runBrowserAudit(accessToken, refreshToken, auth.json.user, auth.json)',
)

fs.writeFileSync(file, source)
console.log('[final-audit-session] browser session bootstrap hardened')
