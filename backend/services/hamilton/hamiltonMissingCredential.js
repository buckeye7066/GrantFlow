/**
 * hamiltonMissingCredential.js
 *
 * Builds the "Hamilton needs a saved login for this portal and none exists yet"
 * flag. Emitted to the profile owner AND admins when Hamilton hits a portal
 * login gate with no credential in the profile vault or the shared admin vault,
 * so either the student (next time she logs in) or the owner (next time the
 * admin logs in) can add it and Hamilton resumes — with a deep link that jumps
 * straight to the prefilled add-login form, and a heads-up that signing in may
 * still trigger 2FA on their authenticator app / phone.
 */

export const MISSING_CREDENTIAL_NOTIFICATION_TYPE = 'hamilton_missing_credential'

export function hostOfUrl(u) {
  if (!u) return null
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Deep link to the profile's saved-logins (Universities tab) with the add-login
 * dialog prefilled. Works for the student AND for an admin (admins can add the
 * login onto the student's profile), so a single link serves both recipients.
 */
export function buildAddCredentialLink({ profileId, host, loginUrl } = {}) {
  const p = new URLSearchParams()
  if (profileId) p.set('id', String(profileId))
  p.set('tab', 'universities')
  if (host) p.set('addLogin', host)
  if (loginUrl) p.set('loginUrl', loginUrl)
  return `/ProfileDetail?${p.toString()}`
}

/**
 * The notification payload (type/title/message/data) for a missing portal login.
 * Pure — the caller emits it via emitHamiltonNotificationToProfileAndAdmins.
 */
export function missingCredentialNotice({ profileId, host, loginUrl = null, fundingTitle = null } = {}) {
  const link = buildAddCredentialLink({ profileId, host, loginUrl })
  const forWhat = fundingTitle ? ` for ${fundingTitle}` : ''
  return {
    type: MISSING_CREDENTIAL_NOTIFICATION_TYPE,
    title: `Add a login for ${host || 'this portal'}`,
    message:
      `Hamilton needs a saved sign-in for ${host || 'this portal'}${forWhat} to continue, and none is on file ` +
      `(checked this profile and the shared vault). Add it here and she'll pick up where she left off. ` +
      `Heads-up: signing in may still require verification — watch your authenticator app or phone for an approval prompt.`,
    data: {
      portal_host: host || null,
      login_url: loginUrl || null,
      add_credential_link: link,
      route_to_resolve: link,
      requires_authentication_note: true,
    },
  }
}
