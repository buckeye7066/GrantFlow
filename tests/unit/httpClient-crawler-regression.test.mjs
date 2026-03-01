import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CRAWLERS_DIR = path.join(__dirname, '../../backend/services/crawlers')

/**
 * REGRESSION TEST: getWithRetry always overrides method to GET.
 *
 * httpClient.js:
 *   export async function getWithRetry(url, config = {}, options = {}) {
 *     return await requestWithRetry({ ...config, method: 'GET', url }, options)
 *   }
 *
 * Because { ...config, method: 'GET' } puts method:'GET' AFTER the spread,
 * any method:'POST' in config is SILENTLY overridden. This broke every
 * Grants.gov call in localFundingCrawler and studentGrantsCrawler because
 * search2 is a POST-only endpoint.
 *
 * This test ensures no crawler file ever calls getWithRetry in a context
 * where the Grants.gov POST endpoint is being hit.
 */
test('REGRESSION: No crawler uses getWithRetry for Grants.gov POST endpoints', () => {
  const crawlerFiles = fs.readdirSync(CRAWLERS_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'httpClient.js')

  assert.ok(crawlerFiles.length > 0, 'should find crawler files')

  const violations = []

  for (const file of crawlerFiles) {
    const content = fs.readFileSync(path.join(CRAWLERS_DIR, file), 'utf8')
    const lines = content.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      // Check for getWithRetry calls that are near grants.gov URLs
      if (line.includes('getWithRetry') && !line.includes('import')) {
        // Look at surrounding 5 lines for grants.gov references
        const context = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n')
        if (/grants\.gov\/v\d+\/api\/search/i.test(context)) {
          violations.push({
            file,
            line: i + 1,
            text: line.trim(),
            explanation: 'getWithRetry overrides method to GET; Grants.gov search2 requires POST. Use postWithRetry instead.',
          })
        }
      }

      // Also catch getWithRetry with method:'POST' anywhere (the config will be ignored)
      if (line.includes('getWithRetry') && !line.includes('import')) {
        const nearbyLines = lines.slice(Math.max(0, i - 1), Math.min(lines.length, i + 5)).join(' ')
        if (/method\s*:\s*['"]POST['"]/i.test(nearbyLines)) {
          violations.push({
            file,
            line: i + 1,
            text: line.trim(),
            explanation: 'getWithRetry with method:"POST" in config is a bug — method is always overridden to GET.',
          })
        }
      }
    }
  }

  if (violations.length > 0) {
    const report = violations
      .map((v) => `  ${v.file}:${v.line} — ${v.explanation}\n    ${v.text}`)
      .join('\n')
    assert.fail(
      `Found ${violations.length} crawler(s) using getWithRetry for POST endpoints:\n${report}\n\n` +
        'Fix: change getWithRetry → postWithRetry(url, payload, config, options)',
    )
  }
})

test('REGRESSION: All crawlers that import getWithRetry also import postWithRetry', () => {
  const crawlerFiles = fs.readdirSync(CRAWLERS_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'httpClient.js')

  const violations = []

  for (const file of crawlerFiles) {
    const content = fs.readFileSync(path.join(CRAWLERS_DIR, file), 'utf8')

    // Check if file calls Grants.gov search2 endpoint
    if (/grants\.gov\/v\d+\/api\/search/i.test(content)) {
      // Must have postWithRetry imported (or use axios.post directly)
      const hasPost = content.includes('postWithRetry') || content.includes('axios.post')
      if (!hasPost) {
        violations.push({
          file,
          explanation: 'File hits Grants.gov search2 (POST-only) but has no postWithRetry or axios.post import',
        })
      }
    }
  }

  if (violations.length > 0) {
    const report = violations.map((v) => `  ${v.file}: ${v.explanation}`).join('\n')
    assert.fail(`Crawlers missing POST capability for Grants.gov:\n${report}`)
  }
})

test('httpClient: getWithRetry always uses GET method (by design)', () => {
  // This test documents the behavior that caused the bug:
  // getWithRetry spreads config BEFORE setting method:'GET', so any method in config is overridden.
  const httpClientPath = path.join(CRAWLERS_DIR, 'httpClient.js')
  const content = fs.readFileSync(httpClientPath, 'utf8')

  // Verify the function signature pattern that causes the override
  assert.ok(
    content.includes("{ ...config, method: 'GET'"),
    'getWithRetry must spread config before method to ensure GET is always used',
  )
  assert.ok(
    content.includes("{ ...config, method: 'POST'"),
    'postWithRetry must spread config before method to ensure POST is always used',
  )
})

test('STATE_PORTALS coverage: WV must be present (regression for WV profiles)', () => {
  const govCrawlerPath = path.join(CRAWLERS_DIR, 'governmentFundingCrawler.js')
  const content = fs.readFileSync(govCrawlerPath, 'utf8')

  // Extract state codes from STATE_PORTALS
  const stateMatches = content.match(/^\s+([A-Z]{2}):\s*\{/gm) || []
  const stateCodes = stateMatches.map((m) => m.trim().split(':')[0].trim())

  assert.ok(stateCodes.includes('WV'), 'STATE_PORTALS must include WV')
  assert.ok(stateCodes.includes('OH'), 'STATE_PORTALS must include OH')
  assert.ok(stateCodes.includes('TN'), 'STATE_PORTALS must include TN')
  assert.ok(stateCodes.length >= 20, `STATE_PORTALS should cover 20+ states, got ${stateCodes.length}`)
})
