import { describe, expect, it } from 'vitest'

import {
  buildUpdateNotification,
  ensureNotificationPermission,
  markVersionNotified,
  notifyUpdateAvailable,
  readLastNotifiedVersion,
  shouldNotifyForVersion,
  LAST_NOTIFIED_VERSION_KEY,
  UPDATE_NOTIFICATION_ID,
} from './mobileUpdateNotifier.js'

/** Minimal in-memory localStorage stand-in. */
function makeStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
    },
  }
}

/** Fake @capacitor/local-notifications with recorded calls. */
function makeNotifications({ display = 'granted', onRequest, scheduleImpl } = {}) {
  const calls = { checked: 0, requested: 0, scheduled: [] }
  return {
    calls,
    plugin: {
      checkPermissions: async () => {
        calls.checked += 1
        return { display }
      },
      requestPermissions: async () => {
        calls.requested += 1
        return { display: onRequest ?? display }
      },
      schedule: async (payload) => {
        calls.scheduled.push(payload)
        if (scheduleImpl) return scheduleImpl(payload)
        return undefined
      },
    },
  }
}

describe('shouldNotifyForVersion', () => {
  it('notifies for a genuinely newer bundle never announced before', () => {
    expect(shouldNotifyForVersion({ availableVersion: '1.0.2', currentVersion: '1.0.1' })).toBe(true)
  })

  // "never notify when already up to date"
  it('never notifies when the user is already on that version or newer', () => {
    expect(shouldNotifyForVersion({ availableVersion: '1.0.1', currentVersion: '1.0.1' })).toBe(false)
    expect(shouldNotifyForVersion({ availableVersion: '1.0.1', currentVersion: '1.1.0' })).toBe(false)
  })

  it('never notifies on an incomparable version (capgo "builtin")', () => {
    expect(shouldNotifyForVersion({ availableVersion: 'builtin', currentVersion: '1.0.1' })).toBe(false)
    expect(shouldNotifyForVersion({ availableVersion: '1.0.2', currentVersion: 'builtin' })).toBe(false)
  })

  // "at most once per available version"
  it('does not renotify for a version already announced', () => {
    expect(
      shouldNotifyForVersion({ availableVersion: '1.0.2', currentVersion: '1.0.1', lastNotifiedVersion: '1.0.2' }),
    ).toBe(false)
  })

  it('does renotify once a NEWER version appears', () => {
    expect(
      shouldNotifyForVersion({ availableVersion: '1.0.3', currentVersion: '1.0.1', lastNotifiedVersion: '1.0.2' }),
    ).toBe(true)
  })

  it('ignores a junk last-notified value rather than going permanently silent', () => {
    expect(
      shouldNotifyForVersion({ availableVersion: '1.0.2', currentVersion: '1.0.1', lastNotifiedVersion: 'garbage' }),
    ).toBe(true)
  })
})

describe('readLastNotifiedVersion / markVersionNotified', () => {
  it('round-trips through storage under the documented key', () => {
    const storage = makeStorage()
    expect(readLastNotifiedVersion(storage)).toBe('')
    markVersionNotified({ version: '1.0.2', storage })
    expect(storage.data[LAST_NOTIFIED_VERSION_KEY]).toBe('1.0.2')
    expect(readLastNotifiedVersion(storage)).toBe('1.0.2')
  })

  it('survives a storage that throws (private mode / blocked storage)', () => {
    const hostile = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readLastNotifiedVersion(hostile)).toBe('')
    expect(() => markVersionNotified({ version: '1.0.2', storage: hostile })).not.toThrow()
  })
})

describe('ensureNotificationPermission', () => {
  it('accepts an already-granted permission without prompting again', async () => {
    const { calls, plugin } = makeNotifications({ display: 'granted' })
    expect(await ensureNotificationPermission(plugin)).toBe(true)
    expect(calls.requested).toBe(0)
  })

  it('prompts when the permission is still undecided', async () => {
    const { calls, plugin } = makeNotifications({ display: 'prompt', onRequest: 'granted' })
    expect(await ensureNotificationPermission(plugin)).toBe(true)
    expect(calls.requested).toBe(1)
  })

  it('returns false without prompting when already denied', async () => {
    const { calls, plugin } = makeNotifications({ display: 'denied' })
    expect(await ensureNotificationPermission(plugin)).toBe(false)
    expect(calls.requested).toBe(0)
  })

  it('degrades silently when the plugin is missing from an older native build', async () => {
    const broken = {
      checkPermissions: async () => {
        throw new Error('"LocalNotifications" plugin is not implemented on android')
      },
      requestPermissions: async () => ({ display: 'granted' }),
    }
    await expect(ensureNotificationPermission(broken)).resolves.toBe(false)
  })
})

describe('buildUpdateNotification', () => {
  it('names the version and tells the user what to do', () => {
    const n = buildUpdateNotification({ version: '1.0.2' })
    expect(n.id).toBe(UPDATE_NOTIFICATION_ID)
    expect(n.title).toMatch(/Update available/i)
    expect(n.body).toContain('1.0.2')
    expect(n.body).toMatch(/open grantflow/i)
    expect(n.extra).toEqual({ version: '1.0.2' })
  })
})

describe('notifyUpdateAvailable', () => {
  const manifest = { version: '1.0.2' }

  it('schedules exactly one notification and records the version', async () => {
    const storage = makeStorage()
    const { calls, plugin } = makeNotifications()
    const result = await notifyUpdateAvailable({
      manifest,
      currentVersion: '1.0.1',
      localNotifications: plugin,
      storage,
    })
    expect(result).toEqual({ notified: true, reason: 'scheduled' })
    expect(calls.scheduled).toHaveLength(1)
    expect(calls.scheduled[0].notifications[0].body).toContain('1.0.2')
    expect(storage.data[LAST_NOTIFIED_VERSION_KEY]).toBe('1.0.2')
  })

  // THE ANTI-NAG GUARANTEE: a user who backgrounds/foregrounds repeatedly gets
  // one notification per available version, not one per resume.
  it('does not notify twice for the same version across repeated resumes', async () => {
    const storage = makeStorage()
    const { calls, plugin } = makeNotifications()
    for (let i = 0; i < 5; i += 1) {
      await notifyUpdateAvailable({ manifest, currentVersion: '1.0.1', localNotifications: plugin, storage })
    }
    expect(calls.scheduled).toHaveLength(1)
  })

  it('notifies again once a newer version is published', async () => {
    const storage = makeStorage()
    const { calls, plugin } = makeNotifications()
    await notifyUpdateAvailable({ manifest, currentVersion: '1.0.1', localNotifications: plugin, storage })
    await notifyUpdateAvailable({
      manifest: { version: '1.0.3' },
      currentVersion: '1.0.1',
      localNotifications: plugin,
      storage,
    })
    expect(calls.scheduled).toHaveLength(2)
  })

  it('never notifies when the app is already up to date', async () => {
    const storage = makeStorage()
    const { calls, plugin } = makeNotifications()
    const result = await notifyUpdateAvailable({
      manifest: { version: '1.0.1' },
      currentVersion: '1.0.1',
      localNotifications: plugin,
      storage,
    })
    expect(result.notified).toBe(false)
    expect(calls.scheduled).toEqual([])
    // Not even a permission prompt: no reason to ask when nothing is available.
    expect(calls.checked).toBe(0)
  })

  // A denied permission must be silent AND must not poison the record — the
  // in-app prompt remains the load-bearing path either way.
  it('is silent when the permission is denied and does not mark the version notified', async () => {
    const storage = makeStorage()
    const { calls, plugin } = makeNotifications({ display: 'denied' })
    const result = await notifyUpdateAvailable({
      manifest,
      currentVersion: '1.0.1',
      localNotifications: plugin,
      storage,
    })
    expect(result).toEqual({ notified: false, reason: 'permission-denied' })
    expect(calls.scheduled).toEqual([])
    expect(storage.data[LAST_NOTIFIED_VERSION_KEY]).toBeUndefined()
  })

  it('never throws when scheduling itself fails', async () => {
    const storage = makeStorage()
    const { plugin } = makeNotifications({
      scheduleImpl: () => {
        throw new Error('notification channel missing')
      },
    })
    await expect(
      notifyUpdateAvailable({ manifest, currentVersion: '1.0.1', localNotifications: plugin, storage }),
    ).resolves.toEqual({ notified: false, reason: 'schedule-failed' })
  })
})
