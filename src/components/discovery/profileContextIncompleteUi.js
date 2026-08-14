const PROFILE_CONTEXT_INCOMPLETE = 'PROFILE_CONTEXT_INCOMPLETE'

const REQUIRED_FACET_LABELS = Object.freeze({
  'profile.primary_profile_type': 'Profile Type',
  'geo.state_or_zip': 'State/ZIP',
  'intent.primary_need_category': 'Goal',
})

const DEFAULT_REQUIRED_FACETS = Object.freeze([
  'profile.primary_profile_type',
  'geo.state_or_zip',
  'intent.primary_need_category',
])

function uniqueStrings(values = []) {
  const out = []
  const seen = new Set()
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : ''
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function toChecklist(requiredMissing = []) {
  const normalized = uniqueStrings(requiredMissing)
  // Do NOT substitute defaults when the list is empty — an empty list means
  // the server fired PROFILE_CONTEXT_INCOMPLETE but did not specify which
  // facets are missing.  Returning an empty checklist forces the caller to
  // display a generic "complete your profile" message rather than misleading
  // the user into thinking only the three surface fields are needed.
  return normalized.map((facet) => REQUIRED_FACET_LABELS[facet] || facet)
}

function extractRequiredMissing(payload) {
  if (!payload || typeof payload !== 'object') return []
  const direct = Array.isArray(payload?.required_missing) ? payload.required_missing : []
  const nestedDetails = Array.isArray(payload?.details?.required_missing) ? payload.details.required_missing : []
  const nestedDebug = Array.isArray(payload?.debug?.required_missing) ? payload.debug.required_missing : []
  return uniqueStrings([...direct, ...nestedDetails, ...nestedDebug])
}

function hasProfileIncompleteCode(payload) {
  if (!payload || typeof payload !== 'object') return false
  return (
    payload?.error === PROFILE_CONTEXT_INCOMPLETE ||
    payload?.code === PROFILE_CONTEXT_INCOMPLETE ||
    payload?.details?.error === PROFILE_CONTEXT_INCOMPLETE
  )
}

export function getProfileContextIncompleteHint(errorLike) {
  const candidates = [
    errorLike?.response,
    errorLike?.details,
    errorLike,
  ].filter((entry) => entry && typeof entry === 'object')

  for (const payload of candidates) {
    const requiredMissing = extractRequiredMissing(payload)
    const status = Number(payload?.status || errorLike?.status || 0)
    const coded = hasProfileIncompleteCode(payload)
    const impliedByRequiredMissing = status === 400 && requiredMissing.length > 0
    if (!coded && !impliedByRequiredMissing) continue

    const knownMissing = requiredMissing.length > 0 ? requiredMissing : []
    return {
      code: PROFILE_CONTEXT_INCOMPLETE,
      required_missing: knownMissing,
      checklist: toChecklist(knownMissing),
      // When we have no specifics, use a generic headline so the UI/Anya
      // does not claim to know which fields are missing.
      headline:
        knownMissing.length > 0
          ? 'Complete profile sections: ' + knownMissing.map((f) => REQUIRED_FACET_LABELS[f] || f).join(' + ')
          : 'Your profile needs more detail before searching — open your profile to review missing sections.',
    }
  }

  return null
}

