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
  // We have not found a figure. Nobody may have looked yet — this is the
  // extractor's default, i.e. SILENCE about the funder, so the label says
  // what is true of US.
  not_listed: 'Amount not listed',
  // We READ the funder's own page/API and it states no per-award figure
  // (enforceAmountEnrichment, AMOUNT_STATUS_NONE_PUBLISHED). That is a fact
  // about the FUNDER and a strictly better thing to tell the user than
  // "not listed" — and far better than the bare "Not stated" a caller would
  // otherwise fall back to. Benefit programs, food banks and 211-style
  // services are real, valuable matches that simply publish no award size;
  // rendering them as an absence is how a full pipeline reads as
  // "qualifies for nothing" (the pipelineValue.js doctrine).
  none_published: 'Funder states no set amount',
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
