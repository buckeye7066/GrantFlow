export function serviceStartingPrice(service) {
  const prices = (service.prices || []).filter(p => p.amount_cents !== null && Number.isFinite(Number(p.amount_cents)) && Number(p.amount_cents) >= 0)
  if (!prices.length) return null
  if (service.pricing_model !== 'milestone') return Math.min(...prices.map(p => Number(p.amount_cents)))
  const totals = new Map()
  for (const price of prices) totals.set(price.client_category, (totals.get(price.client_category) || 0) + Number(price.amount_cents))
  return Math.min(...totals.values())
}
