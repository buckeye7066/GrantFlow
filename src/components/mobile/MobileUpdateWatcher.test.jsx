// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isNativePlatform,
  fetchUpdateManifestMock,
  downloadAndApplyUpdateMock,
  notifyUpdateAvailableMock,
  currentMock,
  appAddListenerMock,
} = vi.hoisted(() => ({
  isNativePlatform: { value: true },
  fetchUpdateManifestMock: vi.fn(),
  downloadAndApplyUpdateMock: vi.fn(),
  notifyUpdateAvailableMock: vi.fn(),
  currentMock: vi.fn(),
  appAddListenerMock: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => isNativePlatform.value },
}))

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: { current: (...a) => currentMock(...a) },
}))

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: 'granted' }),
    requestPermissions: async () => ({ display: 'granted' }),
    schedule: async () => undefined,
  },
}))

vi.mock('@capacitor/app', () => ({
  App: { addListener: (...a) => appAddListenerMock(...a) },
}))

// Keep the REAL pure helpers (isNewerVersion / requiresNativeUpdate) so the
// component's decision logic is exercised, not stubbed.
vi.mock('@/lib/mobileUpdater', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    fetchUpdateManifest: (...a) => fetchUpdateManifestMock(...a),
    downloadAndApplyUpdate: (...a) => downloadAndApplyUpdateMock(...a),
  }
})

vi.mock('@/lib/mobileUpdateNotifier', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, notifyUpdateAvailable: (...a) => notifyUpdateAvailableMock(...a) }
})

import MobileUpdateWatcher from './MobileUpdateWatcher.jsx'

const SHA = 'a'.repeat(64)

function manifest(overrides = {}) {
  return {
    version: '9.9.9',
    url: 'https://axiombiolabs.org/mobile/bundle-9.9.9.zip',
    sha256: SHA,
    minNativeVersion: '',
    notes: '',
    builtAt: '',
    ...overrides,
  }
}

describe('MobileUpdateWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isNativePlatform.value = true
    currentMock.mockResolvedValue({ bundle: { version: '1.0.0' }, native: '1.1' })
    notifyUpdateAvailableMock.mockResolvedValue({ notified: true, reason: 'scheduled' })
    downloadAndApplyUpdateMock.mockResolvedValue(undefined)
    appAddListenerMock.mockResolvedValue({ remove: vi.fn() })
  })

  afterEach(() => {
    window.localStorage.clear()
  })

  it('renders nothing on the web and never touches the feed', async () => {
    isNativePlatform.value = false
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    const { container } = render(<MobileUpdateWatcher />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(fetchUpdateManifestMock).not.toHaveBeenCalled()
  })

  // THE FEATURE: the user is told about the update without opening Settings.
  it('checks on launch, raises a local notification, and prompts in-app', async () => {
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    render(<MobileUpdateWatcher />)

    expect(await screen.findByText('Update available')).toBeTruthy()
    expect(screen.getByText(/GrantFlow v9\.9\.9 is ready to install/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Install now/i })).toBeTruthy()

    await waitFor(() => expect(notifyUpdateAvailableMock).toHaveBeenCalledTimes(1))
    expect(notifyUpdateAvailableMock.mock.calls[0][0]).toMatchObject({
      currentVersion: '1.0.0',
      manifest: { version: '9.9.9' },
    })
  })

  it('stays silent and renders nothing when already up to date', async () => {
    currentMock.mockResolvedValue({ bundle: { version: '9.9.9' }, native: '1.1' })
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    const { container } = render(<MobileUpdateWatcher />)

    await waitFor(() => expect(fetchUpdateManifestMock).toHaveBeenCalled())
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(notifyUpdateAvailableMock).not.toHaveBeenCalled()
  })

  // A denied notification permission must never break the in-app path.
  it('still prompts in-app when the notification could not be raised', async () => {
    notifyUpdateAvailableMock.mockResolvedValue({ notified: false, reason: 'permission-denied' })
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    render(<MobileUpdateWatcher />)
    expect(await screen.findByRole('button', { name: /Install now/i })).toBeTruthy()
  })

  it('still prompts in-app when the notification plugin throws outright', async () => {
    notifyUpdateAvailableMock.mockRejectedValue(new Error('plugin not implemented'))
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    render(<MobileUpdateWatcher />)
    expect(await screen.findByRole('button', { name: /Install now/i })).toBeTruthy()
  })

  it('installs through the shared verified apply path', async () => {
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    render(<MobileUpdateWatcher />)
    fireEvent.click(await screen.findByRole('button', { name: /Install now/i }))
    await waitFor(() => expect(downloadAndApplyUpdateMock).toHaveBeenCalledTimes(1))
    expect(downloadAndApplyUpdateMock.mock.calls[0][0].manifest).toMatchObject({ sha256: SHA })
  })

  it('surfaces an install failure honestly instead of pretending success', async () => {
    downloadAndApplyUpdateMock.mockRejectedValue(new Error('Checksum failed: bundle-id'))
    fetchUpdateManifestMock.mockResolvedValue(manifest())
    render(<MobileUpdateWatcher />)
    fireEvent.click(await screen.findByRole('button', { name: /Install now/i }))
    expect(await screen.findByText(/Checksum failed/)).toBeTruthy()
  })

  // OTA replaces the web bundle only — never offer a web install that cannot
  // carry the change.
  it('demands a new APP version (no web install offered) when the native floor is higher', async () => {
    fetchUpdateManifestMock.mockResolvedValue(manifest({ minNativeVersion: '2.0' }))
    render(<MobileUpdateWatcher />)
    expect(await screen.findByText('A new app version is required')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Install now/i })).toBeNull()
  })

  it('registers a resume listener so an update found later still surfaces', async () => {
    fetchUpdateManifestMock.mockResolvedValue(manifest({ version: '1.0.0' }))
    render(<MobileUpdateWatcher />)
    await waitFor(() => expect(appAddListenerMock).toHaveBeenCalledWith('appStateChange', expect.any(Function)))
  })
})
