/**
 * Pure presentation helpers for the Funding Library views.
 *
 * Kept in their own module so React Refresh / Fast Refresh stays correctly
 * scoped to component files.
 */

export function formatAmount(min, max, desc) {
  if (desc) return desc
  if (!min && !max) return '—'
  const fmt = (n) =>
    n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${n}`
  if (min && max && min !== max) return `${fmt(min)}–${fmt(max)}`
  return fmt(max || min)
}

export function formatDeadline(d, type) {
  if (type === 'rolling' || type === 'ongoing') return type
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString()
  } catch {
    return String(d)
  }
}
