// @vitest-environment jsdom
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isNativePlatform: vi.fn(),
  current: vi.fn(),
  addListener: vi.fn(),
  download: vi.fn(),
  set: vi.fn(),
  fetchUpdateManifest: vi.fn(),
  isNewerVersion: vi.fn(),
  parseVersion: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: mocks.isNativePlatform },
}))

vi.mock('@capgo/capacitor-updater', () => ({
  CapacitorUpdater: {
    current: mocks.current,
    addListener: mocks.addListener,
    download: mocks.download,
    set: mocks.set,
  },
}))

vi.mock('@/lib/mobileUpdater', () => ({
  fetchUpdateManifest: mocks.fetchUpdateManifest,
  isNewerVersion: mocks.isNewerVersion,
  parseVersion: mocks.parseVersion,
}))

import MobileUpdateCard from './MobileUpdateCard.jsx'

const update = {
  version: '1.0.2',
  url: 'https://axiombiolabs.org/mobile/bundle-1.0.2.zip',
  notes: 'Improved matching.',
}

describe('MobileUpdateCard', () => {
  let remove

  beforeEach(() => {
    vi.clearAllMocks()
    remove = vi.fn()
    mocks.isNativePlatform.mockReturnValue(true)
    mocks.parseVersion.mockImplementation((value) => (value === '1.0.1' ? [1, 0, 1] : null))
    mocks.current.mockResolvedValue({ native: '1.1', bundle: { version: '1.0.1' } })
    mocks.isNewerVersion.mockReturnValue(true)
    mocks.addListener.mockResolvedValue({ remove })
    mocks.download.mockResolvedValue({ id: 'bundle-1.0.2' })
    mocks.set.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders only in a native build', () => {
    mocks.isNativePlatform.mockReturnValue(false)
    const { container } = render(<MobileUpdateCard />)
    expect(container).toBeEmptyDOMElement()
  })

  it('loads the active native and web-bundle versions, then offers a newer manifest', async () => {
    mocks.fetchUpdateManifest.mockResolvedValue(update)
    render(<MobileUpdateCard />)

    await screen.findByText(/App v1\.1 — web bundle v1\.0\.1/)
    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))

    expect(await screen.findByText(/Update available: v1\.0\.2/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /install v1\.0\.2/i })).toBeTruthy()
  })

  it('shows a truthful error when the manifest cannot be read', async () => {
    mocks.fetchUpdateManifest.mockRejectedValue(new Error('Update check timed out. Please try again.'))
    render(<MobileUpdateCard />)

    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))
    expect(await screen.findByText(/timed out/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /check for updates/i })).toBeEnabled()
  })

  it('reports download progress, applies the downloaded bundle, and removes its listener', async () => {
    let downloadListener
    mocks.fetchUpdateManifest.mockResolvedValue(update)
    mocks.addListener.mockImplementation(async (_event, callback) => {
      downloadListener = callback
      return { remove }
    })
    mocks.download.mockImplementation(async () => {
      downloadListener({ percent: 48 })
      return { id: 'bundle-1.0.2' }
    })
    render(<MobileUpdateCard />)

    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))
    fireEvent.click(await screen.findByRole('button', { name: /install v1\.0\.2/i }))

    await waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ url: update.url, version: update.version }))
    await waitFor(() => expect(mocks.set).toHaveBeenCalledWith({ id: 'bundle-1.0.2' }))
    expect(remove).toHaveBeenCalledTimes(1)
  })

  it('cleans up the listener and surfaces a download failure', async () => {
    mocks.fetchUpdateManifest.mockResolvedValue(update)
    mocks.download.mockRejectedValue(new Error('Bundle download failed.'))
    render(<MobileUpdateCard />)

    fireEvent.click(screen.getByRole('button', { name: /check for updates/i }))
    fireEvent.click(await screen.findByRole('button', { name: /install v1\.0\.2/i }))

    expect(await screen.findByText(/Bundle download failed/i)).toBeTruthy()
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
