/**
 * Quote storage layer.
 *
 * Persists the structured quote produced by `pricingEngine` into:
 *   - pricing_quotes
 *   - pricing_quote_line_items
 *   - pricing_quote_discounts
 *
 * All writes flow through `withProfileScope({ bypass: true })` because
 * the admin/system caller is acting cross-tenant.
 *
 * Graceful-degradation: every write checks `tableExists` first so the
 * routes return a structured "not_installed" status if migrations
 * haven't been run yet, instead of crashing.
 */

import { withProfileScope } from '../../middleware/profileContext.js'
import { CURRENCY_USD, QUOTE_STATUS } from './pricingTypes.js'
import { recomputeTotal } from './pricingEngine.js'

const QUOTES_TABLE = 'pricing_quotes'
const LINE_ITEMS_TABLE = 'pricing_quote_line_items'
const DISCOUNTS_TABLE = 'pricing_quote_discounts'
const DISCOUNT_RULES_TABLE = 'pricing_discount_rules'

async function tableExists(db, table) {
  if (!db) return false
  try {
    if (db.dialect === 'pg' || db.dialect === 'postgres') {
      const r = await db.prepare("SELECT 1 FROM information_schema.tables WHERE table_name = $1 LIMIT 1").get(table)
      return Boolean(r)
    }
    const r = await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(table)
    return Boolean(r)
  } catch {
    return false
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function isPg(db) {
  return db?.dialect === 'pg' || db?.dialect === 'postgres'
}

function jsonOut(db, value) {
  return isPg(db) ? value : JSON.stringify(value ?? null)
}

function jsonIn(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * Insert a fresh quote (status defaults to "internal_recommendation").
 * Returns the persisted quote with its assigned id.
 */
export async function persistQuote(db, {
  userId = null,
  profileId,
  intakeSessionId = null,
  quote,
  status,
}) {
  if (!quote) throw new Error('quote_required')
  if (!profileId) throw new Error('profile_id_required')
  if (!(await tableExists(db, QUOTES_TABLE))) {
    return { ok: false, error: 'pricing_tables_not_installed' }
  }

  return withProfileScope({ bypass: true }, async () => {
    const id = makeId('quote')
    const now = new Date().toISOString()
    const finalStatus = status || (quote.admin_review_required
      ? QUOTE_STATUS.PENDING_ADMIN_REVIEW
      : QUOTE_STATUS.INTERNAL_RECOMMENDATION)

    const ph = isPg(db)
      ? Array.from({ length: 17 }, (_, i) => `$${i + 1}`)
      : Array(17).fill('?')

    await db.prepare(
      `INSERT INTO ${QUOTES_TABLE}
        (id, user_id, profile_id, intake_session_id, pricing_catalog_version,
         client_category, category_confidence, recommended_package_name,
         subtotal, discount_total, total, currency, payment_terms_json,
         admin_review_required, quote_status, reasons_json, missing_inputs_json)
       VALUES (${ph.join(',')})`
    ).run(
      id,
      userId,
      profileId,
      intakeSessionId,
      quote.pricing_catalog_version,
      quote.client_category,
      quote.category_confidence,
      quote.recommended_package_name,
      Number(quote.subtotal || 0),
      Number(quote.discount_total || 0),
      Number(quote.total || 0),
      quote.currency || CURRENCY_USD,
      jsonOut(db, quote.payment_terms || null),
      quote.admin_review_required ? 1 : 0,
      finalStatus,
      jsonOut(db, quote.reasons || []),
      jsonOut(db, quote.missing_pricing_inputs || []),
    )

    for (const li of quote.line_items || []) {
      const lph = isPg(db) ? Array.from({ length: 9 }, (_, i) => `$${i + 1}`) : Array(9).fill('?')
      await db.prepare(
        `INSERT INTO ${LINE_ITEMS_TABLE}
          (id, quote_id, service_key, service_name, client_category, base_price, quantity, subtotal, reason)
         VALUES (${lph.join(',')})`
      ).run(
        makeId('li'),
        id,
        li.service_key,
        li.service_name,
        li.client_category,
        Number(li.base_price || 0),
        Number(li.quantity || 0),
        Number(li.subtotal || 0),
        li.reason || '',
      )
    }

    for (const d of quote.discounts || []) {
      const dph = isPg(db) ? Array.from({ length: 10 }, (_, i) => `$${i + 1}`) : Array(10).fill('?')
      await db.prepare(
        `INSERT INTO ${DISCOUNTS_TABLE}
          (id, quote_id, discount_key, label, discount_type, discount_value, discount_amount, reason, requires_admin_approval, approved)
         VALUES (${dph.join(',')})`
      ).run(
        makeId('disc'),
        id,
        d.discount_key,
        d.label,
        d.discount_type || 'percent',
        Number(d.discount_value || 0),
        Number(d.amount || 0),
        d.reason || '',
        d.requires_admin_approval ? 1 : 0,
        d.approved ? 1 : 0,
      )
    }

    return { ok: true, id, status: finalStatus, created_at: now }
  })
}

export async function getQuote(db, quoteId) {
  if (!(await tableExists(db, QUOTES_TABLE))) return null
  return withProfileScope({ bypass: true }, async () => {
    const row = await db.prepare(`SELECT * FROM ${QUOTES_TABLE} WHERE id = ?`).get(quoteId)
    if (!row) return null
    const lineItems = await db.prepare(`SELECT * FROM ${LINE_ITEMS_TABLE} WHERE quote_id = ? ORDER BY created_at`).all(quoteId)
    const discounts = await db.prepare(`SELECT * FROM ${DISCOUNTS_TABLE} WHERE quote_id = ? ORDER BY created_at`).all(quoteId)
    return decodeQuote(row, lineItems, discounts)
  })
}

export async function listQuotes(db, { status = null, profileId = null, limit = 50, offset = 0 } = {}) {
  if (!(await tableExists(db, QUOTES_TABLE))) return { installed: false, items: [] }
  return withProfileScope({ bypass: true }, async () => {
    // Optional filters. `profileId` lets callers query a single authorized
    // profile's quotes directly (never "load all, then filter by id").
    const clauses = []
    const params = []
    if (status) { clauses.push('quote_status = ?'); params.push(status) }
    if (profileId) { clauses.push('profile_id = ?'); params.push(String(profileId)) }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const items = await db
      .prepare(`SELECT * FROM ${QUOTES_TABLE} ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    return { installed: true, items: items.map((r) => decodeQuote(r, [], [])) }
  })
}

export async function updateQuoteStatus(db, quoteId, status) {
  if (!(await tableExists(db, QUOTES_TABLE))) return { ok: false, error: 'pricing_tables_not_installed' }
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(`UPDATE ${QUOTES_TABLE} SET quote_status = ?, updated_at = ? WHERE id = ?`).run(
      status,
      new Date().toISOString(),
      quoteId,
    )
    return { ok: true, id: quoteId, status }
  })
}

export async function approveQuote(db, quoteId) {
  const r = await updateQuoteStatus(db, quoteId, QUOTE_STATUS.APPROVED)
  // Also unblock the access gate so the user can move past the
  // "admin review pending" screen and accept the agreement.
  if (r?.ok && (await tableExists(db, 'profile_pricing'))) {
    return withProfileScope({ bypass: true }, async () => {
      await db.prepare(
        `UPDATE profile_pricing
          SET access_status = 'pending_agreement', admin_review_required = 0, updated_at = ?
         WHERE quote_id = ? AND access_status = 'pending_pricing'`,
      ).run(new Date().toISOString(), quoteId)
      return r
    })
  }
  return r
}

export async function approveDiscount(db, quoteId, discountId) {
  if (!(await tableExists(db, DISCOUNTS_TABLE))) return { ok: false, error: 'pricing_tables_not_installed' }
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(
      `UPDATE ${DISCOUNTS_TABLE} SET approved = 1 WHERE id = ? AND quote_id = ?`,
    ).run(discountId, quoteId)
    return rebalanceQuote(db, quoteId)
  })
}

export async function removeDiscount(db, quoteId, discountId) {
  if (!(await tableExists(db, DISCOUNTS_TABLE))) return { ok: false, error: 'pricing_tables_not_installed' }
  return withProfileScope({ bypass: true }, async () => {
    await db.prepare(`DELETE FROM ${DISCOUNTS_TABLE} WHERE id = ? AND quote_id = ?`).run(discountId, quoteId)
    return rebalanceQuote(db, quoteId)
  })
}

export async function addManualDiscount(db, quoteId, discount) {
  if (!(await tableExists(db, DISCOUNTS_TABLE))) return { ok: false, error: 'pricing_tables_not_installed' }
  return withProfileScope({ bypass: true }, async () => {
    const dph = isPg(db) ? Array.from({ length: 10 }, (_, i) => `$${i + 1}`) : Array(10).fill('?')
    const id = makeId('disc')
    await db.prepare(
      `INSERT INTO ${DISCOUNTS_TABLE}
        (id, quote_id, discount_key, label, discount_type, discount_value, discount_amount, reason, requires_admin_approval, approved)
       VALUES (${dph.join(',')})`,
    ).run(
      id,
      quoteId,
      discount.discount_key || 'manual_admin',
      discount.label || 'Manual admin discount',
      discount.type || 'fixed',
      Number(discount.value || 0),
      Number(discount.amount || 0),
      discount.reason || '',
      1,
      Number(discount.approved ? 1 : 0),
    )
    return rebalanceQuote(db, quoteId)
  })
}

export async function editLineItem(db, quoteId, lineItemId, updates) {
  if (!(await tableExists(db, LINE_ITEMS_TABLE))) return { ok: false, error: 'pricing_tables_not_installed' }
  return withProfileScope({ bypass: true }, async () => {
    const fields = []
    const values = []
    for (const k of ['service_name', 'client_category', 'base_price', 'quantity', 'reason']) {
      if (k in updates) {
        fields.push(`${k} = ${isPg(db) ? `$${values.length + 1}` : '?'}`)
        values.push(updates[k])
      }
    }
    if ('base_price' in updates || 'quantity' in updates) {
      const row = await db.prepare(`SELECT base_price, quantity FROM ${LINE_ITEMS_TABLE} WHERE id = ?`).get(lineItemId)
      const basePrice = Number(updates.base_price ?? row?.base_price ?? 0)
      const quantity = Number(updates.quantity ?? row?.quantity ?? 1)
      fields.push(`subtotal = ${isPg(db) ? `$${values.length + 1}` : '?'}`)
      values.push(round2(basePrice * quantity))
    }
    if (fields.length === 0) return rebalanceQuote(db, quoteId)
    values.push(lineItemId)
    const wherePh = isPg(db) ? `$${values.length}` : '?'
    await db.prepare(
      `UPDATE ${LINE_ITEMS_TABLE} SET ${fields.join(', ')} WHERE id = ${wherePh}`,
    ).run(...values)
    return rebalanceQuote(db, quoteId)
  })
}

async function rebalanceQuote(db, quoteId) {
  const lineItems = await db.prepare(`SELECT * FROM ${LINE_ITEMS_TABLE} WHERE quote_id = ?`).all(quoteId)
  const discounts = await db.prepare(`SELECT * FROM ${DISCOUNTS_TABLE} WHERE quote_id = ?`).all(quoteId)
  const subtotal = round2(lineItems.reduce((s, li) => s + Number(li.subtotal || 0), 0))
  const discountTotal = round2(
    discounts.filter((d) => Number(d.approved) === 1).reduce((s, d) => s + Number(d.discount_amount || 0), 0),
  )
  const total = Math.max(0, round2(subtotal - discountTotal))
  await db.prepare(
    `UPDATE ${QUOTES_TABLE} SET subtotal = ?, discount_total = ?, total = ?, updated_at = ? WHERE id = ?`,
  ).run(subtotal, discountTotal, total, new Date().toISOString(), quoteId)
  return { ok: true, id: quoteId, subtotal, discount_total: discountTotal, total }
}

function decodeQuote(row, lineItems, discounts) {
  return {
    ...row,
    payment_terms: jsonIn(row.payment_terms_json),
    reasons: jsonIn(row.reasons_json) || [],
    missing_inputs: jsonIn(row.missing_inputs_json) || [],
    line_items: (lineItems || []).map((li) => ({ ...li, base_price: Number(li.base_price), quantity: Number(li.quantity), subtotal: Number(li.subtotal) })),
    discounts: (discounts || []).map((d) => ({
      ...d,
      discount_value: Number(d.discount_value),
      amount: Number(d.discount_amount),
      requires_admin_approval: Number(d.requires_admin_approval) === 1,
      approved: Number(d.approved) === 1,
    })),
    admin_review_required: Number(row.admin_review_required) === 1,
  }
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100
}

export {
  tableExists,
  recomputeTotal,
  QUOTES_TABLE,
  LINE_ITEMS_TABLE,
  DISCOUNTS_TABLE,
  DISCOUNT_RULES_TABLE,
}
