import { isValidState, normalizeState } from '../utils/stateNormalization.js'

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

export default { TITLE_STATE_RX, TITLE_NEAR_STATE_RX, declaredStateFromTitle }
