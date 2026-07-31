/**
 * Coerce any "reason"-shaped value into a single human-readable string for
 * rendering inside `<Badge>{x}</Badge>`, `<li>{x}</li>`, etc.
 *
 * Why this exists:
 *   React error #31 ("Objects are not valid as a React child …found: object
 *   with keys {reason, source}") repeatedly crashes profile / matcher routes
 *   when the backend (or any future change to it) returns a `match_reasons`
 *   or `trust_reasons` array containing structured objects instead of plain
 *   strings. We've already had to harden this contract once for `[fieldDisplay]`
 *   warnings on profile sections; this is the same class of bug for match-
 *   reason rendering. The fix has to be at the renderer, because we cannot
 *   guarantee every backend producer (matchEngine, opportunityTrust, ad-hoc
 *   facet scorers, third-party integrations) will keep emitting strings.
 *
 * Contract:
 *   - Always returns a string. Never throws. Never returns `undefined`.
 *   - Empty string for null/undefined/empty-object so the JSX doesn't render
 *     stray "[object Object]" or "{}" badges.
 *   - For objects, tries common human-readable fields in priority order; if
 *     none are present, falls back to a key=value join (truncated). Last
 *     resort is JSON.stringify, again truncated, so we still get a single
 *     stable string — never a thrown render.
 */

const HUMAN_TEXT_KEYS = [
  'label',
  'text',
  'message',
  'reason',
  'name',
  'title',
  'description',
  'summary',
]

const MAX_DISPLAY_LENGTH = 240

function truncate(value) {
  const str = String(value ?? '')
  if (str.length <= MAX_DISPLAY_LENGTH) return str
  return `${str.slice(0, MAX_DISPLAY_LENGTH - 1)}…`
}

function formatPrimitive(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return null
}

export function formatReasonText(value) {
  const primitive = formatPrimitive(value)
  if (primitive !== null) return truncate(primitive)

  if (Array.isArray(value)) {
    return truncate(
      value
        .map((entry) => formatReasonText(entry))
        .filter((s) => s.length > 0)
        .join(', '),
    )
  }

  if (typeof value !== 'object') {
    try {
      return truncate(String(value))
    } catch {
      return ''
    }
  }

  // First, prefer a known human-readable field. The order matters: a
  // `{reason: 'X', source: 'Y'}` object should render as the human reason,
  // optionally annotated with the source — never as raw JSON.
  for (const key of HUMAN_TEXT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const inner = formatPrimitive(value[key])
      if (typeof inner === 'string' && inner.length > 0) {
        const source = formatPrimitive(value.source)
        if (source && key !== 'source' && key !== 'reason') return truncate(inner)
        if (source && key === 'reason') return truncate(`${inner} (${source})`)
        return truncate(inner)
      }
    }
  }

  // No known field matched. Fall back to a stable key=value summary so the
  // user still sees something diagnostic, but never crashes the render.
  try {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .slice(0, 4)
      .map(([k, v]) => {
        const formatted = formatPrimitive(v)
        return formatted !== null ? `${k}: ${formatted}` : `${k}: …`
      })
    if (entries.length === 0) return ''
    return truncate(entries.join(', '))
  } catch {
    try {
      return truncate(JSON.stringify(value))
    } catch {
      return ''
    }
  }
}

/**
 * Coerce an array of mixed-shape reasons to an array of plain strings,
 * with empty entries removed. Use this when you `.map()` a reasons list
 * into JSX so a single bad entry can't crash the whole component.
 */
export function formatReasonList(values) {
  if (!Array.isArray(values)) {
    if (values === null || values === undefined) return []
    return [formatReasonText(values)].filter((s) => s.length > 0)
  }
  return values.map((entry) => formatReasonText(entry)).filter((s) => s.length > 0)
}

// Friendly labels for the known matching-reason CODES the backend emits
// (backend/services/matching/reasons.js). formatReasonText() only guarantees a
// string; this turns raw snake_case codes like `keyword_match` into
// human-readable text so search cards never show internal identifiers.
const MATCH_REASON_LABELS = Object.freeze({
  keyword_match: 'Matches your keywords',
  geographic_match: 'In your geographic area',
  applicant_type_match: 'Fits your applicant type',
  amount_fit: 'Funding amount fits your needs',
  review_score: 'Strong overall fit',
  eligibility_match: 'You meet the eligibility',
  focus_area_match: 'Matches your focus areas',
  deadline_open: 'Deadline is still open',
  // Category slugs measured in production 2026-07-31, by frequency over
  // profile_opportunity_matches.match_reasons (education 5314, individual
  // 4832, housing 3103, health_medical 2668, nonprofit_ministry 1481, ...).
  // These render as the "Why This Matches" badges; without an entry the
  // title-case fallback below still prevents raw snake_case, but curated
  // copy reads better ("Health & medical" vs "Health medical").
  education: 'Education',
  individual: 'Individual applicant',
  housing: 'Housing',
  health_medical: 'Health & medical',
  nonprofit_ministry: 'Nonprofit / ministry',
  business: 'Small business',
  veteran: 'Veteran',
  food: 'Food security',
  caregiving: 'Caregiving',
  programs: 'Programs & services',
  energy: 'Energy & utilities',
  emergency: 'Emergency need',
  family_life: 'Family circumstances',
  employment: 'Employment',
  disability: 'Disability',
  government: 'Government benefit',
  technology_equipment: 'Technology & equipment',
  transportation: 'Transportation',
  agriculture: 'Agriculture',
  farm: 'Farming',
  capital: 'Capital & facilities',
  research_arts: 'Research & arts',
  operations: 'Operating support',
  infrastructure: 'Infrastructure',
  legal: 'Legal aid',
  fafsa: 'FAFSA on file',
  pell: 'Pell-eligible',
  trusted_source: 'Trusted source',
})

/**
 * Humanize a single match-reason value. Known codes map to a friendly label;
 * any other snake_case/identifier is title-cased (keyword_match → "Keyword
 * match"). Already-human sentences (containing a space) pass through unchanged.
 */
export function humanizeMatchReason(value) {
  const text = formatReasonText(value).trim()
  if (!text) return ''
  const key = text.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(MATCH_REASON_LABELS, key)) {
    return MATCH_REASON_LABELS[key]
  }
  // Looks like a raw identifier (no spaces, snake/camel) → prettify.
  if (!/\s/.test(text) && /[_a-z]/.test(text)) {
    const spaced = text.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim()
    return spaced.charAt(0).toUpperCase() + spaced.slice(1)
  }
  return text
}
