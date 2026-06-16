/**
 * Shared pricing formatters. Kept in a non-component file to satisfy
 * `react-refresh/only-export-components`.
 */
export function formatMoney(n) {
  if (!Number.isFinite(Number(n))) return '$0'
  return `$${Math.round(Number(n)).toLocaleString()}`
}

export function formatMoneyDecimal(n) {
  if (!Number.isFinite(Number(n))) return '$0.00'
  return `$${Number(n).toFixed(2)}`
}

export function formatPercent(n) {
  if (!Number.isFinite(Number(n))) return '0%'
  return `${Number(n).toFixed(0)}%`
}

export function categoryLabel(c) {
  switch (c) {
    case 'individual': return 'Individual'
    case 'small': return 'Small Org'
    case 'mid_size': return 'Mid-Size'
    case 'large': return 'Large Org'
    default: return c || '—'
  }
}

export function statusLabel(status) {
  if (!status) return '—'
  return String(status)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
