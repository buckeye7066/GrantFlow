#!/usr/bin/env node
/**
 * Verify every active GrantFlow service_prices row against Stripe.
 *
 * Usage:
 *   node scripts/verify-stripe-price-mapping.mjs
 *
 * Required environment:
 *   - DB_PROVIDER + connection vars (sqlite or postgres) so the script
 *     can open the same database the API uses.
 *   - STRIPE_SECRET_KEY (live verification) OR STRIPE_MOCK=true
 *     (deterministic mock; no network calls).
 *
 * Exit codes:
 *   0 — every row is mapped and matches Stripe.
 *   1 — at least one row is missing a mapping, mismatched, inactive, or
 *       failed to fetch from Stripe.
 *
 * The script prints a JSON report to stdout. CI can pipe this into
 * `docs/_readiness_logs/` and Sam will treat any non-ok status as a
 * critical finding (`stripe_price_drift`).
 */

import process from 'node:process'

import { getDb } from '../backend/db/index.js'
import { ensureServiceCatalogSchema } from '../backend/services/serviceCatalogStore.js'
import { verifyStripePriceMapping } from '../backend/services/pricing/stripePriceVerifier.js'

async function main() {
  const db = await getDb()
  await ensureServiceCatalogSchema(db)
  const report = await verifyStripePriceMapping(db)

  const summary = {
    ok: report.ok,
    catalog_check: 'service_prices',
    checked: report.checked,
    missing_mapping_count: report.missing_mapping_count,
    mismatch_count: report.mismatch_count,
    inactive_count: report.inactive_count,
    failing_rows: report.rows.filter((r) => r.status !== 'ok'),
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

  if (!report.ok) {
    process.stderr.write(
      `verify-stripe-price-mapping: FAILED (missing=${report.missing_mapping_count}, ` +
        `mismatch=${report.mismatch_count}, inactive=${report.inactive_count})\n`,
    )
    process.exit(1)
  }
}

main().catch((err) => {
  process.stderr.write(
    `verify-stripe-price-mapping: error ${err?.message || String(err)}\n${err?.stack || ''}\n`,
  )
  process.exit(2)
})
