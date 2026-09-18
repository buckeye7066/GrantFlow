/** Shared, actionable messages for immediate and persisted portal access failures. */
export function portalAccessFailureDetail(access) {
  if (access === 'signin_wall') return 'Sign in again using the portal login above, then retry the pull. No personal data was imported.'
  if (access === 'blocked') return 'The portal blocked this browser. Your saved session was kept; retry later or open the portal directly.'
  return 'Hamilton could not verify signed-in account access. Open the portal, confirm your account is visible, and capture a fresh session before retrying.'
}

export function portalSyncFailureMessage(result) {
  if (!result || typeof result !== 'object') return ''
  let summary = result.summary || result.summary_json || {}
  if (typeof summary === 'string') {
    try { summary = JSON.parse(summary) } catch { summary = {} }
  }
  if (!summary || typeof summary !== 'object') summary = {}
  if (result.error === 'portal_access_unproven') {
    return portalAccessFailureDetail(result.read?.access || summary.read?.access)
  }
  return String(result.detail || summary.detail || result.error || '').slice(0,500)
}
