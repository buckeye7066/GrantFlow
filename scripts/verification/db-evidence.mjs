#!/usr/bin/env node
import Database from 'better-sqlite3'

const DB_PATH = process.env.VERIFY_DB_PATH || 'backend/data/grantflow.verify.db'

function dollars(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n)) return null
  return `$${(n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const db = new Database(DB_PATH)

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name)

const servicePrices = db
  .prepare(
    `
      SELECT sci.slug,
             sci.name,
             sci.pricing_model,
             sp.client_category,
             sp.milestone_phase,
             sp.amount_cents,
             sp.stripe_price_id
      FROM service_catalog_items sci
      JOIN service_prices sp ON sp.service_id = sci.id
      ORDER BY sci.slug,
               CASE sp.client_category
                 WHEN 'individual' THEN 1
                 WHEN 'small' THEN 2
                 WHEN 'mid' THEN 3
                 WHEN 'large' THEN 4
                 ELSE 9
               END,
               COALESCE(sp.milestone_phase, '')
    `,
  )
  .all()
  .map((r) => ({
    ...r,
    amount_usd: dollars(r.amount_cents),
  }))

const latestTerms = db
  .prepare('SELECT version, policy_snippet FROM service_terms ORDER BY created_at DESC LIMIT 1')
  .get()

console.log(
  JSON.stringify(
    {
      db_path: DB_PATH,
      table_count: tables.length,
      tables,
      service_prices_count: servicePrices.length,
      service_prices_sample: servicePrices.slice(0, 20),
      latest_terms: latestTerms || null,
    },
    null,
    2,
  ),
)

