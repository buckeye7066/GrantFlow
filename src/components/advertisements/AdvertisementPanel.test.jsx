// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdvertisementPanel from './AdvertisementPanel.jsx'
import { advertisementApi } from '@/api/advertisements.js'

vi.mock('@/api/advertisements.js', () => ({ advertisementApi: { list: vi.fn(), image: vi.fn(), event: vi.fn(), ticket: vi.fn(), manage: vi.fn() } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: select => select({ user: { id: 'member' } }) }))
let observe, visibility
const creative = (id, seconds) => ({ id, advertiser: 'Test advertiser', headline: `Creative ${id}`, body: 'Local fixture', target_url: 'https://example.com/', duration_seconds: seconds, starts_at: new Date(Date.now() - 60000).toISOString(), ends_at: new Date(Date.now() + 600000).toISOString(), updated_at: '2026-09-09' })
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
beforeEach(() => {
  vi.useFakeTimers(); visibility = 'visible'; vi.clearAllMocks()
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  vi.stubGlobal('IntersectionObserver', class { constructor(callback) { observe = callback } observe() {} disconnect() {} })
  URL.createObjectURL = vi.fn(() => 'blob:fixture'); URL.revokeObjectURL = vi.fn()
  advertisementApi.list.mockResolvedValue({ advertisements: [creative('one', 15), creative('two', 30)], canManage: false, serverTime: new Date().toISOString() })
  advertisementApi.image.mockResolvedValue(new Blob(['image'], { type: 'image/png' })); advertisementApi.event.mockResolvedValue({ counted: true, accepted: true }); advertisementApi.ticket.mockResolvedValue({ ticket: 'fixture-ticket' })
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('visible foreground advertisements', () => {
  it('counts only after the image loads and a continuous visible second; rotates at the creative duration', async () => {
    render(<AdvertisementPanel />); await flush()
    expect(screen.queryByText('Manage advertisements')).toBeNull()
    act(() => observe([{ isIntersecting: true, intersectionRatio: 0.75 }]))
    await act(async () => { vi.advanceTimersByTime(2000) })
    expect(advertisementApi.event).not.toHaveBeenCalled()
    fireEvent.load(screen.getByRole('img')); await flush()
    await act(async () => { vi.advanceTimersByTime(1099) }); expect(advertisementApi.event).not.toHaveBeenCalled()
    await act(async () => { vi.advanceTimersByTime(1) }); expect(advertisementApi.event).toHaveBeenCalledWith('one', 'impression', 'fixture-ticket')
    await act(async () => { vi.advanceTimersByTime(13900) }); await flush()
    expect(screen.getByText('Creative two')).toBeTruthy()
    expect(screen.getByLabelText('Advertisements').className).toContain('print:hidden')
  })
  it('offscreen or background slides neither count nor rotate', async () => {
    render(<AdvertisementPanel />); await flush(); fireEvent.load(screen.getByRole('img'))
    act(() => observe([{ isIntersecting: false, intersectionRatio: 0 }]))
    await act(async () => { vi.advanceTimersByTime(20000) })
    expect(screen.getByText('Creative one')).toBeTruthy(); expect(advertisementApi.event).not.toHaveBeenCalled()
    act(() => { observe([{ isIntersecting: true, intersectionRatio: 1 }]); visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { vi.advanceTimersByTime(20000) })
    expect(screen.getByText('Creative one')).toBeTruthy(); expect(advertisementApi.event).not.toHaveBeenCalled()
  })
  it('shows an empty slot only to the server-verified owner and reports management errors', async () => {
    advertisementApi.list.mockResolvedValue({ advertisements: [], canManage: true, serverTime: new Date().toISOString() })
    advertisementApi.manage.mockRejectedValue(new Error('Only the application owner can manage advertisements.'))
    render(<AdvertisementPanel />); await flush(); fireEvent.click(screen.getByText('Manage advertisements')); await flush()
    expect(screen.getByRole('alert').textContent).toContain('Only the application owner')
  })
  it('uses isolated external links with no referrer and counts a click only after an impression', async () => {
    render(<AdvertisementPanel />); await flush(); fireEvent.load(screen.getByRole('img'))
    const link = screen.getByRole('link'); expect(link.getAttribute('rel')).toContain('noopener noreferrer sponsored'); expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
    fireEvent.click(link); expect(advertisementApi.event).not.toHaveBeenCalled()
    act(() => observe([{ isIntersecting: true, intersectionRatio: 1 }])); await flush()
    await act(async () => { vi.advanceTimersByTime(1100) }); fireEvent.click(link)
    expect(advertisementApi.event).toHaveBeenCalledWith('one', 'click', 'fixture-ticket')
  })
})
