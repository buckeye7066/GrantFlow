/** Validate one selected application URL; alternate source URLs cannot rescue it. */
import { isPlaceholderUrl, isNonActionableUrl, isSearchEngineUrl } from './urlRules.js'
import { classifyNonApplicationSurface } from './applicationSurfaceHosts.js'

export function classifyApplicationTargetRefusal(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') return { reason: 'invalid_application_url' }
  const url = value.trim()
  if (!url) return null
  let parsed
  try { parsed = new URL(url) } catch { return { reason: 'invalid_application_url' } }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { reason: 'invalid_application_url' }
  }
  if (isPlaceholderUrl(url)) return { reason: 'placeholder_application_url' }
  if (isSearchEngineUrl(url)) return { reason: 'search_engine_application_url' }
  if (isNonActionableUrl(url)) return { reason: 'non_actionable_application_url' }
  return classifyNonApplicationSurface(url)
}
