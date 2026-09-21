// A category word modifying a concrete object does not identify that object:
// "food processor" is equipment, not evidence of a need for food stamps.
const REQUEST_WORDS = new Set(['grant', 'grants', 'funding', 'assistance', 'help', 'support', 'program', 'programs', 'donation', 'donations', 'cost', 'costs'])
const CONTEXT_BOUNDARIES = new Set(['for', 'from', 'in', 'near', 'with', 'by'])
const OBJECT_HEADS = new Set(['equipment', 'machine', 'device', 'processor', 'dehydrator', 'refrigerator', 'fridge', 'freezer', 'oven', 'stove', 'microwave', 'vehicle', 'bus', 'van', 'truck', 'trailer', 'generator', 'printer', 'scanner', 'computer', 'laptop', 'tablet', 'chair', 'bed', 'lift', 'ramp', 'battery', 'pump', 'filter', 'compressor', 'ventilator', 'concentrator', 'monitor'])

export function constrainItemExpansion(itemText, expanded) {
  if (!expanded || expanded.curatedNeedCode) return expanded
  const key = String(expanded.matchedKey || '').toLowerCase()
  if (!/^[a-z]+$/.test(key)) return expanded
  const words = String(itemText || '').toLowerCase().match(/[a-z0-9]+/g) || []
  const index = words.indexOf(key)
  if (index < 0) return expanded
  const trailing = words.slice(index + 1)
  const boundary = trailing.findIndex(word => CONTEXT_BOUNDARIES.has(word))
  const objectWords = (boundary < 0 ? trailing : trailing.slice(0, boundary))
    .filter(word => word.length > 2 && !REQUEST_WORDS.has(word))
  // Unknown trailing language is not proof of a physical object. Preserve
  // valid needs such as food insecurity, legal fees and childcare expenses.
  if (!objectWords.some(word => OBJECT_HEADS.has(word))) return expanded
  return {...expanded, canonicalNeed:null, matchedKey:null, synonyms:[], programCategories:[]}
}
