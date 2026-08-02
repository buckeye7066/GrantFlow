import { isRegionCode } from '../../shared/usStateCodes.js'

/**
 * Heuristic extraction of US state + ZIP from a freeform address line when
 * structured basic_information.state / .zip are empty (common when users paste
 * "Street, City, ST 12345" into a single address field).
 *
 * AN UNPARSEABLE LOCATION PRODUCES NO STATE — never a wrong one (2026-08-02).
 * The state pattern used to be `/,?\s*([A-Za-z]{2})\s+(\d{5})…$/`, with NO left
 * word boundary, so it matched the last two letters of a longer token: prod's
 * `profile-melissa-justus` carries `{ city:'Anytown', state:'USA',
 * zip_code:'12345' }`, whose address blob "…Anytown USA 12345" yielded the
 * state **"SA"**. Nothing downstream caught it — `zipcodes.lookup` only fires
 * when the state is EMPTY, and the county resolver just returned null on the
 * mismatch — so "SA" reached the county/city locator adapter and titled a real
 * catalog row `Anytown, SA — Local assistance programs near you (findhelp)`.
 *
 * Two independent defenses, because either alone still lies:
 *   1. WORD BOUNDARIES on both sides of the 2-letter capture, so a 3-letter
 *      token can never donate a suffix; and
 *   2. the capture must be a code in the canonical `shared/usStateCodes.js`
 *      REGISTRY. A shape check ("two letters") is not a validity check.
 * A ZIP found beside an unusable state is still returned — the ZIP is real and
 * `zipcodes.lookup` can now resolve the state honestly from it.
 *
 * @param {unknown} text
 * @returns {{ state: string|null, zip: string|null }}
 */
export function inferUsStateZipFromText(text) {
  if ((text === null || text === undefined) || typeof text !== 'string') return { state: null, zip: null }
  const s = text.replace(/\s+/g, ' ').trim()
  if (!s) return { state: null, zip: null }

  let m = s.match(/(?:^|[\s,])([A-Za-z]{2})(?![A-Za-z])[\s,]{0,3}(\d{5})(?:-\d{4})?$/i)
  if (m && isRegionCode(m[1])) return { state: m[1].toUpperCase(), zip: m[2] }
  // A trailing ZIP is still a real fact even when the token in front of it is
  // not a state — fall through to the ZIP-only branch rather than returning
  // a fabricated state.

  const zips = s.match(/\b(\d{5})(?:-\d{4})?\b/g)
  if (zips && zips.length > 0) {
    const raw = zips[zips.length - 1]
    const zip = raw.length >= 5 ? raw.slice(0, 5) : raw
    const idx = s.lastIndexOf(raw)
    const before = idx > 0 ? s.slice(0, idx) : s
    // Bounded quantifiers only (js/polynomial-redos): `s` is already
    // whitespace-collapsed and trimmed above, so `\s*` next to `$` adds no
    // capability — only ambiguous backtracking on a run of tabs.
    const sm = before.match(/(?:^|[,\s])([A-Za-z]{2})(?![A-Za-z]) ?,? ?$/i)
    if (sm && isRegionCode(sm[1])) return { state: sm[1].toUpperCase(), zip }
    return { state: null, zip }
  }

  return { state: null, zip: null }
}

function normState(v) {
  if ((v === null || v === undefined)) return null
  const t = String(v).trim()
  // Same rule as above: two letters is a SHAPE, the registry is the AUTHORITY.
  return isRegionCode(t) ? t.toUpperCase() : null
}

function normZip(v) {
  if ((v === null || v === undefined)) return null
  const d = String(v).replace(/\D/g, '')
  return d.length >= 5 ? d.slice(0, 5) : null
}

export function getExplicitStateZip(basic = {}, locationFocus = {}, org = null) {
  let state = normState(
    basic.state || locationFocus.state || locationFocus.primary_state || (org && org.state),
  )
  let zip = normZip(
    basic.zip ||
      basic.zip_code ||
      locationFocus.zip ||
      locationFocus.zip_code ||
      (org && (org.zip || org.postal_code)),
  )

  const addr = basic.address
  if (addr && typeof addr === 'object') {
    if (!state) state = normState(addr.state ?? addr.region)
    if (!zip) zip = normZip(addr.zip ?? addr.postal_code ?? addr.postal ?? addr.zip_code)
  }

  return { state: state || null, zip: zip || null }
}

export function collectAddressTextForInference(
  basic = {},
  locationFocus = {},
  org = null,
  comprehensive = null,
) {
  const parts = []
  const push = (v) => {
    if ((v === null || v === undefined)) return
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
  }

  push(basic.street_address)
  push(basic.street)
  push(basic.city)

  if (typeof basic.address === 'string') {
    push(basic.address)
  } else if (basic.address && typeof basic.address === 'object') {
    const a = basic.address
    ;['line1', 'line2', 'street', 'street1', 'address1', 'formatted'].forEach((k) => {
      if (typeof a[k] === 'string') push(a[k])
    })
    const cityLine = [a.city, a.state || a.region, a.zip || a.postal_code || a.postal || a.zip_code]
      .filter((x) => (x !== null && x !== undefined) && String(x).trim())
      .join(' ')
    push(cityLine)
  }

  push(locationFocus?.full_address)
  if (org && typeof org === 'object') {
    if (typeof org.address === 'string') push(org.address)
    push([org.city, org.state, org.zip].filter((x) => (x !== null && x !== undefined) && String(x).trim()).join(' '))
  }

  if (comprehensive && typeof comprehensive === 'object' && typeof comprehensive.address === 'string') {
    push(comprehensive.address)
  }

  return parts.join(' ')
}
