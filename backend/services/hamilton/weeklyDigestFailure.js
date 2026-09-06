// Persist only bounded machine identifiers, never provider bodies, tokens,
// email addresses, or message contents in Sam/Anya's diagnostic evidence.
const CODES = new Set([
  'JOHN_OUTLOOK_NOT_CONFIGURED', 'JOHN_OUTLOOK_TOKEN_FAILED',
  'JOHN_OUTLOOK_DRAFT_FAILED', 'JOHN_OUTLOOK_MISSING_RECIPIENT',
  'DIGEST_DRAFT_UNVERIFIED', 'DIGEST_SEND_FAILED', 'DIGEST_PARTIAL_SEND',
])
/**
 * @param {unknown} profileId
 * @param {unknown} mode
 * @param {unknown} [error]
 */
export function weeklyDigestFailure(profileId, mode, error = {}) {
  const details = error !== null && typeof error === 'object' ? error : {}
  const rawCode = 'code' in details ? details.code : undefined
  const code = typeof rawCode === 'string' && CODES.has(rawCode) ? rawCode : 'DIGEST_DELIVERY_FAILED'
  const rawStatus = 'status' in details ? details.status : undefined
  const candidate = typeof rawStatus === 'number' || typeof rawStatus === 'string' ? Number(rawStatus) : NaN
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : null
  let nextAction = 'Inspect the application log for this profile and delivery mode; verify mailbox state before retrying only the failed profile.'
  if (status === 401 || code === 'JOHN_OUTLOOK_NOT_CONFIGURED' || code === 'JOHN_OUTLOOK_TOKEN_FAILED') {
    nextAction = 'Check MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, and JOHN_PRIMARY_MAILBOX in the backend service configuration; do not paste secret values into reports.'
  } else if (status === 403) {
    nextAction = 'Check the Outlook app mailbox access and Mail.ReadWrite authorization for JOHN_PRIMARY_MAILBOX; verify the configured sender alias permissions.'
  } else if (status === 429 || (status !== null && status >= 500)) {
    nextAction = 'Check the provider rate limit or outage, then verify mailbox state before retrying only the failed profile; do not duplicate successful deliveries.'
  } else if (code === 'DIGEST_DRAFT_UNVERIFIED') {
    nextAction = 'The provider returned no verified draft identifier. Check the mailbox before retrying; this attempt is not counted as a completed draft.'
  }
  return {
    profile_id: String(profileId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100),
    mode: mode === 'send' ? 'send' : 'draft',
    code,
    status,
    next_action: nextAction,
  }
}
