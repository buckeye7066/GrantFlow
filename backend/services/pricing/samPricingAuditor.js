/**
 * Sam — pricing auditor.
 *
 * Verifies that the pricing system never violates GrantFlow's ethical-
 * billing rules and that quote totals are mathematically consistent.
 *
 * Lives next to the pricing engine (rather than under backend/services/sam/)
 * so unit tests can import it without depending on the rest of the Sam
 * orchestrator. The Sam onboarding/operations orchestrator can re-export
 * `runPricingAudit` from here.
 *
 * Pure functions where possible — `auditQuote` runs against a single
 * quote object; `auditPricingRuntime` runs against the live catalog +
 * a sample of recent quotes from the DB.
 */

import {
  PRICING_CATALOG_VERSION,
  CLIENT_CATEGORIES,
  CLIENT_CATEGORY_BUDGET_THRESHOLDS,
  PRICING_ENV_KEYS,
  readEnvFlag,
} from './pricingTypes.js'
import { PRICING_CATALOG, catalogIsEthical } from './pricingCatalog.js'
import { withProfileScope } from '../../middleware/profileContext.js'

export const SAM_PRICING_FINDING_SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  INFO: 'info',
})

const PERCENT_OF_AWARD_PATTERNS = [
  /\bpercent of award\b/i,
  /\b%\s*of\s*award\b/i,
  /\bcontingen[ct] on award\b/i,
  /\bcommission\b/i,
  /\bsuccess fee\b/i,
]

const GUARANTEED_FUNDING_PATTERNS = [
  /\bguaranteed\b/i,
  /\bwill receive\b/i,
  /\byou are getting\b/i,
  /\bawarded\b.+\bguarantee\b/i,
]

/**
 * Audit a single quote. Returns an array of findings.
 *
 * @param {object} quote — the persisted quote (with line_items + discounts)
 */
export function auditQuote(quote) {
  /** @type {Array<{severity: string, category: string, title: string, description: string, recommended_fix: string, evidence: object}>} */
  const findings = []
  if (!quote) {
    return [{
      severity: SAM_PRICING_FINDING_SEVERITY.CRITICAL,
      category: 'no_quote',
      title: 'auditQuote called with no quote',
      description: 'Cannot audit a missing quote.',
      recommended_fix: 'Pass a persisted quote object.',
      evidence: {},
    }]
  }

  if (!quote.pricing_catalog_version) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'missing_catalog_version',
      title: 'Pricing quote created without catalog version',
      description: 'Every quote must record the catalog version it was generated against.',
      recommended_fix: 'Persist quote.pricing_catalog_version on creation.',
      evidence: { quote_id: quote.id || null },
    })
  } else if (quote.pricing_catalog_version !== PRICING_CATALOG_VERSION) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.LOW,
      category: 'catalog_version_drift',
      title: `Quote uses catalog ${quote.pricing_catalog_version} (current: ${PRICING_CATALOG_VERSION})`,
      description: 'Older catalog versions are allowed for historical quotes but flagged for visibility.',
      recommended_fix: 'Confirm this is intentional; otherwise rebuild the quote.',
      evidence: { quote_version: quote.pricing_catalog_version, current: PRICING_CATALOG_VERSION },
    })
  }

  const currencyLower = String(quote.currency || 'usd').toLowerCase()
  if (currencyLower !== 'usd') {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'unsupported_currency',
      title: `Quote currency "${quote.currency}" is not USD`,
      description: 'GrantFlow currently bills in USD only.',
      recommended_fix: 'Force currency to USD or add a deliberate multi-currency rollout plan.',
      evidence: { currency: quote.currency },
    })
  }

  const allowedCategories = Object.values(CLIENT_CATEGORIES)
  if (!allowedCategories.includes(quote.client_category)) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'invalid_client_category',
      title: `Unknown client category "${quote.client_category}"`,
      description: 'Quote must be in one of: individual, small, mid_size, large.',
      recommended_fix: 'Re-run the client-category classifier.',
      evidence: { client_category: quote.client_category },
    })
  }

  // Math: subtotal == sum(line_items.subtotal); total = subtotal − approved discounts
  const lineItems = quote.line_items || []
  const expectedSubtotal = round2(lineItems.reduce((s, li) => s + Number(li.subtotal || 0), 0))
  if (Number.isFinite(quote.subtotal) && round2(quote.subtotal) !== expectedSubtotal) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'subtotal_mismatch',
      title: 'Quote subtotal does not equal sum of line items',
      description: `Persisted subtotal $${Number(quote.subtotal).toFixed(2)} ≠ computed $${expectedSubtotal.toFixed(2)}.`,
      recommended_fix: 'Recompute subtotal from line items and persist.',
      evidence: { persisted_subtotal: quote.subtotal, computed_subtotal: expectedSubtotal },
    })
  }

  const approvedDiscount = round2(
    (quote.discounts || []).filter((d) => d.approved).reduce((s, d) => s + Number(d.amount || d.discount_amount || 0), 0),
  )
  const expectedTotal = Math.max(0, round2(expectedSubtotal - approvedDiscount))
  if (Number.isFinite(quote.total) && round2(quote.total) !== expectedTotal) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'total_math_mismatch',
      title: 'Quote total does not equal subtotal minus approved discounts',
      description: `Persisted total $${Number(quote.total).toFixed(2)} ≠ computed $${expectedTotal.toFixed(2)}.`,
      recommended_fix: 'Recompute total from line items and approved discounts.',
      evidence: {
        persisted_total: quote.total,
        computed_total: expectedTotal,
        approved_discount: approvedDiscount,
      },
    })
  }

  const subtotal = expectedSubtotal
  const maxPct = Number(process.env[PRICING_ENV_KEYS.PRICING_MAX_TOTAL_DISCOUNT_PERCENT]) || 25
  const cap = round2((subtotal * maxPct) / 100)
  if (approvedDiscount > cap + 0.01) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'discount_cap_exceeded',
      title: `Approved discounts exceed the ${maxPct}% cap`,
      description: `Approved discounts $${approvedDiscount.toFixed(2)} exceed cap $${cap.toFixed(2)}.`,
      recommended_fix: 'Lower the discount(s), raise the cap deliberately, or require explicit admin override.',
      evidence: { approved_discount: approvedDiscount, cap, max_percent: maxPct },
    })
  }

  for (const d of quote.discounts || []) {
    const amount = Number(d.amount || d.discount_amount || 0)
    if (d.requires_admin_approval && !d.approved && amount > 0 && /approved|presented|accepted/i.test(quote.quote_status || '')) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
        category: 'discount_applied_without_approval',
        title: `Discount "${d.label || d.discount_key}" applied without approval`,
        description: 'A discount that requires admin approval is being treated as part of an approved quote without being approved.',
        recommended_fix: 'Approve or remove the discount before progressing the quote status.',
        evidence: { discount_id: d.id, discount_key: d.discount_key },
      })
    }
  }

  // No fee can be a percentage of award.
  for (const li of lineItems) {
    const blob = `${li.service_name || ''} ${li.reason || ''}`
    if (PERCENT_OF_AWARD_PATTERNS.some((p) => p.test(blob))) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.CRITICAL,
        category: 'percentage_of_award_fee',
        title: `Line item "${li.service_name}" looks like a percentage-of-award or commission fee`,
        description: 'GrantFlow forbids award-contingent and percentage-of-award fees.',
        recommended_fix: 'Remove the line and replace with a flat-fee professional-service line item.',
        evidence: { line_item_id: li.id, service_key: li.service_key, reason: li.reason },
      })
    }
  }

  for (const r of quote.reasons || []) {
    if (PERCENT_OF_AWARD_PATTERNS.some((p) => p.test(String(r)))) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
        category: 'reason_implies_contingency',
        title: 'Quote reason implies an award-contingent fee',
        description: `"${r}" suggests pricing depends on the grant award.`,
        recommended_fix: 'Reword to describe the professional service rendered.',
        evidence: { reason: r },
      })
    }
  }

  const requireAdmin = readEnvFlag(PRICING_ENV_KEYS.PRICING_REQUIRE_ADMIN_APPROVAL, true)
  if (requireAdmin && /presented_to_client|accepted/i.test(quote.quote_status || '') && quote.admin_review_required) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
      category: 'unapproved_quote_progressed',
      title: `Quote progressed to "${quote.quote_status}" without admin approval`,
      description: 'PRICING_REQUIRE_ADMIN_APPROVAL=true requires explicit admin approval before presenting/accepting.',
      recommended_fix: 'Reset to pending_admin_review and approve.',
      evidence: { quote_id: quote.id, status: quote.quote_status },
    })
  }

  const budget = Number(quote.annual_budget || quote.metadata?.annual_budget)
  if (Number.isFinite(budget) && budget > 0) {
    const expected =
      budget < CLIENT_CATEGORY_BUDGET_THRESHOLDS.small_max
        ? CLIENT_CATEGORIES.SMALL
        : budget <= CLIENT_CATEGORY_BUDGET_THRESHOLDS.mid_size_max
          ? CLIENT_CATEGORIES.MID_SIZE
          : CLIENT_CATEGORIES.LARGE
    if (quote.client_category !== expected && quote.client_category !== CLIENT_CATEGORIES.INDIVIDUAL) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.MEDIUM,
        category: 'client_category_misclassification',
        title: `Annual budget $${budget.toLocaleString()} suggests "${expected}", quote is "${quote.client_category}"`,
        description: 'Client category does not match the annual-budget thresholds.',
        recommended_fix: 'Re-run the classifier or override deliberately.',
        evidence: { annual_budget: budget, persisted: quote.client_category, expected },
      })
    }
  }

  return findings
}

/**
 * Audit user-facing language: catch any text that talks about funding as
 * if it were guaranteed.
 */
export function auditClientFacingLanguage(text) {
  if (!text || typeof text !== 'string') return []
  const findings = []
  for (const pattern of GUARANTEED_FUNDING_PATTERNS) {
    if (pattern.test(text)) {
      findings.push({
        severity: SAM_PRICING_FINDING_SEVERITY.HIGH,
        category: 'guaranteed_funding_language',
        title: 'Client-facing text implies funding is guaranteed',
        description: `Phrase matched: ${pattern.toString()}`,
        recommended_fix: 'Use "potential" / "estimated" / "may qualify" language instead.',
        evidence: { text },
      })
    }
  }
  return findings
}

/**
 * Audit the pricing system as a whole — catalog ethics + a sample of
 * recent quotes.
 */
export async function auditPricingRuntime(db, { sampleSize = 25 } = {}) {
  const findings = []
  if (!catalogIsEthical()) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.CRITICAL,
      category: 'catalog_unethical',
      title: 'Catalog contains contingent / commission language or invalid prices',
      description: 'The frozen catalog must contain only flat fees, no commission or success fees.',
      recommended_fix: 'Audit pricingCatalog.js entries.',
      evidence: { catalog_version: PRICING_CATALOG.version },
    })
  }

  if (!db) {
    return { catalog_ethical: catalogIsEthical(), findings, audited: 0 }
  }

  const installed = await tableExists(db, 'pricing_quotes')
  if (!installed) {
    findings.push({
      severity: SAM_PRICING_FINDING_SEVERITY.INFO,
      category: 'pricing_tables_not_installed',
      title: 'Pricing tables not installed',
      description: 'Run migration 079_pricing_quotes.sql.',
      recommended_fix: 'Run npm run db:migrate or apply the sql migration.',
      evidence: {},
    })
    return { catalog_ethical: catalogIsEthical(), findings, audited: 0 }
  }

  const sample = await withProfileScope({ bypass: true }, () =>
    db.prepare(`SELECT * FROM pricing_quotes ORDER BY created_at DESC LIMIT ?`).all(sampleSize),
  )
  let audited = 0
  for (const row of sample) {
    audited += 1
    const lineItems = await withProfileScope({ bypass: true }, () =>
      db.prepare(`SELECT * FROM pricing_quote_line_items WHERE quote_id = ?`).all(row.id),
    )
    const discounts = await withProfileScope({ bypass: true }, () =>
      db.prepare(`SELECT * FROM pricing_quote_discounts WHERE quote_id = ?`).all(row.id),
    )
    const decoded = {
      ...row,
      line_items: lineItems.map((li) => ({ ...li, subtotal: Number(li.subtotal) })),
      discounts: discounts.map((d) => ({
        ...d,
        amount: Number(d.discount_amount),
        approved: Number(d.approved) === 1,
        requires_admin_approval: Number(d.requires_admin_approval) === 1,
      })),
    }
    for (const f of auditQuote(decoded)) {
      findings.push({ ...f, evidence: { ...f.evidence, quote_id: row.id } })
    }
  }

  return { catalog_ethical: catalogIsEthical(), findings, audited }
}

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

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100
}
