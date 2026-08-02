import { isRegionCode } from '../../shared/usStateCodes.js'

/**
 * Heuristic extraction of US state + ZIP from a freeform address line when
 * structured basic_information.state / .zip are empty.
 *
 * MUST STAY IN LOCKSTEP with `backend/utils/inferLocationFromAddress.js` —
 * see that file for why an unparseable location must produce NO state rather
 * than a wrong one (the `state:'USA'` → `"SA"` → "Anytown, SA" chain).
 *
 * @param {unknown} text
 * @returns {{ state: string|null, zip: string|null }}
 */
export function inferUsStateZipFromText(text) {
  if (text === null || typeof text !== 'string') return { state: null, zip: null }
  const s = text.replace(/\s+/g, ' ').trim()
  if (!s) return { state: null, zip: null }

  let m = s.match(/(?:^|[\s,])([A-Za-z]{2})(?![A-Za-z])[\s,]{0,3}(\d{5})(?:-\d{4})?$/i)
  if (m && isRegionCode(m[1])) return { state: m[1].toUpperCase(), zip: m[2] }

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
  if (v === null) return null
  const t = String(v).trim()
  return isRegionCode(t) ? t.toUpperCase() : null
}

function normZip(v) {
  if (v === null) return null
  const d = String(v).replace(/\D/g, '')
  return d.length >= 5 ? d.slice(0, 5) : null
}

/**
 * State/ZIP stored directly on basic_information / location_focus / nested basic.address object.
 */
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

/**
 * Build one string for regex inference (handles string or structured object address).
 */
export function collectAddressTextForInference(
  basic = {},
  locationFocus = {},
  org = null,
  comprehensive = null,
) {
  const parts = []
  const push = (v) => {
    if (v === null) return
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
      .filter((x) => x !== null && String(x).trim())
      .join(' ')
    push(cityLine)
  }

  push(locationFocus?.full_address)
  if (org && typeof org === 'object') {
    if (typeof org.address === 'string') push(org.address)
    push([org.city, org.state, org.zip].filter((x) => x !== null && String(x).trim()).join(' '))
  }

  if (comprehensive && typeof comprehensive === 'object' && typeof comprehensive.address === 'string') {
    push(comprehensive.address)
  }

  return parts.join(' ')
}
