// @vitest-environment jsdom
/**
 * Frontend promo-touch capture + claim. Contract: attribution NEVER interferes
 * with the app — invalid ids are ignored, claim is idempotent per touch, and
 * API failures are swallowed (and do not mark the touch claimed).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const apiFetchMock = vi.fn()
vi.mock('../api/client.js', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
  default: {},
}))

const {
  capturePromoTouchFromLocation,
  claimPromoTouch,
  PROMO_TOUCH_STORAGE_KEY,
  PROMO_TOUCH_CLAIMED_KEY,
} = await import('./promoAttribution.js')

const TOUCH = 'a1b2c3d4e5f6a7b8c9d0e1f2'

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  localStorage.clear()
  apiFetchMock.mockReset()
})

describe('capturePromoTouchFromLocation', () => {
  it('stores a valid pp_touch from the landing URL', () => {
    const touch = capturePromoTouchFromLocation({ search: `?utm_source=promo&pp_touch=${TOUCH}` })
    expect(touch).toBe(TOUCH)
    expect(localStorage.getItem(PROMO_TOUCH_STORAGE_KEY)).toBe(TOUCH)
  })

  it('ignores missing or malformed pp_touch values', () => {
    expect(capturePromoTouchFromLocation({ search: '' })).toBe(null)
    expect(capturePromoTouchFromLocation({ search: '?pp_touch=<script>' })).toBe(null)
    expect(capturePromoTouchFromLocation({ search: '?pp_touch=short' })).toBe(null)
    expect(localStorage.getItem(PROMO_TOUCH_STORAGE_KEY)).toBe(null)
  })

  it('a NEW touch resets the claimed marker so it gets claimed again', () => {
    localStorage.setItem(PROMO_TOUCH_STORAGE_KEY, 'old-touch-0000000000000000')
    localStorage.setItem(PROMO_TOUCH_CLAIMED_KEY, 'old-touch-0000000000000000')
    capturePromoTouchFromLocation({ search: `?pp_touch=${TOUCH}` })
    expect(localStorage.getItem(PROMO_TOUCH_STORAGE_KEY)).toBe(TOUCH)
    expect(localStorage.getItem(PROMO_TOUCH_CLAIMED_KEY)).toBe(null)
  })
})

describe('claimPromoTouch', () => {
  it('claims a stored touch once and marks it claimed on success', async () => {
    apiFetchMock.mockResolvedValue({ ok: true })
    localStorage.setItem(PROMO_TOUCH_STORAGE_KEY, TOUCH)
    claimPromoTouch()
    await flush()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
    const [path, opts] = apiFetchMock.mock.calls[0]
    expect(path).toBe('/api/attribution/claim')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ touch_id: TOUCH })
    expect(localStorage.getItem(PROMO_TOUCH_CLAIMED_KEY)).toBe(TOUCH)
    // Second call is an idempotent no-op.
    claimPromoTouch()
    await flush()
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('no stored touch = no network call', async () => {
    claimPromoTouch()
    await flush()
    expect(apiFetchMock).not.toHaveBeenCalled()
  })

  it('an API failure is swallowed and the touch stays UNclaimed for retry', async () => {
    apiFetchMock.mockRejectedValue(new Error('network down'))
    localStorage.setItem(PROMO_TOUCH_STORAGE_KEY, TOUCH)
    expect(() => claimPromoTouch()).not.toThrow()
    await flush()
    expect(localStorage.getItem(PROMO_TOUCH_CLAIMED_KEY)).toBe(null)
  })
})
