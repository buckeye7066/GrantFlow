/**
 * usStateCodes.js — the ONE list of 2-letter region codes GrantFlow treats as a
 * real, specific (non-nationwide) place.
 *
 * WHY THIS IS SHARED (2026-08-02). `inferUsStateZipFromText` exists TWICE
 * (`backend/utils/` and `src/utils/`) and neither copy validated what it
 * extracted, so `basic_information.address = { city:'Anytown', state:'USA',
 * zip_code:'12345' }` produced the state code **"SA"** — the regex had no left
 * word boundary and matched the last two letters of "USA" in front of the ZIP.
 * That fabricated code then titled a real catalog row `Anytown, SA — Local
 * assistance programs near you (findhelp)`. A shape check ("two letters") is
 * not a validity check; only a REGISTRY is.
 *
 * `backend/utils/stateNormalization.js` owns the code→NAME map and is the
 * backend authority; this module is the code SET both layers can import.
 * A static drift tripwire keeps them equal
 * (`backend/tests/placeholderProfileSignals.test.js`).
 *
 * Scope note: Canadian provinces are included for the same reason
 * `stateNormalization.js` includes them — the national Geo Crawl tags Canadian
 * opportunities with a 2-letter province code and region-scoped matching must
 * resolve them.
 */

export const US_STATE_CODES = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
])

/** DC + the five inhabited US territories. */
export const US_TERRITORY_CODES = Object.freeze(['DC', 'PR', 'GU', 'VI', 'AS', 'MP'])

/** Canadian provinces & territories — see the scope note above. */
export const CA_PROVINCE_CODES = Object.freeze([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
])

/** Every code the geo model accepts as a specific region. */
export const REGION_CODES = Object.freeze(
  new Set([...US_STATE_CODES, ...US_TERRITORY_CODES, ...CA_PROVINCE_CODES]),
)

/**
 * isRegionCode — true iff `value` is one of the canonical codes. Case- and
 * whitespace-tolerant; everything else (including 'USA', 'SA', 'XX') is false.
 */
export function isRegionCode(value) {
  if (typeof value !== 'string') return false
  return REGION_CODES.has(value.trim().toUpperCase())
}

export default { US_STATE_CODES, US_TERRITORY_CODES, CA_PROVINCE_CODES, REGION_CODES, isRegionCode }
