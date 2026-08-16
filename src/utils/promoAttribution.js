/**
 * promoAttribution.js (frontend) — capture + claim of PromoPilot promo touches.
 *
 * PromoPilot's attributed /r/ redirect appends `pp_touch=<random id>` to
 * promoted landing URLs. We remember that id in localStorage at app entry and,
 * once the visitor authenticates, claim it against the backend
 * (POST /api/attribution/claim) so server-side conversion events (signup,
 * application submitted, award recorded) can be attributed to the promotion.
 *
 * Contract: attribution must NEVER interfere with the app — every function
 * here swallows its own failures and the claim is fire-and-forget.
 */

import { apiFetch } from '../api/client.js'

export const PROMO_TOUCH_STORAGE_KEY = 'pp_touch'
export const PROMO_TOUCH_CLAIMED_KEY = 'pp_touch_claimed'
// Mirrors PromoPilot's touch id shape.
const TOUCH_ID_RX = /^[A-Za-z0-9_-]{16,128}$/

/** Read `pp_touch` off the landing URL and remember it. Safe to call always. */
export function capturePromoTouchFromLocation(loc) {
  try {
    const location = loc ?? (typeof window !== 'undefined' ? window.location : null)
    if (!location) return null
    const params = new URLSearchParams(location.search || '')
    const touch = String(params.get('pp_touch') || '')
    if (!TOUCH_ID_RX.test(touch)) return null
    if (localStorage.getItem(PROMO_TOUCH_STORAGE_KEY) !== touch) {
      localStorage.setItem(PROMO_TOUCH_STORAGE_KEY, touch)
      // A NEW touch must be claimable even if an older one was already claimed.
      localStorage.removeItem(PROMO_TOUCH_CLAIMED_KEY)
    }
    return touch
  } catch {
    return null
  }
}

/**
 * Claim the stored touch for the now-authenticated user. Fire-and-forget and
 * idempotent — safe to call on every auth bootstrap; it no-ops when there is
 * no stored touch or the touch was already claimed.
 */
export function claimPromoTouch() {
  try {
    const touch = String(localStorage.getItem(PROMO_TOUCH_STORAGE_KEY) || '')
    if (!TOUCH_ID_RX.test(touch)) return
    if (localStorage.getItem(PROMO_TOUCH_CLAIMED_KEY) === touch) return
    Promise.resolve(
      apiFetch('/api/attribution/claim', {
        method: 'POST',
        body: JSON.stringify({ touch_id: touch }),
      }),
    )
      .then(() => {
        try {
          localStorage.setItem(PROMO_TOUCH_CLAIMED_KEY, touch)
        } catch {
          /* storage unavailable — the backend claim is idempotent anyway */
        }
      })
      .catch(() => {
        /* attribution never surfaces errors to the user */
      })
  } catch {
    /* attribution never affects the app */
  }
}
