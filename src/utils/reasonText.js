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
