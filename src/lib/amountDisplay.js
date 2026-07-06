// Shared display fallback for grant/opportunity dollar amounts.
//
// Backed by the amount-visibility columns (amount_text / amount_status /
// amount_confidence, migrations 132 / pg 0136): when a row has no renderable
// numeric amount, it may still carry an honest excerpt ("up to $10,000 in
// scholarship support", "amounts vary") or an explicit status. Cards should
// show that instead of hiding the amount block or defaulting to a guess.

export const AMOUNT_STATUS_LABEL = Object.freeze({
  varies: 'Amount varies',
  contact_required: 'Contact funder for amount',
  not_listed: 'Amount not listed',
  estimated: 'Estimated amount',
})

/**
 * Best textual fallback when no numeric amount renders: the stored excerpt
 * first, then the explicit status label. Returns null when nothing is known
 * (callers keep their own final default, e.g. 'Not stated').
 */
export function amountTextFallback(row) {
  const text = typeof row?.amount_text === 'string' ? row.amount_text.trim() : ''
  if (text) return text
  const status = String(row?.amount_status || '').toLowerCase()
  return AMOUNT_STATUS_LABEL[status] ?? null
}

export default { AMOUNT_STATUS_LABEL, amountTextFallback }
