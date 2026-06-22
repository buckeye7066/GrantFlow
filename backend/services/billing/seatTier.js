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
 *
 * IMPORTANT — single source of truth: the seat→tier thresholds here are NOT
 * hand-maintained; they are DERIVED from shared/tierCatalog.js (the canonical
 * tier catalog) so the seat tier, the displayed seat count, and the billed
 * `mid_size`/`small_org`/`large_org` thresholds can never drift apart. The
 * short keys (small/mid/large) map 1:1 onto the catalog org tier ids.
 */
import { TIERS as CATALOG_TIERS } from '../../../shared/tierCatalog.js'

/**
 * The billable email addresses on a profile: distinct, lower-cased, EXCLUDING
 * the platform operator/admin emails that are linked to every profile for
 * back-office visibility. This is the ONE definition of "a seat" — the seat
 * count, the rendered login list, and the tier all derive from this same set,
 * so the count can never be off-by-one from the list.
 *
 * Returns the original row objects (de-duplicated by lower-cased email) so
 * callers can render the same list they count.
 */
export function billableSeatEmails(emailRows = [], adminEmails = []) {
  const exclude = new Set((adminEmails || []).map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))
  const seen = new Set()
  const out = []
  for (const row of emailRows || []) {
    const email = String((row && typeof row === 'object' ? row.email : row) || '').trim().toLowerCase()
    if (!email || exclude.has(email) || seen.has(email)) continue
    seen.add(email)
    out.push(row)
  }
  return out
}

/**
 * Count paid seats from a list of profile-email rows (or strings): distinct,
 * lower-cased addresses, EXCLUDING the platform operator/admin emails that are
 * linked to every profile for back-office visibility. Equals the length of
 * billableSeatEmails — the SAME set the UI lists.
 */
export function countSeats(emailRows = [], adminEmails = []) {
  return billableSeatEmails(emailRows, adminEmails).length
}

// Map the catalog org tier ids to the short keys this module exposes. Ordered
// by the catalog's own seat_range so rank/min/max follow the SoT.
const ORG_TIER_KEY_BY_ID = Object.freeze({ small_org: 'small', mid_size: 'mid', large_org: 'large' })

// Build SEAT_TIERS straight from the catalog's organization tiers + seat_range,
// so e.g. small = {min:1,max:1}, mid = {min:2,max:5}, large = {min:6,max:null}
// are exactly what's billed. Sorted by min ascending → stable rank.
export const SEAT_TIERS = Object.freeze(
  CATALOG_TIERS
    .filter((t) => t.family === 'organization' && t.seat_range && ORG_TIER_KEY_BY_ID[t.id])
    .map((t) => ({
      key: ORG_TIER_KEY_BY_ID[t.id],
      tier_id: t.id,
      label: t.name,
      min: t.seat_range.min,
      max: t.seat_range.max,
    }))
    .sort((a, b) => a.min - b.min)
    .map((t, i) => ({ ...t, rank: i + 1 })),
)

const BY_KEY = Object.fromEntries(SEAT_TIERS.map((t) => [t.key, t]))

/**
 * The tier a given seat count falls into. Mirrors tierCatalog.orgTierForSeats:
 * a count below the smallest tier's min (e.g. 0 seats) maps to the smallest org
 * tier, since an organization is always billed at least the small tier.
 */
export function seatTierFor(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0))
  for (const t of SEAT_TIERS) {
    if (n >= t.min && (t.max === null || n <= t.max)) return t.key
  }
  // Below the smallest tier's minimum → smallest org tier (treated as that tier).
  return SEAT_TIERS[0]?.key ?? 'small'
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
