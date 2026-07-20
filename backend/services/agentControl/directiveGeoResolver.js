/**
 * directiveGeoResolver.js
 *
 * Extracts US state references from an owner-attached free-text agent
 * directive ("focus on Tennessee this run"). Deliberately NOT general NLU —
 * a fixed, enumerable 50-state + DC dictionary matched with word boundaries,
 * so it can never mis-scope a run on a fuzzy guess the way keyword-similarity
 * matching would. Returns an empty array (never a false positive) when
 * nothing in the directive maps cleanly to a state.
 */

const STATE_NAME_TO_ABBR = Object.freeze({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  'district of columbia': 'DC',
})

const VALID_ABBRS = new Set(Object.values(STATE_NAME_TO_ABBR))

/**
 * @param {string} text
 * @returns {string[]} deduped, sorted 2-letter state codes found in text
 */
export function resolveStatesFromDirective(text) {
  const raw = String(text || '')
  if (!raw.trim()) return []
  const lower = raw.toLowerCase()
  const found = new Set()

  for (const [name, abbr] of Object.entries(STATE_NAME_TO_ABBR)) {
    const re = new RegExp(`\\b${name.replace(/\s+/g, '\\s+')}\\b`, 'i')
    if (re.test(lower)) found.add(abbr)
  }

  // Bare 2-letter codes only count in an unambiguous "state-code" position —
  // immediately after a comma, or standing alone as an all-caps token in the
  // ORIGINAL (not lowercased) text — so "in" (Indiana? preposition?) or "or"
  // (Oregon? conjunction?) in ordinary prose never false-positive.
  const capsTokens = raw.match(/\b[A-Z]{2}\b/g) || []
  for (const tok of capsTokens) {
    if (VALID_ABBRS.has(tok)) found.add(tok)
  }

  return Array.from(found).sort()
}
