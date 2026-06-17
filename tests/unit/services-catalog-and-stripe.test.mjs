import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Stripe from 'stripe'

import { parsePaymentSheetExtract, loadPaymentSheetExtractFromDisk } from '../../backend/services/serviceCatalogExtractParser.js'
import { roundBillableMinutes } from '../../backend/services/hourlyRounding.js'

function startServer(extraEnv = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'grantflow-services-'))
  const dbPath = path.join(tmp, 'test.db')

  const child = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: '0',
      DB_PROVIDER: 'sqlite',
      SQLITE_DB_PATH: dbPath,
      DB_AUTO_MIGRATE: 'true',
      AUTH_JWT_SECRET: 'test-secret',
      ADMIN_TOKEN: 'test-admin-token',
      AUTH_PUBLIC_URL: 'http://localhost:5173/grantflow',
      STRIPE_SECRET_KEY: 'sk_test_123',
      STRIPE_WEBHOOK_SECRET: 'whsec_test_123',
      STRIPE_MOCK: 'true',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  let exitCode = null
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  child.on('exit', (code) => {
    exitCode = code
  })

  const ready = new Promise((resolve, reject) => {
    let resolved = false
    const timeout = setTimeout(() => {
      if (resolved) return
      try { child.kill('SIGTERM') } catch {}
      reject(new Error(`server did not become ready\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    }, 60_000)

    child.stdout.on('data', (chunk) => {
      if (resolved) return
      const match = String(stdout + chunk).match(/\[Server\](?:\u001B\[[0-?]*[ -/]*[@-~]|\s)+Ready on port\s+(\d+)/)
      if (match) {
        resolved = true
        clearTimeout(timeout)
        resolve({ port: Number(match[1]) })
      }
    })

    child.on('exit', (code) => {
      if (resolved) return
      clearTimeout(timeout)
      reject(new Error(`server exited before ready (code=${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })

  async function stop() {
    if (child.killed) return
    try { child.kill('SIGTERM') } catch {}
    await new Promise((resolve) => child.once('exit', resolve))
  }

  function getLogs() {
    return { stdout, stderr, exitCode }
  }

  return { ready, stop, getLogs }
}

async function fetchJson(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

test('service catalog extract parser: parses 2026-06-15 menu and canonical slugs', () => {
  const md = loadPaymentSheetExtractFromDisk()
  const parsed = parsePaymentSheetExtract(md)
  assert.equal(parsed.version, '2026-06-15')
  assert.equal(parsed.services.length, 12)
  const slugs = new Set(parsed.services.map((s) => s.slug))
  // Canonical slugs from serviceSlugAliases.CANONICAL_SLUGS — bare names,
  // no inline price-range qualifiers in the slug.
  for (const expected of [
    'quick-eligibility-scan',
    'comprehensive-funding-dossier',
    'application-strategy-session',
    'micro-grant-application',
    'standard-foundation-application',
    'complex-federal-application',
    'transfer-scholarship-pack',
    'editing-and-redraft-service',
    'budget-and-logic-model-development',
    'compliance-reporting-and-management',
    'grant-calendar-setup-and-management',
    'hourly-consultation-and-advisory',
  ]) {
    assert.ok(slugs.has(expected), `missing canonical slug: ${expected}`)
  }
})

test('hourly rounding rules: 15-minute minimum + 6-minute increment', () => {
  assert.equal(roundBillableMinutes(1), 18)
  assert.equal(roundBillableMinutes(14), 18)
  assert.equal(roundBillableMinutes(15), 18)
  assert.equal(roundBillableMinutes(16), 18)
  assert.equal(roundBillableMinutes(17), 18)
  assert.equal(roundBillableMinutes(20), 24)
  assert.equal(roundBillableMinutes(21), 24)
})

test('checkout endpoint rejects without agreement and rejects missing stripe mapping', async () => {
  const srv = startServer()
  const { port } = await srv.ready
  try {
    // Catalog should be seeded on-demand
    const catalogRes = await fetchJson(`http://127.0.0.1:${port}/api/services/catalog`)
    assert.equal(catalogRes.status, 200)
    const svc = catalogRes.json.catalog.find((s) => s.pricing_model === 'one_time')
    assert.ok(svc, 'expected at least one one_time service')

    const purchaseRes = await fetchJson(`http://127.0.0.1:${port}/api/services/purchases`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ service_slug: svc.slug, client_category: 'individual' }),
    })
    assert.equal(purchaseRes.status, 201)
    const purchaseId = purchaseRes.json.purchase.id

    const noAgree = await fetchJson(`http://127.0.0.1:${port}/api/stripe/checkout/service`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ purchase_id: purchaseId, agree: false }),
    })
    assert.equal(noAgree.status, 400)
    assert.equal(noAgree.json.code, 'TERMS_REQUIRED')

    const missingMap = await fetchJson(`http://127.0.0.1:${port}/api/stripe/checkout/service`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ purchase_id: purchaseId, agree: true }),
    })
    assert.equal(missingMap.status, 409)
    assert.equal(missingMap.json.code, 'STRIPE_PRICE_MISSING')
  } finally {
    await srv.stop()
  }
})

test('milestone gating: cannot pay draft before kickoff', async () => {
  const srv = startServer()
  const { port } = await srv.ready
  try {
    const catalogRes = await fetchJson(`http://127.0.0.1:${port}/api/services/catalog`)
    const milestoneSvc = catalogRes.json.catalog.find((s) => s.pricing_model === 'milestone')
    assert.ok(milestoneSvc, 'expected milestone service')

    const purchaseRes = await fetchJson(`http://127.0.0.1:${port}/api/services/purchases`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ service_slug: milestoneSvc.slug, client_category: 'individual' }),
    })
    assert.equal(purchaseRes.status, 201)
    const purchaseId = purchaseRes.json.purchase.id

    const outOfOrder = await fetchJson(`http://127.0.0.1:${port}/api/stripe/checkout/service`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ purchase_id: purchaseId, milestone_phase: 'draft', agree: true }),
    })
    assert.equal(outOfOrder.status, 409)
    assert.equal(outOfOrder.json.code, 'MILESTONE_ORDER')
    assert.equal(outOfOrder.json.allowed_next_phase, 'kickoff')
  } finally {
    await srv.stop()
  }
})

test('webhook signature verification enforced and updates purchase status to paid', async () => {
  // For this test we must NOT set STRIPE_MOCK for webhook verification; it doesn't affect signature verification,
  // but we keep it true to avoid any accidental network use in other code paths.
  const srv = startServer()
  const { port } = await srv.ready

  try {
    // Map one price row for a one_time service
    const adminCatalog = await fetchJson(`http://127.0.0.1:${port}/api/admin/service-catalog/catalog`, {
      headers: { Authorization: 'Bearer test-admin-token' },
    })
    assert.equal(adminCatalog.status, 200)
    const svc = adminCatalog.json.catalog.find((s) => s.pricing_model === 'one_time')
    assert.ok(svc)
    const priceRow = svc.prices.find((p) => p.client_category === 'individual' && p.milestone_phase == null)
    assert.ok(priceRow)

    const mapRes = await fetchJson(`http://127.0.0.1:${port}/api/admin/service-catalog/price/${priceRow.id}/map-stripe`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ stripe_price_id: 'price_test123' }),
    })
    assert.equal(mapRes.status, 200)
    assert.equal(mapRes.json.ok, true)

    // Create purchase
    const purchaseRes = await fetchJson(`http://127.0.0.1:${port}/api/services/purchases`, {
      method: 'POST',
      headers: { Authorization: 'Bearer test-admin-token' },
      body: JSON.stringify({ service_slug: svc.slug, client_category: 'individual' }),
    })
    assert.equal(purchaseRes.status, 201)
    const purchaseId = purchaseRes.json.purchase.id

    // Start checkout (mock) - should succeed and persist session id
    let checkoutRes = null
    try {
      checkoutRes = await fetchJson(`http://127.0.0.1:${port}/api/stripe/checkout/service`, {
        method: 'POST',
        headers: { Authorization: 'Bearer test-admin-token' },
        body: JSON.stringify({ purchase_id: purchaseId, agree: true }),
      })
    } catch (error) {
      const logs = srv.getLogs()
      throw new Error(
        `checkout request failed: ${error?.message || String(error)}\nexitCode=${logs.exitCode}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`,
      )
    }
    assert.equal(checkoutRes.status, 200)
    assert.ok(checkoutRes.json.checkout_session_id)

    // Send a signed webhook event marking it complete
    const stripe = new Stripe('sk_test_123', { telemetry: false })
    const payloadObj = {
      id: 'evt_test_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: checkoutRes.json.checkout_session_id,
          payment_intent: 'pi_test_123',
          metadata: {
            kind: 'service_purchase',
            purchase_id: purchaseId,
            service_slug: svc.slug,
            client_category: 'individual',
            pricing_model: 'one_time',
          },
        },
      },
    }
    const payload = JSON.stringify(payloadObj)
    const signature = stripe.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_test_123',
    })

    let webhookRes = null
    try {
      webhookRes = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Stripe-Signature': signature,
        },
        body: payload,
      })
    } catch (error) {
      const logs = srv.getLogs()
      throw new Error(
        `webhook request failed: ${error?.message || String(error)}\nexitCode=${logs.exitCode}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`,
      )
    }
    assert.equal(webhookRes.status, 200)
    const body = await webhookRes.json()
    assert.equal(body.ok, true)

    // Purchase should now be paid
    let purchases = null
    try {
      purchases = await fetchJson(`http://127.0.0.1:${port}/api/services/purchases`, {
        headers: { Authorization: 'Bearer test-admin-token' },
      })
    } catch (error) {
      const logs = srv.getLogs()
      throw new Error(
        `purchases fetch failed: ${error?.message || String(error)}\nexitCode=${logs.exitCode}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`,
      )
    }
    const updated = purchases.json.purchases.find((p) => p.id === purchaseId)
    assert.ok(updated)
    assert.equal(updated.status, 'paid')
    assert.equal(updated.stripe_payment_intent_id, 'pi_test_123')
  } finally {
    await srv.stop()
  }
})

