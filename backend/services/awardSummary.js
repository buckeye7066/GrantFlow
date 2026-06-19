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
 * @returns {{ awarded:{count,total,items}, applied:{count,total,items}, total_in_play:number, all:Array }}
 */
export function buildAwardSummary({ aidEntries = [], collegeName = null, grantRows = [] } = {}) {
  const items = []

  for (const a of Array.isArray(aidEntries) ? aidEntries : []) {
    const secured = aidIsSecured(a?.status)
    items.push({
      name: a?.name || a?.title || 'Scholarship',
      amount: num(a?.amount),
      status: normStatus(a?.status) || 'awarded',
      secured,
      source: a?.source || null,
      from: collegeName || 'College financial aid',
      category: 'scholarship',
    })
  }

  for (const g of Array.isArray(grantRows) ? grantRows : []) {
    const awardedAmt = num(g?.amount_awarded)
    const amount = awardedAmt ?? num(g?.amount_requested) ?? num(g?.amount_max) ?? num(g?.amount_min)
    const status = normStatus(g?.status)
    const secured = awardedAmt !== null || SECURED_STATUSES.has(status)
    items.push({
      name: g?.title || 'Grant / funding',
      amount,
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

  return {
    awarded: { count: awarded.length, total: sum(awarded), items: awarded },
    applied: { count: applied.length, total: sum(applied), items: applied },
    total_in_play: sum(items),
    all: items,
  }
}
