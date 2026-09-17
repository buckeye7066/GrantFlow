/**
 * One precedence for explicit application-target aliases across the engine,
 * crawler facade, pipeline writer and result card. Selecting a URL is not
 * verification: the caller must still apply the source/target policy.
 * Information/source URLs are deliberately not application aliases.
 */
export function resolveApplicationUrl(row) {
  for (const value of [row?.apply_url, row?.applyUrl, row?.application_url, row?.applicationUrl]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

/** Read a recorded refusal; presentation must never invent an eligibility verdict. */
export function readApplicationTargetRefusal(row) {
  for (const raw of [row, row?.match_explain, row?.match_explain_json]) {
    let value = raw
    if (typeof raw === 'string') {
      try { value = JSON.parse(raw) } catch { continue }
    }
    const marker = value?.application_target
    if (marker?.status === 'non_application') return marker
  }
  return null
}
