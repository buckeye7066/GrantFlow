import { createHash } from 'node:crypto'
import { listCheckoutPriceRows } from './checkoutPriceRows.js'
import { resolveChargeForQuote } from './chargeResolver.js'
import { PRICING_CATALOG_VERSION } from './pricingTypes.js'
import { CLIENT_CATEGORIES, MILESTONE_PHASES } from '../serviceCatalogStore.js'

const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32)
const productId = price => typeof price.product === 'string' ? price.product : price.product?.id
const tuple = row => JSON.stringify([row.service_id, row.client_category, row.milestone_phase || '', row.currency])
const lookupKey = row => `grantflow_service_${digest(JSON.stringify([PRICING_CATALOG_VERSION, row.slug, row.client_category, row.milestone_phase || '', row.currency, Number(row.amount_cents)]))}`

async function listAll(resource) {
  const rows = []
  let starting_after
  for (let page = 0; page < 100; page += 1) {
    const result = await resource.list({ limit: 100, ...(starting_after ? { starting_after } : {}) })
    rows.push(...result.data)
    if (!result.has_more) return rows
    if (!result.data.length) throw new Error('STRIPE_CATALOG_PAGINATION_INVALID')
    starting_after = result.data.at(-1).id
  }
  throw new Error('STRIPE_CATALOG_SCAN_LIMIT')
}

function validatePrice(price, row, products) {
  const product = products.find(p => p.id === productId(price))
  if (!price.active || price.type !== 'one_time' || price.recurring ||
      price.unit_amount !== Number(row.amount_cents) || price.currency !== row.currency ||
      price.billing_scheme && price.billing_scheme !== 'per_unit' || price.transform_quantity ||
      product?.active !== true || product.metadata?.app !== 'grantflow' || product.metadata?.service_slug !== row.slug ||
      price.metadata?.app !== 'grantflow' || price.metadata?.service_slug !== row.slug ||
      price.metadata?.client_category !== row.client_category ||
      (price.metadata?.milestone_phase || '') !== (row.milestone_phase || '')) {
    throw new Error(`STRIPE_PRICE_MISMATCH:${row.slug}/${row.client_category}/${row.milestone_phase || 'one_time'}`)
  }
}

/** Configure approved service prices only. Dry-run by default; never creates a
 * checkout, customer, subscription, invoice or charge. Existing mappings are
 * verified, never replaced. Durable lookup keys recover a partial prior apply.
 */
export async function syncStripeServicePrices({ db, stripe, apply = false }) {
  const rows = await listCheckoutPriceRows(db)
  const services = await db.prepare('SELECT id, slug, pricing_model FROM service_catalog_items WHERE is_active = TRUE').all()
  if (!services.length) throw new Error('INCOMPLETE_CATALOG: no active services')
  const actual = new Set(rows.map(tuple))
  let expected = 0
  for (const service of services) {
    const phases = service.pricing_model === 'milestone' ? MILESTONE_PHASES : ['']
    for (const category of CLIENT_CATEGORIES) {
      for (const phase of phases) {
        expected += 1
        if (!actual.has(JSON.stringify([service.id, category, phase, 'usd']))) {
          throw new Error(`INCOMPLETE_CATALOG:${service.slug}/${category}/${phase || 'one_time'}`)
        }
      }
    }
  }
  if (rows.length !== expected || actual.size !== expected) throw new Error('INCOMPLETE_CATALOG: unexpected or duplicate price rows')
  // Validate the complete DB plan against approved catalog math before any
  // Stripe write. Missing mapping is the only tolerated checkout blocker.
  for (const row of rows) {
    const charge = await resolveChargeForQuote({ db, serviceKey: row.slug,
      clientCategory: row.client_category, milestonePhase: row.milestone_phase || null })
    if ((!charge.can_checkout && charge.blocking_reason !== 'STRIPE_PRICE_MISSING') ||
        charge.final_amount_cents !== Number(row.amount_cents) || charge.currency !== row.currency) {
      throw new Error(`CATALOG_DRIFT:${row.slug}/${row.client_category}:${charge.blocking_reason || 'amount'}`)
    }
  }
  const [products, prices] = await Promise.all([listAll(stripe.products), listAll(stripe.prices)])
  const plan = []
  const newProductSlugs = new Set()
  for (const row of rows) {
    const matchingProducts = products.filter(p => p.metadata?.app === 'grantflow' && p.metadata?.service_slug === row.slug)
    if (matchingProducts.length > 1 || matchingProducts.some(p => !p.active)) throw new Error(`STRIPE_PRODUCT_CONFLICT:${row.slug}`)
    if (!matchingProducts.length) newProductSlugs.add(row.slug)
    const key = lookupKey(row)
    const matches = prices.filter(p => row.stripe_price_id ? p.id === row.stripe_price_id : p.lookup_key === key)
    if (matches.length > 1 || (row.stripe_price_id && matches.length !== 1)) throw new Error(`STRIPE_PRICE_MISSING_OR_AMBIGUOUS:${row.slug}`)
    if (matches[0]) validatePrice(matches[0], row, products)
    plan.push({ row, key, price: matches[0] || null })
  }
  const result = { applied: apply === true, checked: rows.length, create_products: newProductSlugs.size,
    create_prices: plan.filter(item => !item.price).length, mapped: 0,
    rows: plan.map(({ row, key, price }) => ({ service_slug: row.slug, client_category: row.client_category,
      milestone_phase: row.milestone_phase || null, amount_cents: Number(row.amount_cents), currency: row.currency,
      lookup_key: key, stripe_price_id: price?.id || null })) }
  if (apply !== true) return result

  for (const item of plan) {
    const { row, key } = item
    if (row.stripe_price_id) continue
    if (!item.price) {
      let product = products.find(p => p.metadata?.app === 'grantflow' && p.metadata?.service_slug === row.slug)
      if (!product) {
        product = await stripe.products.create({ name: `GrantFlow — ${row.name}`,
          description: row.pricing_model === 'hourly' ? 'Professional services billed per six-minute unit.' : 'Professional services; fees are not contingent on grant awards.',
          metadata: { app: 'grantflow', service_slug: row.slug, catalog_version: PRICING_CATALOG_VERSION },
        }, { idempotencyKey: `grantflow_service_product_${digest(`${PRICING_CATALOG_VERSION}:${row.slug}`)}` })
        products.push(product)
      }
      item.price = await stripe.prices.create({ product: product.id, currency: row.currency,
        unit_amount: Number(row.amount_cents), lookup_key: key,
        nickname: `${row.client_category} ${row.milestone_phase || (row.pricing_model === 'hourly' ? 'six-minute unit' : 'one-time')}`,
        metadata: { app: 'grantflow', service_slug: row.slug, client_category: row.client_category,
          milestone_phase: row.milestone_phase || '', catalog_version: PRICING_CATALOG_VERSION,
          unit: row.pricing_model === 'hourly' ? 'six_minutes' : 'service' },
      }, { idempotencyKey: key })
      validatePrice(item.price, row, products)
    }
    // Compare the full reviewed row at write time. A concurrent catalog edit or
    // admin mapping must not be overwritten by this operational repair.
    const updated = await db.prepare(`UPDATE service_prices SET stripe_price_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND service_id = ? AND client_category = ? AND COALESCE(milestone_phase, '') = ?
        AND amount_cents = ? AND currency = ? AND active = TRUE AND COALESCE(stripe_price_id, '') = ''
        AND EXISTS (SELECT 1 FROM service_catalog_items WHERE id = ? AND slug = ? AND pricing_model = ? AND is_active = TRUE)
    `).run(item.price.id, row.service_price_id, row.service_id, row.client_category, row.milestone_phase || '',
      Number(row.amount_cents), row.currency, row.service_id, row.slug, row.pricing_model)
    if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) throw new Error(`CATALOG_CHANGED_DURING_SYNC:${row.service_price_id}`)
    result.mapped += 1
    result.rows.find(r => r.lookup_key === key).stripe_price_id = item.price.id
  }
  return result
}
