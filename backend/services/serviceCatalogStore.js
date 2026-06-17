import crypto from 'node:crypto'
import { loadPaymentSheetExtractFromDisk, parsePaymentSheetExtract } from './serviceCatalogExtractParser.js'
import { hourlyRateToSixMinuteUnitCents } from './hourlyRounding.js'
import { LEGACY_SLUG_TO_CANONICAL } from './pricing/serviceSlugAliases.js'

export const CLIENT_CATEGORIES = Object.freeze(['individual', 'small', 'mid', 'large'])
export const PRICING_MODELS = Object.freeze(['one_time', 'milestone', 'hourly'])
export const MILESTONE_PHASES = Object.freeze(['kickoff', 'draft', 'submission'])

function isPostgres(db) {
  return db?.dialect === 'postgres'
}

function nowSqlLiteral(db) {
  return isPostgres(db) ? 'now()' : 'CURRENT_TIMESTAMP'
}

export async function ensureServiceCatalogSchema(db) {
  if (!db || typeof db.prepare !== 'function') return

  // Core catalog
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS service_catalog_items (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,
      pricing_model TEXT NOT NULL,
      is_active ${isPostgres(db) ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${isPostgres(db) ? 'TRUE' : '1'},
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)},
      updated_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS service_prices (
      id TEXT PRIMARY KEY,
      service_id TEXT NOT NULL REFERENCES service_catalog_items(id) ON DELETE CASCADE,
      client_category TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      -- IMPORTANT: Do not allow NULL here; UNIQUE treats NULL as distinct (idempotency bug).
      milestone_phase TEXT NOT NULL DEFAULT '',
      stripe_price_id TEXT,
      active ${isPostgres(db) ? 'BOOLEAN' : 'INTEGER'} DEFAULT ${isPostgres(db) ? 'TRUE' : '1'},
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)},
      updated_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)},
      UNIQUE(service_id, client_category, currency, milestone_phase)
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS service_terms (
      id TEXT PRIMARY KEY,
      version TEXT NOT NULL UNIQUE,
      policy_snippet TEXT NOT NULL,
      full_text TEXT NOT NULL,
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()

  // Purchases / fulfillment
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS service_purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      profile_id TEXT,
      organization_id TEXT,
      service_id TEXT NOT NULL REFERENCES service_catalog_items(id),
      client_category TEXT NOT NULL,
      pricing_model TEXT NOT NULL,
      status TEXT NOT NULL,
      agreed_terms_version TEXT,
      agreed_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'},
      stripe_customer_id TEXT,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id TEXT,
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)},
      updated_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS milestone_payments (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id TEXT,
      paid_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'},
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)},
      updated_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)},
      UNIQUE(purchase_id, phase)
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS hourly_time_entries (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
      minutes INTEGER NOT NULL,
      rounded_minutes INTEGER NOT NULL,
      note TEXT,
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS hourly_invoices (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES service_purchases(id) ON DELETE CASCADE,
      total_rounded_minutes INTEGER NOT NULL,
      units INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'usd',
      status TEXT NOT NULL,
      stripe_checkout_session_id TEXT,
      stripe_payment_intent_id TEXT,
      paid_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'},
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      event_id TEXT PRIMARY KEY,
      type TEXT,
      processed_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS stripe_customers (
      user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      created_at ${isPostgres(db) ? 'TIMESTAMPTZ' : 'DATETIME'} DEFAULT ${nowSqlLiteral(db)}
    );
  `).run()
}

function pickPricingModelByName(name) {
  // Minimal but complete: treat application-writing projects as milestone-based by default.
  const n = String(name || '').toLowerCase()
  if (n.includes('micro-grant application')) return 'milestone'
  if (n.includes('standard foundation application')) return 'milestone'
  if (n.includes('complex/federal application')) return 'milestone'
  if (n.includes('hourly consultation')) return 'hourly'
  return 'one_time'
}

function computeMilestoneSplit(totalCents) {
  const total = Math.max(0, Math.floor(Number(totalCents) || 0))
  const kickoff = Math.round(total * 0.4)
  const draft = Math.round(total * 0.4)
  const submission = Math.max(0, total - kickoff - draft)
  return { kickoff, draft, submission }
}

/**
 * Rewrite legacy service slugs to their canonical form so the upsert by
 * canonical slug updates the existing row in place instead of creating an
 * orphan duplicate. Idempotent: skips the rename when the canonical row
 * already exists, and deactivates the legacy row in that case so it is
 * never used for new checkouts. Existing `service_purchases.service_id`
 * (UUID) references continue to resolve correctly because we keep the
 * primary-key id stable.
 */
async function migrateLegacySlugs(db) {
  for (const [legacy, canonical] of Object.entries(LEGACY_SLUG_TO_CANONICAL)) {
    // Step 1: rename legacy → canonical when the canonical slug is free.
    await db
      .prepare(
        `
          UPDATE service_catalog_items
          SET slug = ?, updated_at = ${nowSqlLiteral(db)}
          WHERE slug = ?
            AND NOT EXISTS (SELECT 1 FROM service_catalog_items WHERE slug = ?)
        `,
      )
      .run(canonical, legacy, canonical)

    // Step 2: if both the legacy and canonical row exist (older deploys
    // already created the canonical row), deactivate the legacy one so
    // checkout cannot select it. Existing purchases keep working via
    // `service_id`; new checkouts use the canonical row.
    await db
      .prepare(
        `
          UPDATE service_catalog_items
          SET is_active = ${isPostgres(db) ? 'FALSE' : '0'},
              updated_at = ${nowSqlLiteral(db)}
          WHERE slug = ?
        `,
      )
      .run(legacy)
  }
}

export async function seedServiceCatalogFromExtract(db) {
  await ensureServiceCatalogSchema(db)
  await migrateLegacySlugs(db)

  const markdown = loadPaymentSheetExtractFromDisk()
  const parsed = parsePaymentSheetExtract(markdown)

  // Terms (upsert by version)
  const termsId = crypto.randomUUID()
  await db.prepare(
    `
      INSERT INTO service_terms (id, version, policy_snippet, full_text, created_at)
      VALUES (?, ?, ?, ?, ${nowSqlLiteral(db)})
      ON CONFLICT(version) DO UPDATE SET
        policy_snippet = excluded.policy_snippet,
        full_text = excluded.full_text
    `,
  ).run(termsId, parsed.terms.version, parsed.terms.policy_snippet, parsed.terms.full_text)

  // Services + prices (upsert by slug)
  for (const svc of parsed.services) {
    const serviceId = crypto.randomUUID()
    const pricingModel = pickPricingModelByName(svc.name)
    const isActive = 1

    await db.prepare(
      `
        INSERT INTO service_catalog_items (
          id, slug, name, description, category, pricing_model, is_active, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)}
        )
        ON CONFLICT(slug) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          category = excluded.category,
          pricing_model = excluded.pricing_model,
          is_active = excluded.is_active,
          updated_at = ${nowSqlLiteral(db)}
      `,
    ).run(serviceId, svc.slug, svc.name, svc.description || null, svc.category || null, pricingModel, isPostgres(db) ? true : isActive)

    const row = await db.prepare('SELECT id, pricing_model FROM service_catalog_items WHERE slug = ? LIMIT 1').get(svc.slug)
    const effectiveServiceId = String(row?.id || serviceId)
    const effectiveModel = String(row?.pricing_model || pricingModel)

    // Base prices from extract (one_time and milestone totals)
    for (const category of CLIENT_CATEGORIES) {
      const cents = svc.prices?.[category] ?? null
      if ((cents === null || cents === undefined)) continue

      if (effectiveModel === 'hourly') {
        // Store price rows as 6-minute units (quantity = rounded_minutes / 6)
        const unitCents = hourlyRateToSixMinuteUnitCents(Number(cents))
        await upsertPriceRow(db, {
          serviceId: effectiveServiceId,
          clientCategory: category,
          amountCents: unitCents,
          currency: 'usd',
          milestonePhase: '',
          stripePriceId: null,
          active: true,
        })
        continue
      }

      // Total row (milestone_phase '') — NULL would allow duplicates under UNIQUE.
      await upsertPriceRow(db, {
        serviceId: effectiveServiceId,
        clientCategory: category,
        amountCents: Number(cents),
        currency: 'usd',
        milestonePhase: '',
        stripePriceId: null,
        active: true,
      })

      if (effectiveModel === 'milestone') {
        const split = computeMilestoneSplit(Number(cents))
        for (const phase of MILESTONE_PHASES) {
          await upsertPriceRow(db, {
            serviceId: effectiveServiceId,
            clientCategory: category,
            amountCents: Number(split[phase]),
            currency: 'usd',
            milestonePhase: phase,
            stripePriceId: null,
            active: true,
          })
        }
      }
    }
  }

  return { ok: true, version: parsed.version, service_count: parsed.services.length }
}

async function upsertPriceRow(
  db,
  { serviceId, clientCategory, amountCents, currency, milestonePhase = '', stripePriceId = null, active = true },
) {
  const id = crypto.randomUUID()
  const activeDb = isPostgres(db) ? Boolean(active) : active ? 1 : 0
  await db.prepare(
    `
      INSERT INTO service_prices (
        id, service_id, client_category, amount_cents, currency, milestone_phase, stripe_price_id, active, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ${nowSqlLiteral(db)}, ${nowSqlLiteral(db)}
      )
      ON CONFLICT(service_id, client_category, currency, milestone_phase) DO UPDATE SET
        amount_cents = excluded.amount_cents,
        active = excluded.active,
        -- Preserve existing stripe mapping unless explicitly set elsewhere.
        stripe_price_id = CASE WHEN excluded.stripe_price_id IS NOT NULL THEN excluded.stripe_price_id ELSE service_prices.stripe_price_id END,
        updated_at = ${nowSqlLiteral(db)}
    `,
  ).run(id, serviceId, clientCategory, Number(amountCents), currency, String(milestonePhase ?? ''), stripePriceId, activeDb)
}

export async function listServiceCatalog(db, { includeInactive = false } = {}) {
  await ensureServiceCatalogSchema(db)

  const where = includeInactive ? 'WHERE 1=1' : 'WHERE is_active = 1'
  const items = await db
    .prepare(
      `
        SELECT *
        FROM service_catalog_items
        ${where}
        ORDER BY category ASC, name ASC
      `,
    )
    .all()

  const ids = items.map((i) => String(i.id))
  if (ids.length === 0) return []

  const placeholders = ids.map(() => '?').join(','); if(ids.length > 1000) throw new Error('Too many IDs for query')
  const prices = await db
    .prepare(
      `
        SELECT *
        FROM service_prices
        WHERE service_id IN (${placeholders})
          AND active = 1
        ORDER BY client_category ASC,
                 CASE WHEN COALESCE(milestone_phase, '') = '' THEN 0 ELSE 1 END,
                 milestone_phase ASC
      `,
    )
    .all(...ids)

  const pricesByService = new Map()
  for (const p of prices || []) {
    const sid = String(p.service_id)
    if (!pricesByService.has(sid)) pricesByService.set(sid, [])
    pricesByService.get(sid).push(p)
  }

  return (items || []).map((row) => ({
    id: String(row.id),
    slug: String(row.slug),
    name: row.name,
    description: row.description || null,
    category: row.category || null,
    pricing_model: row.pricing_model,
    is_active: Boolean(row.is_active),
    prices: (pricesByService.get(String(row.id)) || []).map((p) => ({
      id: String(p.id),
      client_category: p.client_category,
      amount_cents: Number(p.amount_cents),
      currency: p.currency || 'usd',
      milestone_phase: p.milestone_phase || null,
      stripe_price_id: p.stripe_price_id || null,
      active: Boolean(p.active),
    })),
  }))
}

export async function getLatestServiceTerms(db) {
  await ensureServiceCatalogSchema(db)
  const row = await db
    .prepare('SELECT * FROM service_terms ORDER BY created_at DESC LIMIT 1')
    .get()
  if (!row) return null
  return {
    id: String(row.id),
    version: String(row.version),
    policy_snippet: String(row.policy_snippet),
    full_text: String(row.full_text),
    created_at: row.created_at || null,
  }
}

