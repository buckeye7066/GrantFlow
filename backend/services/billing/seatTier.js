/**
 * seatTier.js — organization billing tier derived from the number of email
 * logins ("seats") on a profile.
 *
 *   small : 1 seat
 *   mid   : 2–5 seats
 *   large : 6+ seats
 *
 * Seats = the distinct member emails on the profile (profile_emails), EXCLUDING
 * the platform operator/admin email which is linked to every profile for
 * back-office visibility and is not a paid seat. Pure + deterministic so the
 * member-add route can warn before an addition bumps the tier.
 */

/**
 * Count paid seats from a list of profile-email rows (or strings): distinct,
 * lower-cased addresses, EXCLUDING the platform operator/admin emails that are
 * linked to every profile for back-office visibility.
 */
export function countSeats(emailRows = [], adminEmails = []) {
  const exclude = new Set((adminEmails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))
  const seats = new Set()
  for (const row of emailRows || []) {
    const email = String((row && typeof row === 'object' ? row.email : row) || '').trim().toLowerCase()
    if (email && !exclude.has(email)) seats.add(email)
  }
  return seats.size
}

export const SEAT_TIERS = Object.freeze([
  { key: 'small', label: 'Small organization', min: 0, max: 1, rank: 1 },
  { key: 'mid', label: 'Mid-sized organization', min: 2, max: 5, rank: 2 },
  { key: 'large', label: 'Large organization', min: 6, max: null, rank: 3 },
])

const BY_KEY = Object.fromEntries(SEAT_TIERS.map((t) => [t.key, t]))

/** The tier a given seat count falls into. */
export function seatTierFor(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  for (const t of SEAT_TIERS) {
    if (n >= t.min && (t.max === null || n <= t.max)) return t.key
  }
  return 'large'
}

export function tierRank(key) {
  return BY_KEY[key]?.rank ?? 0
}

/** Describe a tier for the count, incl. how many more seats until the next tier. */
export function describeSeatTier(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  const key = seatTierFor(n)
  const tier = BY_KEY[key]
  const next = SEAT_TIERS.find((t) => t.rank === tier.rank + 1) || null
  const seatsUntilNextTier = next ? Math.max(0, next.min - n) : null
  return {
    tier: key,
    label: tier.label,
    seats: n,
    min: tier.min,
    max: tier.max,
    next_tier: next ? next.key : null,
    next_tier_label: next ? next.label : null,
    seats_until_next_tier: seatsUntilNextTier,
  }
}

/**
 * Evaluate adding `addingCount` NET-new seats to a profile that currently has
 * `currentCount`. Returns the before/after tiers and whether the addition
 * crosses UP into a higher billing tier (which the caller should warn about and
 * require confirmation for).
 */
export function evaluateSeatChange(currentCount, addingCount) {
  const from = Math.max(0, Math.floor(Number(currentCount) || 0))
  const adding = Math.max(0, Math.floor(Number(addingCount) || 0))
  const to = from + adding
  const fromTier = seatTierFor(from)
  const toTier = seatTierFor(to)
  const crossesUp = tierRank(toTier) > tierRank(fromTier)
  return {
    from_seats: from,
    to_seats: to,
    adding,
    from_tier: fromTier,
    to_tier: toTier,
    from_tier_label: BY_KEY[fromTier]?.label || fromTier,
    to_tier_label: BY_KEY[toTier]?.label || toTier,
    crosses_up: crossesUp,
    warning: crossesUp
      ? `Adding ${adding} login${adding === 1 ? '' : 's'} takes this organization from ${BY_KEY[fromTier]?.label} `
        + `(${from} seat${from === 1 ? '' : 's'}) to ${BY_KEY[toTier]?.label} (${to} seats), which moves it to a higher billing tier.`
      : null,
  }
}
