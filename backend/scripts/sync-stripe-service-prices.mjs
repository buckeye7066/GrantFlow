#!/usr/bin/env node
// Run in the configured GrantFlow environment. Defaults to a read-only plan.
import Stripe from 'stripe'
import { db } from '../db/index.js'
import { syncStripeServicePrices } from '../services/pricing/stripeServicePriceSync.js'

try {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported; omit it for a dry run')
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required')
  if (/^(1|true|yes|y|on)$/i.test(process.env.STRIPE_MOCK || '')) throw new Error('Refusing catalog configuration while STRIPE_MOCK is enabled')
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { telemetry: false, timeout: 15000, maxNetworkRetries: 1 })
  const report = await syncStripeServicePrices({ db, stripe, apply: args.includes('--apply') })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  // Stripe errors can echo credential fragments. Never print provider messages.
  console.error(JSON.stringify(error?.type?.startsWith('Stripe')
    ? { error: error.type, code: error.code, status: error.statusCode }
    : { error: error?.message || 'service_price_sync_failed' }))
  process.exitCode = 1
} finally { await db.close() }
