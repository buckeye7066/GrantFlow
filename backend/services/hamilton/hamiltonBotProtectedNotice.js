/**
 * hamiltonBotProtectedNotice.js
 *
 * Builds the owner+admin notification for a DEAD-END that Hamilton's autopilot
 * cannot automate because the site is behind full-page bot protection (a
 * Cloudflare "managed challenge" / Akamai / DataDome interstitial that replaces
 * the application before it loads, refusing our datacenter browser).
 *
 * This is DISTINCT from a login / 2FA / CAPTCHA-widget gate: it is not that a
 * credential is missing, it is that the whole site refuses automated access from
 * where Hamilton runs. The honest workaround (owner, 2026-08-03) is SIDE-BY-SIDE
 * co-browse — a human-driven cloud browser (the existing Hamilton live-login /
 * `/HamiltonLiveLogin` flow) that runs from a real browser the site will accept —
 * or applying manually.
 *
 * Pure (no db / no I/O) so it is trivially testable; the caller emits it via
 * emitHamiltonNotificationToProfileAndAdmins.
 */

export const BOT_PROTECTED_NOTIFICATION_TYPE = 'hamilton_bot_protected'

function hostOf(raw) {
  if (!raw) return null
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return String(raw).replace(/^https?:\/\//, '').split('/')[0].toLowerCase() || null
  }
}

/**
 * Deep link to the profile's Portals dashboard with the side-by-side co-browse
 * card pre-surfaced for this portal. `cobrowse=<host>` is read by
 * ProfilePortalsCard to render + scroll to the "Open side-by-side login" card;
 * `cobrowse_reason=bot_protected` swaps its copy to the honest bot-protection
 * message. Works for the student AND an admin (both land on the same card).
 */
export function buildCobrowseLink({ profileId, host } = {}) {
  const p = new URLSearchParams()
  if (profileId) p.set('id', String(profileId))
  p.set('tab', 'pipeline')
  if (host) p.set('cobrowse', host)
  p.set('cobrowse_reason', 'bot_protected')
  return `/ProfileDetail?${p.toString()}`
}

/**
 * The notification payload (type/title/message/data) for a bot-protected
 * dead-end. Pure — the caller emits it to the profile owner AND admins.
 */
export function botProtectedNotice({ profileId, host, loginUrl = null, fundingTitle = null } = {}) {
  const cleanHost = hostOf(host) || (host ? String(host).toLowerCase() : null)
  const link = buildCobrowseLink({ profileId, host: cleanHost })
  const forWhat = fundingTitle ? ` for ${fundingTitle}` : ''
  const where = cleanHost || 'this site'
  return {
    type: BOT_PROTECTED_NOTIFICATION_TYPE,
    title: `${where} blocks automated submission`,
    message:
      `Hamilton could not apply${forWhat} automatically: ${where} is behind bot protection ` +
      `(a Cloudflare / anti-bot security check) that blocks automated access before the ` +
      `application loads. This is not a login problem — the site refuses the automated browser ` +
      `itself. Use side-by-side co-browse to apply (Hamilton opens a secure window and you sign ` +
      `in / clear the check live, from your own browser), or apply manually.`,
    data: {
      portal_host: cleanHost || null,
      login_url: loginUrl || null,
      blocker_kind: 'bot_protected',
      cobrowse_host: cleanHost || null,
      cobrowse_reason: 'bot_protected',
      route_to_resolve: link,
      side_by_side_link: link,
    },
  }
}
