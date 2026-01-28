/**
 * Hourly billing rounding rules (canonical from Payment Sheet extract):
 * - 15-minute minimum
 * - billed in 6-minute increments
 */

export function roundBillableMinutes(rawMinutes, { minimumMinutes = 15, incrementMinutes = 6 } = {}) {
  const minutes = Math.max(0, Math.floor(Number(rawMinutes) || 0))
  const min = Math.max(1, Math.floor(Number(minimumMinutes) || 15))
  const inc = Math.max(1, Math.floor(Number(incrementMinutes) || 6))

  if (minutes <= 0) return 0
  const atLeastMin = minutes < min ? min : minutes
  return Math.ceil(atLeastMin / inc) * inc
}

export function hourlyRateToSixMinuteUnitCents(hourlyRateCents) {
  // 6 minutes = 0.1 hours, so per-unit amount is hourly / 10.
  const cents = Math.max(0, Math.floor(Number(hourlyRateCents) || 0))
  return Math.round(cents / 10)
}

