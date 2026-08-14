/**
 * awardSummary.js — assemble a per-profile "award amounts and from where"
 * summary for the printable/PDF document.
 *
 * Pulls from both places award money lives:
 *   - committed-college financial-aid pipeline (scholarships/grants the student
 *     logged: name, amount, status, source), and
 *   - the grants pipeline (amount_awarded / amount_requested, funder, and the
 *     opportunity's sponsor / source URL).
 *
 * Pure: callers load the rows; this shapes + totals them. "Awarded" vs "applied"
 * mirrors the committed-college rule so the numbers match the workspace.
 */

const SECURED_STATUSES = new Set(['awarded', 'received', 'accepted'])
const PENDING_STATUSES = new Set(['applied', 'pending', 'in_review', 'submitted', 'follow_up'])

function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function normStatus(s) {
  return String(s || '').trim().toLowerCase()
}

/** Secured = money in hand. Status-less aid entries count as secured (legacy). */
function aidIsSecured(status) {
  const s = normStatus(status)
  if (!s) return true
  if (PENDING_STATUSES.has(s)) return false
  return !['declined', 'denied', 'rejected', 'withdrawn'].includes(s)
}

/**
 * @param {object} args
 * @param {Array} args.aidEntries  committed-college financial_aid_pipeline entries
 * @param {string|null} args.collegeName
 * @param {Array} args.grantRows   rows from grants (joined to funding_opportunities)
 * @returns {{
 *   awarded:{count,total,amount_unknown_count,items},
 *   applied:{count,total,amount_unknown_count,items},
 *   total_in_play:number,
 *   amount_unknown_count:number,
 *   all:Array
 * }}
 * Each item carries `amount_basis`: 'awarded' | 'reported' | 'requested' |
 * 'ceiling' | 'floor' | null. A `null` basis with a `null` amount means the
 * figure is UNKNOWN — it is never counted as $0 in any total.
 */
export function buildAwardSummary({ aidEntries = [], collegeName = null, grantRows = [] } = {}) {
  const items = []

  for (const a of Array.isArray(aidEntries) ? aidEntries : []) {
    const secured = aidIsSecured(a?.status)
    items.push({
      name: a?.name || a?.title || 'Scholarship',
      amount: num(a?.amount),
      // Self-reported by the student on the committed-college aid pipeline —
      // never a figure this system derived.
      amount_basis: num(a?.amount) === null ? null : 'reported',
      status: normStatus(a?.status) || 'awarded',
      secured,
      source: a?.source || null,
      from: collegeName || 'College financial aid',
      category: 'scholarship',
    })
  }

  for (const g of Array.isArray(grantRows) ? grantRows : []) {
    const awardedAmt = num(g?.amount_awarded)
    const status = normStatus(g?.status)
    const secured = awardedAmt !== null || SECURED_STATUSES.has(status)

    // AWARDED MONEY IS ONLY WHAT WAS AWARDED.
    // The old chain was `amount_awarded ?? amount_requested ?? amount_max ??
    // amount_min` applied to EVERY row, so a grant marked 'awarded' whose
    // amount_awarded is NULL reported the applicant's ASK — or, worse, the
    // funder's published CEILING off the catalog row — as money received, and
    // that figure was summed into `awarded.total` on the printable packet.
    // A request and a ceiling are claims about what was possible, never about
    // what was granted (same rule as enforceGrantAmountBackfill, which never
    // invents a value). An awarded row with no awarded figure now reports a
    // NULL amount and is counted in `amount_unknown_count`, so "we do not know
    // the figure" can never read as "$0" or as an invented total.
    let amount = null
    let amountBasis = null
    if (secured) {
      amount = awardedAmt
      amountBasis = awardedAmt === null ? null : 'awarded'
    } else if (num(g?.amount_requested) !== null) {
      amount = num(g.amount_requested)
      amountBasis = 'requested'
    } else if (num(g?.amount_max) !== null) {
      amount = num(g.amount_max)
      amountBasis = 'ceiling'
    } else if (num(g?.amount_min) !== null) {
      amount = num(g.amount_min)
      amountBasis = 'floor'
    }

    items.push({
      name: g?.title || 'Grant / funding',
      amount,
      // Names WHERE the number came from so a surface can label an ask or a
      // published ceiling as such instead of rendering it as a plain dollar
      // figure beside real awarded money.
      amount_basis: amountBasis,
      status: status || (secured ? 'awarded' : 'applied'),
      secured,
      // "From where": prefer the opportunity sponsor/funder; source = the portal/URL.
      from: g?.funder || g?.sponsor || g?.organization_name || g?.source || null,
      source: g?.source_url || g?.url || null,
      category: 'grant',
    })
  }

  const awarded = items.filter((i) => i.secured)
  const applied = items.filter((i) => !i.secured)
  const sum = (arr) => arr.reduce((s, i) => s + (i.amount || 0), 0)
  // A row whose figure we do not know is NOT a $0 row. Reporting the count
  // beside the total is what stops a partial total reading as a complete one.
  const unknown = (arr) => arr.filter((i) => i.amount === null || i.amount === undefined).length

  return {
    awarded: {
      count: awarded.length,
      total: sum(awarded),
      amount_unknown_count: unknown(awarded),
      items: awarded,
    },
    applied: {
      count: applied.length,
      total: sum(applied),
      amount_unknown_count: unknown(applied),
      items: applied,
    },
    total_in_play: sum(items),
    amount_unknown_count: unknown(items),
    all: items,
  }
}
