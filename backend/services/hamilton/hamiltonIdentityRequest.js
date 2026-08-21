/**
 * hamiltonIdentityRequest.js
 *
 * The "Hamilton needs an identity value he does not have on file — ask the
 * profile's user for it" notice. Mirrors hamiltonMissingCredential.js: a pure
 * payload builder plus a thin emitter, so the ask reaches the profile owner AND
 * the admins with a deep link to the secure entry form.
 *
 * Owner directive 2026-08-21: when Hamilton needs identity proofing / SSO / a
 * required value that is not in the vault, he ASKS the profile's user for it —
 * he never fabricates it and never silently dead-ends.
 */

import { emitHamiltonNotificationToProfileAndAdmins } from './hamiltonNotifications.js'
import { identityKindLabel } from './hamiltonProfileIdentityVault.js'

export const IDENTITY_REQUEST_NOTIFICATION_TYPE = 'hamilton_identity_needed'

/**
 * Deep link to the profile's secure identity vault with the requested kind
 * pre-selected. Serves the student AND an admin (either can add it).
 */
export function buildAddIdentityLink({ profileId, kind } = {}) {
  const p = new URLSearchParams()
  if (profileId) p.set('id', String(profileId))
  // The identity vault card lives at #identity-vault in the pipeline tab, beside
  // the other Hamilton controls; addIdentity pre-selects the requested kind.
  p.set('tab', 'pipeline')
  if (kind) p.set('addIdentity', String(kind))
  return `/ProfileDetail?${p.toString()}#identity-vault`
}

/**
 * The notification payload for a needed identity value. Pure — the caller emits
 * it. Never contains a value, only the KIND being requested.
 */
export function identityRequestNotice({ profileId, kinds = [], host = null, fundingTitle = null } = {}) {
  const list = (Array.isArray(kinds) ? kinds : [kinds]).filter(Boolean)
  const labels = list.map(identityKindLabel)
  const where = host ? ` on ${host}` : ''
  const forWhat = fundingTitle ? ` for “${fundingTitle}”` : ''
  const need = labels.length === 1
    ? labels[0]
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  return {
    type: IDENTITY_REQUEST_NOTIFICATION_TYPE,
    title: 'Hamilton needs a detail to finish an application',
    message: labels.length === 0
      ? `Hamilton reached an identity check${where}${forWhat} and needs a detail from you to continue. Add it securely and Hamilton resumes on his own.`
      : `To finish the application${where}${forWhat}, Hamilton needs your ${need}. Add it securely and Hamilton resumes on his own — he never fills a value you have not saved.`,
    severity: 'warning',
    data: {
      profile_id: profileId ? String(profileId) : null,
      kinds: list,
      host: host || null,
      funding_title: fundingTitle || null,
      action: 'provide_identity',
      link: buildAddIdentityLink({ profileId, kind: list[0] || null }),
    },
  }
}

/**
 * Emit the identity request to the profile owner and the admins. Thin wrapper
 * over the shared notification emitter; returns whatever it returns.
 */
export async function emitIdentityRequest(db, {
  profileId, profileUserId = null, kinds = [], host = null, fundingTitle = null,
} = {}) {
  const notice = identityRequestNotice({ profileId, kinds, host, fundingTitle })
  return await emitHamiltonNotificationToProfileAndAdmins(db, {
    profileId,
    profileUserId,
    type: notice.type,
    title: notice.title,
    message: notice.message,
    severity: notice.severity,
    data: notice.data,
  })
}

export default {
  IDENTITY_REQUEST_NOTIFICATION_TYPE,
  buildAddIdentityLink,
  identityRequestNotice,
  emitIdentityRequest,
}
