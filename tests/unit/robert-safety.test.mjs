import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getRobertConfig,
  isPlaceholderUrl,
  isSearchEngineUrl,
  isPlaceholderText,
  isProbableLoanProduct,
  isProbableMatchingFunds,
  isExpiredDeadline,
  maskSecrets,
} from '../../backend/services/robert/robertSafety.js'

describe('robertSafety — defaults are SAFEST possible', () => {
  it('robert is disabled by default', () => {
    const old = { ...process.env }
    delete process.env.ROBERT_ENABLED
    const cfg = getRobertConfig()
    assert.equal(cfg.enabled, false, 'ROBERT_ENABLED defaults to false')
    assert.equal(cfg.allowLiveWeb, false, 'live web is OFF by default')
    assert.equal(cfg.allowSourceDiscovery, false)
    assert.equal(cfg.autoIngestVerified, false)
    assert.equal(cfg.requireRealApplicationUrl, true)
    assert.equal(cfg.respectRobots, true)
    assert.equal(cfg.failOpen, false)
    process.env = old
  })

  it('observe is the default mode', () => {
    delete process.env.ROBERT_MODE
    const cfg = getRobertConfig()
    assert.equal(cfg.mode, 'observe')
  })
})

describe('robertSafety — URL filters', () => {
  it('rejects placeholder URLs (example/localhost/test/yourcompany)', () => {
    assert.equal(isPlaceholderUrl('https://example.com/grant'), true)
    assert.equal(isPlaceholderUrl('https://localhost/grant'), true)
    assert.equal(isPlaceholderUrl('https://yourdomain.com/x'), true)
    assert.equal(isPlaceholderUrl('https://www.grants.gov/'), false)
  })

  it('rejects search-engine URLs', () => {
    assert.equal(isSearchEngineUrl('https://www.google.com/search?q=grants'), true)
    assert.equal(isSearchEngineUrl('https://duckduckgo.com/?q=foo'), true)
    assert.equal(isSearchEngineUrl('https://bing.com/search?q=fire+grants'), true)
    assert.equal(isSearchEngineUrl('https://www.fema.gov/grants'), false)
  })

  it('flags placeholder text', () => {
    assert.equal(isPlaceholderText('Lorem ipsum dolor sit amet'), true)
    assert.equal(isPlaceholderText('A real description of a real grant.'), false)
  })

  it('detects loan-like content', () => {
    assert.equal(isProbableLoanProduct({ title: 'SBA Microloan Program', description: 'Borrow with low interest.' }), true)
    assert.equal(isProbableLoanProduct({ title: 'Roof Repair Grant', description: 'Free funds, no repayment.' }), false)
  })

  it('detects matching-fund requirements', () => {
    assert.equal(isProbableMatchingFunds({ description: 'Requires a 50% match from local sources.' }), true)
    assert.equal(isProbableMatchingFunds({ description: 'Full grant. The applicant retains 100% of awarded funds.' }), false)
  })

  it('detects expired deadlines but allows rolling/unknown', () => {
    assert.equal(isExpiredDeadline('2020-01-01', 'fixed'), true)
    assert.equal(isExpiredDeadline('2099-01-01', 'fixed'), false)
    assert.equal(isExpiredDeadline('2020-01-01', 'rolling'), false)
    assert.equal(isExpiredDeadline(null, 'fixed'), false)
  })
})

describe('robertSafety — secret masking', () => {
  it('redacts API keys in env-style strings', () => {
    const masked = maskSecrets('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx hello')
    assert.match(masked, /OPENAI_API_KEY=\*\*\*REDACTED\*\*\*/)
  })

  it('redacts Authorization Bearer tokens cleanly (no extra =)', () => {
    const masked = maskSecrets('Authorization: Bearer abcdef.ghijkl_mnopqr')
    assert.match(masked, /^Authorization: Bearer \*\*\*REDACTED\*\*\*$/)
  })

  it('redacts known prefixed tokens', () => {
    const masked = maskSecrets('use this key sk-ant-1234567890abcdefghij please')
    assert.match(masked, /use this key \*\*\*REDACTED\*\*\* please/)
  })

  it('handles objects', () => {
    const out = maskSecrets({ note: 'Authorization: Bearer abcdef1234567890XYZ' })
    assert.match(out.note, /Bearer \*\*\*REDACTED\*\*\*/)
  })

  it('truncates very long strings', () => {
    const long = 'a'.repeat(200_000)
    const masked = maskSecrets(long)
    assert.ok(masked.length < 200_000)
    assert.match(masked, /truncated by Robert/)
  })
})
