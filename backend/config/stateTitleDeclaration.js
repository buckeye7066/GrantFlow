import { isValidState, normalizeState, stateFullName } from '../utils/stateNormalization.js'
import { US_STATE_CODES } from '../../shared/usStateCodes.js'

/**
 * A locator title states its place as `"<Place>, XX — <what it is>"`. Only that
 * exact machine-minted shape is trusted: an arbitrary two-letter token anywhere
 * in a title is a coincidence, while comma + state code + separator is a
 * declaration the row makes about itself.
 */
export const TITLE_STATE_RX = /,\s*([A-Za-z]{2})\s*(?:—|–|-{1,2})\s/

/**
 * A findhelp/locator title also states its place as `"… near <City>, XX"` with
 * NO trailing separator — e.g. "Community Action Agency near Big Piney, WY",
 * "United Way near Austin, TX", "Community Action Agency near Auburn, ME". The
 * state code is the LAST token after an explicit `near <City>,` phrase, so it is
 * a declaration the row makes about its own location, not a stray two-letter
 * coincidence. Anchored at end-of-string and gated behind `near` + a city name
 * so it never fires on an arbitrary trailing pair. (Real out-of-state locators a
 * TN profile carried at "waiting for review", 2026-08-22.)
 */
export const TITLE_NEAR_STATE_RX = /\bnear\s+[A-Za-z][A-Za-z.'\-\s]*?,\s*([A-Za-z]{2})\s*$/


/**
 * A row's OWN URL can declare its place as plainly as its title does:
 * `help.sengov.com/posts/assistance-programs-madison-county-kentucky-and-richmond`,
 * `domore24delaware.org/fundraisers/...`. Prod 2026-09-07: an Indiana senior's
 * pipeline held a Kentucky county listing and a Delaware charity because
 * their state column was NULL and "missing is neutral" let them through.
 *
 * Only a FULL state name, as a whole token of the host or path (separators
 * `-`, `_`, `.`, `/`), counts - never a two-letter code (a coincidence magnet)
 * and never "washington" (Washington County / D.C. / George Washington).
 * Longest names match first so "west virginia" is never read as Virginia.
 */
export const URL_STATE_NAME_EXCLUDED = Object.freeze(new Set(['WA']))

const URL_STATE_NAMES = Object.freeze(
  US_STATE_CODES
    .filter((code) => !URL_STATE_NAME_EXCLUDED.has(code))
    .map((code) => ({ code, name: String(stateFullName(code) || '').toLowerCase() }))
    .filter((x) => x.name)
    .sort((a, b) => b.name.length - a.name.length),
)

function urlTokensOf(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  let hostAndPath = raw
  try {
    const u = new URL(raw)
    hostAndPath = `${u.hostname} ${u.pathname}`
  } catch {
    hostAndPath = raw.replace(/^https?:\/\//i, '').split(/[?#]/)[0]
  }
  return ` ${hostAndPath.toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `
}

/**
 * The state a row's own SPONSOR names — "Tennessee Department of Disability and
 * Aging", "Indiana Housing and Community Development Authority".
 *
 * A state agency's NAME is a claim the funder makes about ITSELF, which is the
 * doctrine this file already applies to URLs: a state column is a claim about a
 * CRAWL, a name is a claim about the row. Measured on prod 2026-09-08, an
 * Indiana senior was accepted for "Senior Center Grant" (Tennessee Department
 * of Disability) and "Ohio Homestead Exemption for Seniors and Disabled" — both
 * stamped national with a NULL state, so every geography gate passed them.
 *
 * FULL names only, longest-first, Washington excluded — the same conservatism
 * as the URL rule, because a two-letter code is a coincidence magnet.
 * Deliberately requires a GOVERNMENTAL word alongside the name: "New York Life
 * Foundation" is a national insurer, not a New York agency.
 */
const GOVERNMENTAL_RX = /\b(department|division|commission|authority|agency|bureau|office|state of|governor|treasurer|comptroller|exemption|housing finance)\b/i

export function declaredStateFromSponsorName(row) {
  if (!row || typeof row !== 'object') return null
  const sponsor = String(row.sponsor ?? '').trim()
  if (!sponsor || !GOVERNMENTAL_RX.test(sponsor)) return null
  const hay = ` ${sponsor.toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `
  for (const { code, name } of URL_STATE_NAMES) {
    if (hay.includes(` ${name} `)) return isValidState(code) ? code : null
  }
  return null
}

/** The real U.S. state a row declares in its own URLs (url / application_url / source_url / evidence_url / apply_url), or null. */
export function declaredStateFromUrls(row) {
  if (!row || typeof row !== 'object') return null
  for (const field of ['url', 'application_url', 'source_url', 'evidence_url', 'apply_url']) {
    const tokens = urlTokensOf(row[field])
    if (!tokens) continue
    for (const { code, name } of URL_STATE_NAMES) {
      if (tokens.includes(` ${name} `)) return isValidState(code) ? code : null
    }
  }
  return null
}

/** The real U.S. state a row declares in its own title, or null. */
export function declaredStateFromTitle(rowOrTitle) {
  const title = typeof rowOrTitle === 'string'
    ? rowOrTitle
    : String(rowOrTitle?.title ?? rowOrTitle?.name ?? '')
  if (!title) return null
  const match = TITLE_STATE_RX.exec(title) || TITLE_NEAR_STATE_RX.exec(title)
  if (!match) return null
  const code = normalizeState(match[1])
  return code && isValidState(code) ? code : null
}

export default { TITLE_STATE_RX, TITLE_NEAR_STATE_RX, declaredStateFromTitle, declaredStateFromSponsorName, declaredStateFromUrls, URL_STATE_NAME_EXCLUDED }
