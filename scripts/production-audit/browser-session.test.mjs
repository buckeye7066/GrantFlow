import assert from 'node:assert/strict'
import test from 'node:test'
import http from 'node:http'
import { once } from 'node:events'
import { chromium } from 'playwright'
import * as audit from './app-audit.mjs'
test('read-only portal authentication survives visual page navigation without exporting a credential', async () => {
  assert.equal(typeof audit.createAuditPages, 'function', 'API and visual navigation must use distinct page lifetimes')
  assert.equal(typeof audit.postAuditRead, 'function')
  const browser = await chromium.launch({ headless: true })
  let posted = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      posted++
      assert.equal(req.headers.authorization, 'Bearer local-synthetic-audit-session')
      assert.equal(req.headers['x-profile-id'], 'synthetic-profile')
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"read":{"fields_found":0}}'); return
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Local audit navigation test</title>')
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const context = await browser.newContext()
    const { page, capturePage } = await audit.createAuditPages(context)
    assert.notEqual(page, capturePage)
    const base = `http://127.0.0.1:${server.address().port}`
    await page.goto(base)
    await page.evaluate(() => { globalThis.__GRANTFLOW_AUDIT_ACCESS_TOKEN__ = 'local-synthetic-audit-session' })
    await capturePage.goto(base + '/FundingResults')
    await capturePage.goto(base + '/HamiltonProcessing')
    assert.equal(await capturePage.evaluate(() => typeof globalThis.__GRANTFLOW_AUDIT_ACCESS_TOKEN__), 'undefined')
    const result = await audit.postAuditRead(page, '/api/hamilton/portal-sync/read', { profileId: 'synthetic-profile', portalHost: 'portal.invalid' }, 'synthetic-profile')
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.equal(posted, 1)
    assert.doesNotMatch(JSON.stringify(result), /local-synthetic-audit-session/)
    await assert.rejects(audit.postAuditRead(page, '/api/hamilton/portal-sync/write', {}, 'synthetic-profile'), /read-only/)
    await assert.rejects(audit.postAuditRead(page, 'https://other.invalid/api/hamilton/portal-sync/read', {}, 'synthetic-profile'), /read-only/)
    assert.equal(posted, 1)
  } finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
