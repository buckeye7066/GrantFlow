/**
 * awardComplianceStore.js
 *
 * Data model + math for the Award Compliance & Restriction Tracking subsystem.
 *
 * When a funding source is awarded, its rules/restrictions are captured here
 * (e.g. "$500 of this $1000 grant must go to supplies", "spend within 90 days
 * of disbursement"). The user logs spending against each rule and attaches an
 * uploaded proof document; we track spent vs required (remaining / over) and
 * surface overdue / short-spend findings to the agents.
 *
 * CONSERVATISM RULES (real money, incl. a minor's funds):
 *   - Money is stored and computed in INTEGER CENTS everywhere — never floats.
 *   - A requirement is only ever "met" when logged spend entries SUM to (or
 *     exceed) the requirement. There is no auto-compliance: nothing is marked
 *     compliant without an explicit spend entry.
 *   - A category_exact rule that is OVER its required amount is flagged 'over'
 *     (potential non-compliance), not silently treated as fine.
 *
 * Dialect handling (sqlite + postgres) mirrors
 * hamiltonCredentialSessionService.ensureSchema: per-db WeakMap schema cache,
 * dialect-aware id/timestamp/json defaults, idempotent CREATE TABLE IF NOT
 * EXISTS.
 */

import crypto from 'node:crypto'

const RESTRICTION_TYPES = Object.freeze([
  'category_minimum',
  'category_exact',
  'timeframe',
  'allowed_use',
  'other',
])

// Per-db schema cache (WeakMap) — see hamiltonCredentialSessionService for the
// rationale (node:test runs sibling suites with independent in-memory dbs).
let schemaReady = new WeakMap()
export function _resetComplianceSchemaCache() { schemaReady = new WeakMap() }

async function ensureSchema(db) {
  if (!db || schemaReady.has(db) || typeof db.prepare !== 'function') return
  const isPostgres = db?.dialect === 'postgres'
  const idDefault = isPostgres ? '(gen_random_uuid()::text)' : '(lower(hex(randomblob(16))))'
  const tsType = isPostgres ? 'TIMESTAMPTZ' : 'DATETIME'
  const nowFn = isPostgres ? 'now()' : 'CURRENT_TIMESTAMP'

  await db.exec(`
    CREATE TABLE IF NOT EXISTS award_compliance_rules (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      profile_id TEXT NOT NULL,
      grant_id TEXT,
      award_ref TEXT,
      title TEXT NOT NULL,
      total_amount_cents INTEGER,
      restriction_type TEXT NOT NULL DEFAULT 'other',
      category TEXT,
      required_amount_cents INTEGER,
      spend_by_date ${tsType},
      description TEXT,
      is_draft INTEGER NOT NULL DEFAULT 0,
      source_excerpt TEXT,
      created_by TEXT,
      created_at ${tsType} DEFAULT ${nowFn},
      updated_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_award_rules_profile ON award_compliance_rules(profile_id);
    CREATE INDEX IF NOT EXISTS idx_award_rules_grant   ON award_compliance_rules(grant_id);

    CREATE TABLE IF NOT EXISTS award_spend_entries (
      id TEXT PRIMARY KEY DEFAULT ${idDefault},
      rule_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      spent_on ${tsType},
      category TEXT,
      memo TEXT,
      proof_document_id TEXT,
      created_by TEXT,
      created_at ${tsType} DEFAULT ${nowFn}
    );
    CREATE INDEX IF NOT EXISTS idx_award_spend_rule ON award_spend_entries(rule_id);
  `)
  schemaReady.set(db, true)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toCentsOrNull(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  // Integer cents only — refuse a fractional cent.
  return Math.round(n)
}

function toCentsRequired(v) {
  const c = toCentsOrNull(v)
  if (c === null) throw new Error('amount_cents is required and must be an integer number of cents')
  return c
}

function normalizeRestrictionType(t) {
  const s = String(t || '').trim()
  return RESTRICTION_TYPES.includes(s) ? s : 'other'
}

function rowToRule(row) {
  if (!row) return null
  return {
    id: row.id,
    profile_id: row.profile_id,
    grant_id: row.grant_id || null,
    award_ref: row.award_ref || null,
    title: row.title,
    total_amount_cents: row.total_amount_cents ?? null,
    restriction_type: row.restriction_type,
    category: row.category || null,
    required_amount_cents: row.required_amount_cents ?? null,
    spend_by_date: row.spend_by_date || null,
    description: row.description || null,
    is_draft: Boolean(row.is_draft),
    source_excerpt: row.source_excerpt || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToEntry(row) {
  if (!row) return null
  return {
    id: row.id,
    rule_id: row.rule_id,
    amount_cents: row.amount_cents,
    spent_on: row.spent_on || null,
    category: row.category || null,
    memo: row.memo || null,
    proof_document_id: row.proof_document_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Rules CRUD
// ---------------------------------------------------------------------------

export async function createRule(db, {
  profileId, grantId = null, awardRef = null, title,
  totalAmountCents = null, restrictionType = 'other', category = null,
  requiredAmountCents = null, spendByDate = null, description = null,
  isDraft = false, sourceExcerpt = null, createdBy = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!profileId) throw new Error('profileId required')
  if (!title || !String(title).trim()) throw new Error('title required')
  await ensureSchema(db)

  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO award_compliance_rules
       (id, profile_id, grant_id, award_ref, title, total_amount_cents, restriction_type,
        category, required_amount_cents, spend_by_date, description, is_draft, source_excerpt,
        created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${nowFn}, ${nowFn})`,
  ).run(
    id, String(profileId), grantId ? String(grantId) : null, awardRef ? String(awardRef) : null,
    String(title).trim(), toCentsOrNull(totalAmountCents), normalizeRestrictionType(restrictionType),
    category ? String(category) : null, toCentsOrNull(requiredAmountCents),
    spendByDate || null, description ? String(description) : null,
    isDraft ? 1 : 0, sourceExcerpt ? String(sourceExcerpt) : null,
    createdBy ? String(createdBy) : null,
  )
  return rowToRule(await db.prepare('SELECT * FROM award_compliance_rules WHERE id = ?').get(id))
}

export async function getRule(db, ruleId) {
  if (!db || !ruleId) return null
  await ensureSchema(db)
  return rowToRule(await db.prepare('SELECT * FROM award_compliance_rules WHERE id = ?').get(String(ruleId)))
}

export async function listRulesForProfile(db, profileId) {
  if (!db || !profileId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    'SELECT * FROM award_compliance_rules WHERE profile_id = ? ORDER BY created_at DESC',
  ).all(String(profileId))
  return (rows || []).map(rowToRule)
}

export async function listRulesForGrant(db, grantId) {
  if (!db || !grantId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    'SELECT * FROM award_compliance_rules WHERE grant_id = ? ORDER BY created_at DESC',
  ).all(String(grantId))
  return (rows || []).map(rowToRule)
}

// Idempotent draft-derivation guard: only create a derived draft rule when an
// equivalent one (same grant + restriction_type + category + required amount)
// doesn't already exist, so re-running the derive endpoint won't duplicate.
async function draftRuleExists(db, { grantId, restrictionType, category, requiredAmountCents }) {
  const rows = await db.prepare(
    'SELECT id FROM award_compliance_rules WHERE grant_id = ? AND restriction_type = ?',
  ).all(String(grantId), normalizeRestrictionType(restrictionType))
  if (!rows || rows.length === 0) return false
  const wantCat = category ? String(category) : null
  const wantAmt = toCentsOrNull(requiredAmountCents)
  for (const r of rows) {
    const full = await db.prepare('SELECT category, required_amount_cents FROM award_compliance_rules WHERE id = ?').get(r.id)
    const haveCat = full?.category ? String(full.category) : null
    const haveAmt = full?.required_amount_cents ?? null
    if (haveCat === wantCat && haveAmt === wantAmt) return true
  }
  return false
}

/**
 * Best-effort: from a grant row, parse draft restriction rules and persist any
 * that don't already exist. Returns the list of rules created. NEVER invents
 * numbers — if the parser finds nothing, nothing is created.
 *
 * Used both by the awarded-transition hook and the POST .../derive endpoint.
 */
export async function deriveDraftRulesForGrant(db, grant, { createdBy = 'system-derive' } = {}) {
  if (!db || !grant || !grant.id || !grant.profile_id) return []
  await ensureSchema(db)
  const { deriveDraftRulesFromGrant } = await import('./restrictionParser.js')
  const drafts = deriveDraftRulesFromGrant(grant)
  if (drafts.length === 0) return []

  const totalCents = (() => {
    const candidates = [grant.amount_awarded, grant.amount_max, grant.amount_min]
    for (const c of candidates) {
      const n = Number(c)
      if (Number.isFinite(n) && n > 0) return Math.round(n * 100)
    }
    return null
  })()

  const created = []
  for (const d of drafts) {
    const exists = await draftRuleExists(db, {
      grantId: grant.id,
      restrictionType: d.restriction_type,
      category: d.category,
      requiredAmountCents: d.required_amount_cents,
    })
    if (exists) continue

    // Translate a relative timeframe (spend_by_days) into a concrete date only
    // when we can anchor it. We do NOT fabricate a disbursement date here; the
    // user confirms the spend_by_date on a draft timeframe rule. We still keep
    // the days in the description so the user sees the source intent.
    const description = d.spend_by_days
      ? `${d.description} (heuristic: within ${d.spend_by_days} days of disbursement — confirm a due date)`
      : d.description

    const rule = await createRule(db, {
      profileId: grant.profile_id,
      grantId: grant.id,
      title: d.title,
      totalAmountCents: totalCents,
      restrictionType: d.restriction_type,
      category: d.category,
      requiredAmountCents: d.required_amount_cents,
      spendByDate: null,
      description,
      isDraft: true,
      sourceExcerpt: d.source_excerpt,
      createdBy,
    })
    created.push(rule)
  }
  return created
}

// ---------------------------------------------------------------------------
// Spend entries
// ---------------------------------------------------------------------------

export async function addSpendEntry(db, {
  ruleId, amountCents, spentOn = null, category = null, memo = null,
  proofDocumentId = null, createdBy = null,
} = {}) {
  if (!db) throw new Error('db required')
  if (!ruleId) throw new Error('ruleId required')
  await ensureSchema(db)

  const rule = await getRule(db, ruleId)
  if (!rule) throw new Error('rule not found')

  const cents = toCentsRequired(amountCents)
  if (cents <= 0) throw new Error('amount_cents must be positive')

  const id = crypto.randomUUID()
  const nowFn = db?.dialect === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  await db.prepare(
    `INSERT INTO award_spend_entries
       (id, rule_id, amount_cents, spent_on, category, memo, proof_document_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${nowFn})`,
  ).run(
    id, String(ruleId), cents, spentOn || null,
    category ? String(category) : (rule.category || null),
    memo ? String(memo) : null,
    proofDocumentId ? String(proofDocumentId) : null,
    createdBy ? String(createdBy) : null,
  )
  return rowToEntry(await db.prepare('SELECT * FROM award_spend_entries WHERE id = ?').get(id))
}

export async function listSpendEntries(db, ruleId) {
  if (!db || !ruleId) return []
  await ensureSchema(db)
  const rows = await db.prepare(
    'SELECT * FROM award_spend_entries WHERE rule_id = ? ORDER BY COALESCE(spent_on, created_at) DESC',
  ).all(String(ruleId))
  return (rows || []).map(rowToEntry)
}

async function sumSpend(db, ruleId) {
  const row = await db.prepare(
    'SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS n FROM award_spend_entries WHERE rule_id = ?',
  ).get(String(ruleId))
  return { total: Number(row?.total || 0), count: Number(row?.n || 0) }
}

// ---------------------------------------------------------------------------
// Compliance math (pure given the rule + spend sum) — integer cents only
// ---------------------------------------------------------------------------

/**
 * Pure compute, separated so it's unit-testable without a db. Caller supplies
 * the rule and the already-summed spend (cents + entry count) plus a "now"
 * for deterministic overdue tests.
 *
 * status:
 *   - 'overdue' : a spend_by_date has passed and the requirement isn't met
 *   - 'over'    : a category_exact requirement has been exceeded
 *   - 'met'     : spend SUMS to (or exceeds, for minimums) the requirement
 *   - 'short'   : there is a required amount but spend is below it
 *   - 'on_track': no required amount (allowed_use / timeframe / other), not overdue
 */
export function computeComplianceSummaryFrom(rule, { spentCents = 0, entryCount = 0, now = new Date() } = {}) {
  const required = rule?.required_amount_cents ?? null
  const spent = Math.max(0, Math.round(Number(spentCents) || 0))
  const dueDate = rule?.spend_by_date || null
  const nowMs = (now instanceof Date ? now : new Date(now)).getTime()

  let daysLeft = null
  let isOverdue = false
  if (dueDate) {
    const dueMs = new Date(dueDate).getTime()
    if (Number.isFinite(dueMs)) {
      daysLeft = Math.ceil((dueMs - nowMs) / (24 * 60 * 60 * 1000))
      if (dueMs < nowMs) isOverdue = true
    }
  }

  let remaining = null
  let over = null
  let pct = null
  let met = false

  if (required !== null && required > 0) {
    remaining = Math.max(0, required - spent)
    over = Math.max(0, spent - required)
    pct = Math.min(100, Math.round((spent / required) * 100))
    // "met" requires ACTUAL logged spend summing to the requirement — never
    // auto-compliant without entries.
    met = entryCount > 0 && spent >= required
  } else {
    // No required amount: progress is just "has any proof been logged".
    remaining = null
    over = null
    pct = entryCount > 0 ? 100 : 0
    met = false
  }

  // Status precedence: overdue (and not yet met) dominates; then over; then met;
  // then short; else on_track.
  let status
  if (isOverdue && !met) {
    status = 'overdue'
  } else if (rule?.restriction_type === 'category_exact' && over !== null && over > 0) {
    status = 'over'
  } else if (required !== null && required > 0 && met) {
    status = 'met'
  } else if (required !== null && required > 0 && spent < required) {
    status = 'short'
  } else {
    status = 'on_track'
  }

  return {
    rule_id: rule?.id ?? null,
    restriction_type: rule?.restriction_type ?? null,
    category: rule?.category ?? null,
    required_cents: required,
    spent_cents: spent,
    remaining_cents: remaining,
    over_cents: over,
    pct,
    entry_count: entryCount,
    status,
    due_date: dueDate,
    days_left: daysLeft,
    is_overdue: isOverdue,
  }
}

/** DB-backed convenience: sums the rule's entries then computes the summary. */
export async function computeComplianceSummary(db, rule, { now = new Date() } = {}) {
  if (!db || !rule) return null
  await ensureSchema(db)
  const { total, count } = await sumSpend(db, rule.id)
  return computeComplianceSummaryFrom(rule, { spentCents: total, entryCount: count, now })
}

// ---------------------------------------------------------------------------
// Scholarship reconciliation (award vs school bill) — integer cents only
// ---------------------------------------------------------------------------

/**
 * Reconcile a scholarship/award against the school bill.
 *   bill           : total the school is charging (cents)
 *   covered        : portion of the bill the award pays = min(award, bill)
 *   left_to_pay    : bill not covered by the award = max(0, bill - award)
 *   extra_refund   : award beyond the bill (typically refundable) = max(0, award - bill)
 *
 * Pure. Negative inputs are clamped to 0 (you can't owe or be awarded negative).
 */
export function computeScholarshipReconciliation({ award_cents = 0, school_bill_cents = 0 } = {}) {
  const award = Math.max(0, Math.round(Number(award_cents) || 0))
  const bill = Math.max(0, Math.round(Number(school_bill_cents) || 0))
  const covered = Math.min(award, bill)
  const left_to_pay = Math.max(0, bill - award)
  const extra_refund = Math.max(0, award - bill)
  return {
    award_cents: award,
    bill_cents: bill,
    covered_cents: covered,
    left_to_pay_cents: left_to_pay,
    extra_refund_cents: extra_refund,
    fully_covered: left_to_pay === 0,
  }
}

// ---------------------------------------------------------------------------
// Observability: scan for overdue / short awards (for Anya + Sam)
// ---------------------------------------------------------------------------

/**
 * Scan all award compliance rules for ones that are OVERDUE or SHORT on
 * required spending (or OVER on an exact requirement). Returns a findings[]
 * shape mirroring scanHamiltonSessionReadiness so Sam can mine it directly.
 *
 * Read-only. Returns { ok, summary, findings: [...], rules_scanned } and never
 * throws on a missing table (returns an empty, ok result).
 */
export async function scanAwardComplianceFindings(db, { limit = 1000, now = new Date() } = {}) {
  if (!db) return { ok: false, summary: 'no db', findings: [], rules_scanned: 0 }
  await ensureSchema(db)

  let rules = []
  try {
    const rows = await db.prepare(
      'SELECT * FROM award_compliance_rules ORDER BY created_at DESC LIMIT ?',
    ).all(Number(limit) || 1000)
    rules = (rows || []).map(rowToRule)
  } catch {
    return { ok: true, summary: 'No award_compliance_rules table / no rules.', findings: [], rules_scanned: 0 }
  }

  const findings = []
  for (const rule of rules) {
    const summary = await computeComplianceSummary(db, rule, { now })
    if (!summary) continue

    if (summary.status === 'overdue') {
      findings.push({
        severity: 'high',
        category: 'award_compliance',
        title: `Award restriction OVERDUE: ${rule.title}`,
        description: `Profile ${rule.profile_id} has an award restriction "${rule.title}" whose spend-by date (${summary.due_date}) has passed and the required spend is not met (${summary.spent_cents}¢ of ${summary.required_cents ?? '?'}¢).`,
        evidence: { rule_id: rule.id, profile_id: rule.profile_id, grant_id: rule.grant_id, summary },
        recommended_fix: `Log compliant spending with proof for rule ${rule.id} or correct the spend-by date.`,
        confidence: 0.9,
      })
    } else if (summary.status === 'over') {
      findings.push({
        severity: 'medium',
        category: 'award_compliance',
        title: `Award category OVER requirement: ${rule.title}`,
        description: `Profile ${rule.profile_id} logged ${summary.spent_cents}¢ against an exact ${summary.required_cents}¢ requirement on "${rule.title}" — ${summary.over_cents}¢ over may be non-compliant.`,
        evidence: { rule_id: rule.id, profile_id: rule.profile_id, grant_id: rule.grant_id, summary },
        recommended_fix: `Review spend entries for rule ${rule.id}; over-spend on a restricted category can violate the award terms.`,
        confidence: 0.7,
      })
    } else if (summary.status === 'short') {
      findings.push({
        severity: 'medium',
        category: 'award_compliance',
        title: `Award restriction SHORT: ${rule.title}`,
        description: `Profile ${rule.profile_id} has logged only ${summary.spent_cents}¢ of a required ${summary.required_cents}¢ on "${rule.title}" (${summary.remaining_cents}¢ remaining${summary.days_left !== null ? `, ${summary.days_left} days left` : ''}).`,
        evidence: { rule_id: rule.id, profile_id: rule.profile_id, grant_id: rule.grant_id, summary },
        recommended_fix: `Upload proof and log the remaining ${summary.remaining_cents}¢ of compliant spending for rule ${rule.id}.`,
        confidence: 0.6,
      })
    }
  }

  return {
    ok: true,
    summary: findings.length
      ? `${findings.length} award restriction(s) overdue/short/over across ${rules.length} rule(s).`
      : `All ${rules.length} award restriction(s) on track.`,
    findings,
    rules_scanned: rules.length,
  }
}

export { RESTRICTION_TYPES }
