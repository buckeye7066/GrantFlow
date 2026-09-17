// The canonical target classifier is pure browser-safe configuration: it has
// no IO, server state or environment dependencies. Do not copy its host rules.
import { classifyApplicationTargetRefusal } from '../../backend/config/applicationTargetPolicy.js'
import { resolveApplicationUrl, readApplicationTargetRefusal } from '../../shared/applicationTarget.js'

/** Funder links are navigation, never proof of eligibility or permission to apply. */
export function resolveFunderApplicationLink(row) {
  const target = resolveApplicationUrl(row)
  const refused = readApplicationTargetRefusal(row) || classifyApplicationTargetRefusal(target)
  if (target && !refused) return target
  for (const value of [row?.source_url, row?.sourceUrl, row?.url, row?.portal_url, row?.contact_info?.website]) {
    if (typeof value !== 'string' || !value.trim()) continue
    try {
      const url = new URL(value.trim())
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) continue
      if (refused && target && url.href === new URL(target).href) continue
      return value.trim()
    } catch { /* malformed navigation data is not a link */ }
  }
  return null
}
