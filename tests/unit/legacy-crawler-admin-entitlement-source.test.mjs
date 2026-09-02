import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(
  new URL('../../backend/routes/legacyFunctions.js', import.meta.url),
  'utf8',
)

test('global legacy crawlers require DB-backed admin authority', () => {
  assert.match(source, /function requireAdminCrawlerUser\(req, res\)/)
  assert.match(source, /req\.ctx\?\.isAdmin !== true/)
  assert.doesNotMatch(source, /TIER_CAPABILITIES\.CRAWLING/)

  for (const route of ['/crawlGrantsGov', '/crawlBenefitsGov']) {
    const start = source.indexOf(`router.post('${route}'`)
    const nextRoute = source.indexOf('router.', start + 1)
    const body = source.slice(start, nextRoute > start ? nextRoute : undefined)
    assert.ok(start >= 0, `${route} must remain mounted`)
    assert.match(body, /requireAdminCrawlerUser\(req, res\)/)
  }
})
