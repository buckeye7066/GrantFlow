import { afterEach, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'

const origin = vi.hoisted(() => ({ calls: [] }))
vi.mock('node-fetch', () => ({ default: async (url, init) => {
  const headers = new Headers(init.headers)
  origin.calls.push({ url, headers, method: init.method, agent: init.agent, redirect: init.redirect })
  // Simulate the official target's observed document-request admission rule.
  const admitted = /Chrome\/\d+(?:\.\d+)+ Safari\/\d+(?:\.\d+)+/.test(headers.get('user-agent') || '') &&
    headers.get('sec-fetch-mode') === 'cors' && headers.get('accept-language') === 'en-US,en;q=0.9' &&
    (headers.get('accept') || '').includes('application/xhtml+xml')
  return new Response(null, { status: admitted ? 200 : 403 })
} }))
import { checkUrl, verifyOpportunityLinkNow } from '../services/linkVerificationService.js'

const previous = process.env.CRAWLER_BROWSER_HEADERS
afterEach(() => {
  if (previous === undefined) delete process.env.CRAWLER_BROWSER_HEADERS
  else process.env.CRAWLER_BROWSER_HEADERS = previous
  origin.calls.length = 0
})

it('uses complete browser document headers through the pinned verifier transport', async () => {
  process.env.CRAWLER_BROWSER_HEADERS = '1'
  const result = await checkUrl('https://8.8.8.8/disability')
  expect(result).toMatchObject({ status: 'ok', code: 200 })
  expect(origin.calls[0].redirect).toBe('manual')
  expect(origin.calls[0].agent.options.lookup).toBeTypeOf('function')
})

it('a positive target probe restores a prior retryable 403 quarantine', async () => {
  process.env.CRAWLER_BROWSER_HEADERS = '1'
  const db = new Database(':memory:')
  db.dialect = 'sqlite'
  try {
    db.exec(`CREATE TABLE funding_opportunities (
      id TEXT PRIMARY KEY, application_url TEXT, source_url TEXT, opportunity_kind TEXT,
      result_kind TEXT, opportunity_type TEXT, type TEXT, status TEXT, deadline TEXT, deadline_type TEXT,
      link_status TEXT, verification_error TEXT, is_hidden INTEGER, is_active INTEGER,
      last_verified_at TEXT, link_status_code INTEGER, verification_method TEXT, verified_by TEXT,
      final_url TEXT, http_status INTEGER);
      INSERT INTO funding_opportunities (id,application_url,opportunity_kind,status,link_status,verification_error,is_hidden,is_active)
      VALUES ('ssa','https://8.8.8.8/disability','benefit','active','broken','HTTP 403',1,1);`)
    expect(await verifyOpportunityLinkNow(db, { id: 'ssa' })).toMatchObject({ status: 'ok', code: 200, updated: true })
    expect(db.prepare('SELECT link_status,is_hidden,is_active,verification_error FROM funding_opportunities').get())
      .toEqual({ link_status: 'ok', is_hidden: 0, is_active: 1, verification_error: null })
  } finally { db.close() }
})

it('honors the browser-header kill switch without treating a rejected request as success', async () => {
  process.env.CRAWLER_BROWSER_HEADERS = '0'
  expect(await checkUrl('https://8.8.8.8/disability')).toMatchObject({ status: 'broken', code: 403 })
  expect(origin.calls.every(call => call.headers.get('user-agent').includes('GrantFlowLinkVerifier'))).toBe(true)
})
