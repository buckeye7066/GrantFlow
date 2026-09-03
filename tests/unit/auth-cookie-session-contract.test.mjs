import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '../..')

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.(?:js|jsx|ts|tsx)$/.test(entry.name) && statSync(absolute).isFile() ? [absolute] : []
  })
}

test('browser code never reads or writes access/refresh tokens in localStorage', () => {
  const forbidden = []
  for (const file of sourceFiles(path.join(repoRoot, 'src'))) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/localStorage\.(?:getItem|setItem)\(\s*['"]grantflow:(?:access-token|refresh-token)['"]/g)) {
      forbidden.push(`${path.relative(repoRoot, file)}:${source.slice(0, match.index).split('\n').length}`)
    }
  }
  assert.deepEqual(forbidden, [])
})

test('legacy localStorage sessions deliberately force one re-auth without adopting their tokens', () => {
  const client = readFileSync(path.join(repoRoot, 'src/api/client.js'), 'utf8')
  const store = readFileSync(path.join(repoRoot, 'src/stores/authStore.js'), 'utf8')
  const migrationSurface = `${client}\n${store}`

  for (const key of ['grantflow:access-token', 'grantflow:refresh-token']) {
    assert.match(migrationSurface, new RegExp(`(?:localStorage\\.removeItem|safeLocalStorageRemove)\\(['\"]${key}['\"]\\)`))
    assert.doesNotMatch(migrationSurface, new RegExp(`localStorage\\.getItem\\(['\"]${key}['\"]\\)`))
  }
  assert.match(store, /credentials from older builds are deleted without/)
  assert.match(store, /reading or adopting them/)
})

test('a missing cookie session clears scheduled client authentication state', () => {
  const store = readFileSync(path.join(repoRoot, 'src/stores/authStore.js'), 'utf8')
  assert.match(
    store,
    /const response = await client\.refreshTokens\(\)[\s\S]*?if \(!response\) \{[\s\S]*?get\(\)\.clearState\(\)[\s\S]*?return null/,
  )
})

test('backend refresh contract is HttpOnly, host-only, path-scoped, and cookie-only', () => {
  const source = readFileSync(path.join(repoRoot, 'backend/routes/auth.js'), 'utf8')
  assert.match(source, /httpOnly:\s*true/)
  assert.match(source, /secure:\s*process\.env\.NODE_ENV === 'production'/)
  assert.match(source, /sameSite:\s*nativeOrigin \? 'none' : 'strict'/)
  assert.match(source, /new Set\(\['\/api\/auth'\]\)/)
  assert.doesNotMatch(source, /domain\s*:/i)
  assert.match(source, /refresh_token_body_not_allowed/)
  assert.match(source, /requireRefreshRequestIntegrity/)
  assert.match(source, /if \(!refreshToken\)[\s\S]*?res\.status\(204\)\.send\(\)/)
  assert.doesNotMatch(source, /refreshToken:\s*session\.refreshToken/)
})

test('OAuth callback uses a one-time handoff and never places tokens in the URL', () => {
  const backend = readFileSync(path.join(repoRoot, 'backend/routes/auth.js'), 'utf8')
  const frontend = readFileSync(path.join(repoRoot, 'src/pages/AuthCallback.jsx'), 'utf8')
  assert.match(backend, /createOAuthSessionHandoff/)
  assert.match(backend, /completedRedirect\.hash = new URLSearchParams\(\{ handoff \}\)/)
  assert.doesNotMatch(frontend, /params\.get\(['"](?:accessToken|refreshToken)['"]\)/)
  assert.match(frontend, /completeOAuthSession\(handoff\)/)
})
