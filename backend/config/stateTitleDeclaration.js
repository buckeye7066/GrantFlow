import { isValidState, normalizeState } from '../utils/stateNormalization.js'

/**
 * A locator title states its place as `"<Place>, XX — <what it is>"`. Only that
 * exact machine-minted shape is trusted: an arbitrary two-letter token anywhere
 * in a title is a coincidence, while comma + state code + separator is a
 * declaration the row makes about itself.
 */
export const TITLE_STATE_RX = /,\s*([A-Za-z]{2})\s*(?:—|–|-{1,2})\s/

/** The real U.S. state a row declares in its own title, or null. */
export function declaredStateFromTitle(rowOrTitle) {
  const title = typeof rowOrTitle === 'string'
    ? rowOrTitle
    : String(rowOrTitle?.title ?? rowOrTitle?.name ?? '')
  if (!title) return null
  const match = TITLE_STATE_RX.exec(title)
  if (!match) return null
  const code = normalizeState(match[1])
  return code && isValidState(code) ? code : null
}

export default { TITLE_STATE_RX, declaredStateFromTitle }
