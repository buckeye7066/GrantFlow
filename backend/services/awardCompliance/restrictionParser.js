/**
 * restrictionParser.js
 *
 * Pure, dependency-free heuristics that read an awarded funding source's
 * free-text fields (amount_description / eligibility / notes / requirements)
 * and surface DRAFT restriction rules a human must confirm.
 *
 * CONSERVATISM IS THE WHOLE POINT. This subsystem tracks real money for real
 * compliance (including a minor's grants). The parser therefore:
 *
 *   - NEVER invents a number. Every cents value it returns came verbatim from
 *     the text. If a phrase mentions a category but no dollar figure, no rule
 *     with a required amount is produced.
 *   - returns rules flagged `draft: true` with a `confidence` score and the
 *     `source_excerpt` it matched, so the UI can show the user exactly what it
 *     read before they confirm.
 *   - prefers MISSING a restriction to FABRICATING one. When in doubt it emits
 *     nothing.
 *
 * No DB, no I/O — trivially unit-testable.
 */

// ---------------------------------------------------------------------------
// Money parsing (integer cents only — never floats in the data model)
// ---------------------------------------------------------------------------

/**
 * Parse a US-dollar money token (e.g. "$1,000", "$500.50", "1000 dollars")
 * into integer cents. Returns null when the token isn't a clean money value.
 * Deliberately strict: we only accept a leading `$` OR a trailing
 * dollars/USD word so we don't mistake an unrelated number (e.g. "90 days")
 * for an amount.
 */
export function parseMoneyToCents(raw) {
  if (raw === null || raw === undefined) return null
  const text = String(raw).trim()
  if (!text) return null

  // $1,000  |  $1,000.50  |  $500
  const dollarSign = text.match(/\$\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?/)
  // 1000 dollars  |  1,000 USD
  const trailingWord = text.match(/\b([0-9][0-9,]*)(?:\.([0-9]{1,2}))?\s*(?:dollars?|usd)\b/i)
  const m = dollarSign || trailingWord
  if (!m) return null

  const whole = m[1].replace(/,/g, '')
  if (!/^[0-9]+$/.test(whole)) return null
  const cents = m[2] ? (m[2].length === 1 ? `${m[2]}0` : m[2]) : '00'
  const dollars = Number(whole)
  if (!Number.isFinite(dollars)) return null
  return dollars * 100 + Number(cents)
}

// ---------------------------------------------------------------------------
// Category normalisation
// ---------------------------------------------------------------------------

// Canonical spend categories we recognise. The value is the canonical label;
// the keys are case-insensitive trigger words/phrases found in award text.
const CATEGORY_SYNONYMS = Object.freeze({
  supplies: 'supplies',
  'school supplies': 'supplies',
  materials: 'supplies',
  equipment: 'equipment',
  technology: 'technology',
  tech: 'technology',
  computer: 'technology',
  computers: 'technology',
  laptop: 'technology',
  books: 'books',
  textbooks: 'books',
  tuition: 'tuition',
  travel: 'travel',
  transportation: 'travel',
  food: 'food',
  meals: 'food',
  housing: 'housing',
  rent: 'housing',
  training: 'training',
  'professional development': 'training',
})

// Longest phrases first so "school supplies" wins over "supplies".
const CATEGORY_KEYS_BY_LENGTH = Object.freeze(
  Object.keys(CATEGORY_SYNONYMS).sort((a, b) => b.length - a.length),
)

function detectCategory(text) {
  const lower = String(text || '').toLowerCase()
  for (const key of CATEGORY_KEYS_BY_LENGTH) {
    // Word-boundary match so "tech" doesn't fire inside "technically".
    const re = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    if (re.test(lower)) return CATEGORY_SYNONYMS[key]
  }
  return null
}

// ---------------------------------------------------------------------------
// Sentence splitting (keep excerpts short + human-readable)
// ---------------------------------------------------------------------------
function splitClauses(text) {
  // Break on sentence punctuation AND commas. Real grant phrasing buries the
  // operative restriction in a sub-clause ("Of this $1000 grant, $500 must be
  // spent on supplies"); splitting on the comma keeps the $500 token attached
  // to "supplies" instead of letting the leading $1000 win the money match.
  return String(text || '')
    .split(/[.;\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

// ---------------------------------------------------------------------------
// Restriction extraction
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DraftRule
 * @property {boolean} draft                  always true (heuristic; needs confirmation)
 * @property {'category_minimum'|'category_exact'|'timeframe'|'allowed_use'|'other'} restriction_type
 * @property {string|null} category           canonical category, when one was detected
 * @property {number|null} required_amount_cents
 * @property {number|null} spend_by_days       relative timeframe (days from disbursement)
 * @property {string} title
 * @property {string} description
 * @property {string} source_excerpt          the exact clause matched
 * @property {number} confidence              0..1
 */

/**
 * Parse free text into draft restriction rules. Pure: returns an array
 * (possibly empty). NEVER throws on bad input.
 *
 * @param {string} text
 * @returns {DraftRule[]}
 */
export function parseRestrictionPhrases(text) {
  const clauses = splitClauses(text)
  const rules = []
  const seen = new Set()

  for (const clause of clauses) {
    const lower = clause.toLowerCase()

    // --- Timeframe: "spend within 90 days", "must be used within 60 days" ---
    const timeMatch = lower.match(/within\s+([0-9]{1,4})\s*(day|days|week|weeks|month|months)\b/)
    if (timeMatch && /\b(spend|spent|use|used|expend|disburse)/.test(lower)) {
      const n = Number(timeMatch[1])
      const unit = timeMatch[2]
      if (Number.isFinite(n) && n > 0) {
        const days = unit.startsWith('week') ? n * 7 : unit.startsWith('month') ? n * 30 : n
        const key = `timeframe:${days}`
        if (!seen.has(key)) {
          seen.add(key)
          rules.push({
            draft: true,
            restriction_type: 'timeframe',
            category: detectCategory(clause),
            required_amount_cents: null,
            spend_by_days: days,
            title: `Spend within ${n} ${unit}`,
            description: `Funds must be spent within ${n} ${unit} of disbursement.`,
            source_excerpt: clause,
            confidence: clamp01(0.7),
          })
        }
      }
    }

    // --- Category amount: "$500 must be spent on supplies",
    //     "at least $500 for supplies", "spend $500 on supplies" ---
    const cents = parseMoneyToCents(clause)
    const category = detectCategory(clause)
    const mentionsSpend = /\b(spend|spent|must be (?:used|spent)|used (?:for|on|toward)|allocated|reserved|earmarked|go(?:es)? toward|for)\b/.test(lower)

    if (cents !== null && category && mentionsSpend) {
      // "at least" / "minimum" / "no less than" => minimum; otherwise treat a
      // bare "$X must be spent on Y" as an EXACT category requirement (the
      // common grant phrasing), which is the conservative reading (it caps too).
      const isMinimum = /\b(at least|minimum|no less than|or more)\b/.test(lower)
      const restriction_type = isMinimum ? 'category_minimum' : 'category_exact'
      const key = `cat:${category}:${cents}:${restriction_type}`
      if (!seen.has(key)) {
        seen.add(key)
        rules.push({
          draft: true,
          restriction_type,
          category,
          required_amount_cents: cents,
          spend_by_days: null,
          title: `${isMinimum ? 'At least ' : ''}$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: cents % 100 ? 2 : 0 })} on ${category}`,
          description: clause,
          source_excerpt: clause,
          confidence: clamp01(isMinimum ? 0.75 : 0.7),
        })
      }
      continue
    }

    // --- Allowed-use (no amount): "may only be used for tuition",
    //     "restricted to books" — captures the constraint without a number. ---
    if (category && /\b(only|solely|exclusively|restricted to|limited to|must be used (?:for|on)|may (?:only )?be used (?:for|on))\b/.test(lower)) {
      const key = `use:${category}`
      if (!seen.has(key)) {
        seen.add(key)
        rules.push({
          draft: true,
          restriction_type: 'allowed_use',
          category,
          required_amount_cents: null,
          spend_by_days: null,
          title: `Restricted to ${category}`,
          description: `Funds may only be used for ${category}.`,
          source_excerpt: clause,
          confidence: clamp01(0.6),
        })
      }
    }
  }

  return rules
}

/**
 * Build draft rules from a grant-shaped record. Collects the free-text fields
 * grants carry and runs the parser over each, de-duplicating across fields.
 * Returns [] when nothing parseable is found (the user adds rules manually).
 *
 * @param {object} grant  a grants-table row (or award-shaped object)
 * @returns {DraftRule[]}
 */
export function deriveDraftRulesFromGrant(grant) {
  if (!grant || typeof grant !== 'object') return []
  const fields = [
    grant.amount_description,
    grant.eligibility,
    grant.eligibility_summary,
    grant.requirements,
    grant.notes,
    grant.program_description,
    grant.selection_criteria,
  ]
  const out = []
  const seen = new Set()
  for (const field of fields) {
    if (!field) continue
    for (const rule of parseRestrictionPhrases(field)) {
      const key = `${rule.restriction_type}:${rule.category || ''}:${rule.required_amount_cents ?? ''}:${rule.spend_by_days ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(rule)
    }
  }
  return out
}
