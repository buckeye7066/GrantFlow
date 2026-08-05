import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { joinAppPath, normalizeBasePath } from '../../scripts/smoke-prod-readonly.mjs'
import { spaEntryDocument } from '../../backend/utils/spaEntryDocument.js'

const read = (path) => fs.readFileSync(path, 'utf8')

test('public acquisition metadata names the route that production actually serves', () => {
  const html = read('welcome.html')
  const privacyHtml = read('privacy.html')
  const protectedHtml = read('index.html')
  const robots = read('public/robots.txt')
  const sitemap = read('public/sitemap-grantflow.xml')

  assert.match(html, /rel="canonical" href="https:\/\/app\.axiombiolabs\.org\/welcome"/)
  assert.match(html, /property="og:url" content="https:\/\/app\.axiombiolabs\.org\/welcome"/)
  assert.doesNotMatch(html, /axiombiolabs\.org\/grantflow\/(?:welcome|assets)/)
  assert.match(privacyHtml, /rel="canonical" href="https:\/\/app\.axiombiolabs\.org\/privacy"/)
  assert.match(privacyHtml, /property="og:url" content="https:\/\/app\.axiombiolabs\.org\/privacy"/)
  assert.doesNotMatch(privacyHtml, /rel="canonical" href="https:\/\/app\.axiombiolabs\.org\/welcome"/)
  assert.match(protectedHtml, /name="robots" content="noindex,nofollow,noarchive"/)
  assert.doesNotMatch(protectedHtml, /rel="canonical"/)
  assert.doesNotMatch(protectedHtml, /property="og:url"/)
  assert.match(robots, /^Allow: \/welcome$/m)
  assert.match(robots, /^Allow: \/privacy$/m)
  assert.match(robots, /^Disallow: \/$/m)
  assert.match(sitemap, /<loc>https:\/\/app\.axiombiolabs\.org\/welcome<\/loc>/)
  assert.match(sitemap, /<loc>https:\/\/app\.axiombiolabs\.org\/privacy<\/loc>/)
  assert.doesNotMatch(sitemap, /\/grantflow\//)
})

test('Vercel serves public sitemap routes from distinct HTML documents', () => {
  const vercel = JSON.parse(read('vercel.json'))
  const rewrites = new Map((vercel.rewrites || []).map((entry) => [entry.source, entry.destination]))

  assert.equal(rewrites.get('/welcome'), '/welcome.html')
  assert.equal(rewrites.get('/privacy'), '/privacy.html')
  assert.equal(rewrites.get('/((?!assets/).*)'), '/index.html')
  assert.notEqual(rewrites.get('/welcome'), rewrites.get('/privacy'))
})

test('legacy prefixed public URLs redirect to canonical root routes', () => {
  const vercel = JSON.parse(read('vercel.json'))
  const redirects = new Map((vercel.redirects || []).map((entry) => [entry.source, entry]))

  assert.deepEqual(redirects.get('/grantflow/welcome'), {
    source: '/grantflow/welcome',
    destination: '/welcome',
    permanent: true,
  })
  assert.deepEqual(redirects.get('/grantflow/privacy'), {
    source: '/grantflow/privacy',
    destination: '/privacy',
    permanent: true,
  })
})

test('standalone SPA fallback serves public documents for root and prefixed mounts', () => {
  assert.equal(spaEntryDocument('/welcome', '/'), 'welcome.html')
  assert.equal(spaEntryDocument('/privacy', '/'), 'privacy.html')
  assert.equal(spaEntryDocument('/grantflow/welcome', '/'), 'welcome.html')
  assert.equal(spaEntryDocument('/grantflow/privacy', '/'), 'privacy.html')
  assert.equal(spaEntryDocument('/grantflow/welcome', '/grantflow'), 'welcome.html')
  assert.equal(spaEntryDocument('/grantflow/privacy', '/grantflow/'), 'privacy.html')
  assert.equal(spaEntryDocument('/grantflow/Dashboard', '/'), 'index.html')
})

test('production smoke builds root-mounted URLs without changing the hostname', () => {
  assert.equal(normalizeBasePath('/'), '/')
  assert.equal(joinAppPath('/', 'welcome'), '/welcome')
  assert.equal(joinAppPath('/', '/api/health'), '/api/health')
  assert.equal(joinAppPath('/grantflow/', 'welcome'), '/grantflow/welcome')

  const landing = new URL(joinAppPath('/', 'welcome'), 'https://app.axiombiolabs.org/').toString()
  assert.equal(landing, 'https://app.axiombiolabs.org/welcome')
})

test('landing copy does not promise eligibility, awards, or autonomous submission', () => {
  const landing = read('src/pages/Landing.jsx')

  for (const unsupported of [
    /money with your name on it/i,
    /actually qualify/i,
    /Hamilton applies for you/i,
    /found for you/i,
    /funding you(?:'|’)re owed/i,
  ]) {
    assert.doesNotMatch(landing, unsupported)
  }
  assert.match(landing, /why each result may fit/i)
  assert.match(landing, /only confirmed evidence is treated as an external submission/i)
})
