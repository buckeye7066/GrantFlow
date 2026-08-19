// Local-notification gating for the mobile OTA updater.
//
// WHY LOCAL AND NOT PUSH: a server-initiated push (FCM + APNs) needs a Firebase
// project, an Apple push key, and a sending service — infrastructure this
// project has not provisioned. A launch/resume check plus a LOCAL notification
// needs none of that and works on Android and iOS today. The decision to notify
// is isolated in shouldNotifyForVersion() so a real push trigger can later call
// the exact same code path with a server-supplied manifest.
//
// Rules encoded here:
//   * never notify when the user is already on the newest bundle;
//   * notify at most once per available version (persisted), so a user who
//     backgrounds and foregrounds the app ten times gets one notification;
//   * a denied notification permission is silent and must never break the
//     in-app update path.
//
// Everything is injectable so it can be unit-tested without a device.

import { isNewerVersion, parseVersion } from './mobileUpdater.js'

/** localStorage key holding the last bundle version we raised a notification for. */
export const LAST_NOTIFIED_VERSION_KEY = 'grantflow.mobileUpdateNotifiedVersion'

/** Stable notification id so a re-notify replaces rather than stacks. */
export const UPDATE_NOTIFICATION_ID = 1747

/** Channel id used on Android (created lazily by the plugin). */
export const UPDATE_NOTIFICATION_CHANNEL = 'grantflow-app-updates'

/**
 * Read the last-notified version, tolerating an unavailable/blocked store.
 * @param {Pick<Storage,'getItem'>} [storage]
 * @returns {string}
 */
export function readLastNotifiedVersion(storage) {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    return store?.getItem(LAST_NOTIFIED_VERSION_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * Persist the version we just notified about. Best-effort: a storage failure
 * must not break the update flow (worst case the user sees one extra notice).
 * @param {{ version: string, storage?: Pick<Storage,'setItem'> }} opts
 */
export function markVersionNotified({ version, storage }) {
  try {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null)
    store?.setItem(LAST_NOTIFIED_VERSION_KEY, String(version))
  } catch {
    // storage unavailable — accept the possible duplicate notification
  }
}

/**
 * The whole "do not nag" decision, as a pure function.
 *
 * @param {object} opts
 * @param {string} opts.availableVersion version offered by the feed
 * @param {string} opts.currentVersion the running web bundle version
 * @param {string} [opts.lastNotifiedVersion] previously notified version
 * @returns {boolean} true only when this is a genuinely newer, not-yet-announced bundle
 */
export function shouldNotifyForVersion({ availableVersion, currentVersion, lastNotifiedVersion = '' }) {
  // Up to date (or incomparable) — there is nothing to announce.
  if (!isNewerVersion(availableVersion, currentVersion)) return false
  // Already announced this exact version, or a newer one, on this device.
  if (!parseVersion(lastNotifiedVersion)) return true
  return isNewerVersion(availableVersion, lastNotifiedVersion)
}

/**
 * Build the notification payload for an available bundle.
 * @param {{ version: string }} manifest
 */
export function buildUpdateNotification(manifest) {
  return {
    id: UPDATE_NOTIFICATION_ID,
    channelId: UPDATE_NOTIFICATION_CHANNEL,
    title: 'Update available',
    body: `GrantFlow v${manifest.version} is ready — open GrantFlow to install it.`,
    smallIcon: 'ic_stat_icon_config_sample',
    extra: { version: manifest.version },
  }
}

/**
 * Ensure we may post a local notification.
 *
 * Called only AFTER an update has actually been found, so the OS prompt appears
 * at a moment the user can make sense of — never on first paint.
 *
 * @param {{ checkPermissions: Function, requestPermissions: Function }} localNotifications
 * @returns {Promise<boolean>} true when notifications may be posted
 */
export async function ensureNotificationPermission(localNotifications) {
  try {
    const current = await localNotifications.checkPermissions()
    if (current?.display === 'granted') return true
    if (current?.display === 'denied') return false
    const asked = await localNotifications.requestPermissions()
    return asked?.display === 'granted'
  } catch {
    // Plugin missing (an older native build that predates it) or the platform
    // refused — degrade silently; the in-app prompt still offers the update.
    return false
  }
}

/**
 * Raise the "update available" local notification, honoring every gate above.
 *
 * Never throws: notification failure is cosmetic, the in-app prompt is the
 * load-bearing path.
 *
 * @param {object} opts
 * @param {{ version: string }} opts.manifest
 * @param {string} opts.currentVersion running web bundle version
 * @param {{ checkPermissions: Function, requestPermissions: Function, schedule: Function }} opts.localNotifications
 * @param {Pick<Storage,'getItem'|'setItem'>} [opts.storage]
 * @returns {Promise<{ notified: boolean, reason: string }>}
 */
export async function notifyUpdateAvailable({ manifest, currentVersion, localNotifications, storage }) {
  const lastNotifiedVersion = readLastNotifiedVersion(storage)
  if (!shouldNotifyForVersion({ availableVersion: manifest?.version, currentVersion, lastNotifiedVersion })) {
    return { notified: false, reason: 'not-newer-or-already-notified' }
  }
  const allowed = await ensureNotificationPermission(localNotifications)
  if (!allowed) return { notified: false, reason: 'permission-denied' }
  try {
    await localNotifications.schedule({ notifications: [buildUpdateNotification(manifest)] })
  } catch {
    return { notified: false, reason: 'schedule-failed' }
  }
  markVersionNotified({ version: manifest.version, storage })
  return { notified: true, reason: 'scheduled' }
}
