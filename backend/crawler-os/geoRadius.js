// crawler-os/geoRadius.js
//
// ZIP-radius geography for profile discovery. The product rule is that "local"
// discovery covers a ~25-mile radius around the profile's ZIP — but query
// construction only ever knew the profile's own city/county name tokens, so a
// funder one town over (or across a county line) was unreachable. This module
// turns the profile ZIP into the distinct nearby towns inside that radius so
// the web-query builder can search them by name.
//
// Deterministic: the `zipcodes` / `zipcodes-nrviens` datasets are static; no
// I/O, no clock.

import zipcodes from 'zipcodes'
import zipcodesWithCounty from 'zipcodes-nrviens'

export const DEFAULT_RADIUS_MILES = 25

// The ring is a ZIP ring, and the `zipcodes` dataset names unique / business /
// PO-box / military ZIPs after their HOLDER: "City National Bank" (43265),
// "Tn Dept Of Human Svc", "Amsouth Bank", "Nashvl", "Census Bureau", "J B P H H",
// "Gap Inc Direct". The query builder promotes the NEAREST ring entry to two
// CORE queries, so a bank one mile from downtown was taking two of the ~6
// queries the live lane actually executes (hyperlocal-1, 2026-09-12; measured
// in 14 of the 51 Amy probe localities). Only populated places may pass.
const US_STATE_CODES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA',
  'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK',
  'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
  'PR', 'GU', 'VI', 'AS', 'MP',
])

// Tokens that name an organisation, a mail facility or a military installation
// — never a town. Whole-word, so "Bankhead" / "Cocoa" / "Incline Village" pass.
const NON_PLACE_STRONG = /\b(bancorp|dept|department|svc|svcs|service|services|inc|incorporated|corp|corporation|co|company|llc|ltd|ins|insurance|assc|assn|assoc|association|natl|lottery|univ|annex|firm|zip|brm|pmb|cpu|afb|afs|naval|navy yard|army|marine corps|mcb|medical center|med ctr|ctr|hospital|clinic|facility|fac|telephone|revenue|treasury|postal|parcel|shared|distribution|processing|fulfillment|catalog|publishing|magazine|airlines|motors|systems|technologies|industries|dial|casino|amsouth|greyhound)\b/i
// Tokens that ARE real town names somewhere ("White House, TN", "College
// Station, TX", "Federal Way, WA", "Institute, WV", "Camp Hill, PA", "Red
// Bank, NJ", "Banks, OR", "Electric City, WA", "Bureau, IL"). They only mark
// an artifact when the ZIP carries no county in the county-bearing dataset —
// unique/business ZIPs (43265 "City National Bank", 37237 "Amsouth Bank") are
// not assigned one; real towns are (measured 2026-09-12).
const NON_PLACE_WEAK = /\b(bank|banks|bureau|electric|house|ideas|craft|academy|life|direct|center|centre|institute|college|university|federal|national|camp|plaza|tower|mall|station|press|studio|studios|network|group|partners|foundation|trust|fund)\b/i
const INITIALS_CLUSTER = /(^|\s)[A-Za-z](\s[A-Za-z])+(\s|$)/
const VOWELS = /[aeiouy]/i

function letters(v) {
  return String(v ?? '').toLowerCase().replace(/[^a-z]/g, '')
}

// "Nashvl" for Nashville, "Bham" for Birmingham, "Hon" for Honolulu: a strict
// subsequence of the home city that is either very short or ends in a consonant
// cluster is a postal abbreviation of the home city, not a neighbouring town.
function isAbbreviationOf(candidate, home) {
  const c = letters(candidate)
  const h = letters(home)
  if (!c || !h || c.length >= h.length || c.length < 3) return false
  let i = 0
  for (const ch of h) if (ch === c[i]) i += 1
  if (i < c.length) return false
  return c.length <= 4 || !VOWELS.test(c.slice(-2))
}

function looksLikePlaceName(city, { hasCounty, homeNames }) {
  const name = String(city ?? '').trim()
  if (!name) return false
  if (/[\d()/&@#]/.test(name)) return false
  if (INITIALS_CLUSTER.test(name)) return false
  if (NON_PLACE_STRONG.test(name)) return false
  if (!hasCounty && NON_PLACE_WEAK.test(name)) return false
  const tokens = name.split(/\s+/)
  // "Cds Brm", "Kng Of Prussa": a vowel-less token of three or more letters is
  // a postal abbreviation; a name made of one repeated letter ("Aaa") is a filer.
  for (const t of tokens) {
    const l = letters(t)
    if (l.length >= 3 && !VOWELS.test(l)) return false
    if (l.length >= 3 && /^(.)\1+$/.test(l)) return false
  }
  for (const home of homeNames) if (isAbbreviationOf(name, home)) return false
  return true
}

/**
 * nearbyCities — distinct towns within `miles` of a US ZIP, nearest first.
 *
 * The profile's own city (and an optional explicit exclude) is omitted — the
 * query builder already covers it via the city/county phrases. Distances are
 * ZIP-centroid haversine (the same basis as matchEngine's geo scorer). Only
 * populated places are returned: the holder names of unique / business /
 * military ZIPs, postal abbreviations of the home city, and cross-border
 * (non-US) ring entries are dropped.
 *
 * @param {string|number} zip 5-digit US ZIP (ZIP+4 tolerated)
 * @param {{ miles?: number, max?: number, excludeCity?: string|null }} [opts]
 * @returns {Array<{city: string, state: string, miles: number|null}>}
 */
export function nearbyCities(zip, { miles = DEFAULT_RADIUS_MILES, max = 4, excludeCity = null } = {}) {
  const z = String(zip ?? '').trim().slice(0, 5)
  if (!/^\d{5}$/.test(z)) return []
  const home = zipcodes.lookup(z)
  if (!home) return []

  let ring
  try {
    ring = zipcodes.radius(z, miles)
  } catch {
    return []
  }
  if (!Array.isArray(ring) || ring.length === 0) return []

  const homeNames = [home.city, excludeCity].map((c) => String(c ?? '').trim()).filter(Boolean)
  const excluded = new Set(homeNames.map((c) => c.toLowerCase()))
  const seen = new Set()
  const out = []
  for (const nz of ring) {
    const info = zipcodes.lookup(nz)
    if (!info?.city || !info?.state) continue
    if (!US_STATE_CODES.has(String(info.state).toUpperCase())) continue
    const cityKey = `${info.city}|${info.state}`.toLowerCase()
    if (seen.has(cityKey) || excluded.has(info.city.toLowerCase())) continue
    let hasCounty = false
    try {
      hasCounty = Boolean(zipcodesWithCounty.lookup(String(nz))?.county)
    } catch {
      hasCounty = false
    }
    // A town is marked seen only once a ZIP of it PASSES: a real town can own
    // a nearer no-county secondary ZIP (Red Bank, NJ: 07709 at 5 mi, 07701 —
    // Monmouth — at 6 mi), and rejecting the town on that ZIP would lose it.
    if (!looksLikePlaceName(info.city, { hasCounty, homeNames })) continue
    seen.add(cityKey)
    const dist = zipcodes.distance(z, String(nz))
    out.push({
      city: info.city,
      state: info.state,
      miles: Number.isFinite(dist) ? dist : null,
    })
  }
  out.sort((a, b) => (a.miles ?? Number.MAX_SAFE_INTEGER) - (b.miles ?? Number.MAX_SAFE_INTEGER))
  return out.slice(0, Math.max(0, max))
}

export default { nearbyCities, DEFAULT_RADIUS_MILES }
