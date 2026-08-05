import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { joinAppPath, normalizeBasePath } from '../../scripts/smoke-prod-readonly.mjs'

const read = (path) => fs.readFileSync(path, 'utf8')

test('public acquisition metadata names the route that production actually serves', () => {
  const html = read('index.html')
  const robots = read('public/robots.txt')
  const sitemap = read('public/sitemap-grantflow.xml')

  assert.match(html, /rel="canonical" href="https:\/\/app\.axiombiolabs\.org\/welcome"/)
  assert.match(html, /property="og:url" content="https:\/\/app\.axiombiolabs\.org\/welcome"/)
  assert.doesNotMatch(html, /axiombiolabs\.org\/grantflow\/(?:welcome|assets)/)
  assert.match(robots, /^Allow: \/welcome$/m)
  assert.match(robots, /^Disallow: \/$/m)
  assert.match(sitemap, /<loc>https:\/\/app\.axiombiolabs\.org\/welcome<\/loc>/)
  assert.doesNotMatch(sitemap, /\/grantflow\//)
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
