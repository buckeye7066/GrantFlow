/**
 * Submit-click verdicts (2026-08-31). "Submit button could not be clicked"
 * (TSAC / HOPE / GAMS / Aspire) used to end runs in
 * submission_verification_required — "a submission may have gone through" —
 * for clicks that provably never fired: an SPA re-render drops the stamped
 * data-hamilton-btn attribute between detect and click, page.$ returns null,
 * and NOTHING was ever clicked. Two fixes pinned here:
 *
 *  1. clickSubmitControl RE-DETECTS the vetted control by its own text before
 *     giving up (the stale-handle recovery);
 *  2. the verdict distinguishes "no click ever reached the page"
 *     (dispatched:false → provably not submitted, safe to retry) from a
 *     failure that may have fired the event (stays conservative).
 */
import { describe, it, expect } from 'vitest'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { clickSubmitControl, clickButtonByBidVerdict, SUBMIT_BUTTON_PATTERNS } = _internal

// A minimal page double. `stamps` maps bid → an element handle double; $$eval
// re-stamps buttons the way detectButtons does in the real DOM.
function makePage({ handles = {}, redetected = [] } = {}) {
  return {
    $: async (sel) => {
      const m = sel.match(/data-hamilton-btn="([^"]+)"/)
      return (m && handles[m[1]]) || null
    },
    $$eval: async () => redetected,
    waitForNavigation: () => Promise.resolve(null),
    waitForLoadState: async () => null,
  }
}

const clickableHandle = () => ({
  scrollIntoViewIfNeeded: async () => {},
  click: async () => {},
  evaluate: async () => {},
})

function timeoutError() {
  const e = new Error('Timeout 8000ms exceeded.')
  return e
}

const timeoutHandle = () => ({
  scrollIntoViewIfNeeded: async () => {},
  click: async () => { throw timeoutError() },
  evaluate: async () => { throw timeoutError() },
})

const destroyedHandle = () => ({
  scrollIntoViewIfNeeded: async () => {},
  click: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.') },
  evaluate: async () => { throw new Error('Execution context was destroyed, most likely because of a navigation.') },
})

describe('clickButtonByBidVerdict', () => {
  it('missing handle → { clicked:false, dispatched:false } (provably no click)', async () => {
    const v = await clickButtonByBidVerdict(makePage(), 'b1')
    expect(v).toEqual({ clicked: false, dispatched: false })
  })

  it('all attempts die in the PRE-dispatch actionability wait → dispatched:false', async () => {
    const v = await clickButtonByBidVerdict(makePage({ handles: { b1: timeoutHandle() } }), 'b1')
    expect(v.clicked).toBe(false)
    expect(v.dispatched).toBe(false)
  })

  it('a context-destroyed failure MAY have fired the event → dispatched:true (stays conservative)', async () => {
    const v = await clickButtonByBidVerdict(makePage({ handles: { b1: destroyedHandle() } }), 'b1')
    expect(v.clicked).toBe(false)
    expect(v.dispatched).toBe(true)
  })

  it('a clean click → { clicked:true, dispatched:true }', async () => {
    const v = await clickButtonByBidVerdict(makePage({ handles: { b1: clickableHandle() } }), 'b1')
    expect(v).toEqual({ clicked: true, dispatched: true })
  })
})

describe('clickSubmitControl (stale-handle recovery)', () => {
  it('re-detects the SAME control by text when the stamped attribute vanished, and clicks it', async () => {
    // First lookup (b1) finds nothing — the SPA re-rendered. Re-detection
    // stamps the same button as b2; the retry must click exactly that.
    const page = makePage({
      handles: { b2: clickableHandle() },
      redetected: [{ bid: 'b2', text: 'Submit Application', inForm: true, formFieldCount: 3, isPageFeedback: false }],
    })
    const v = await clickSubmitControl(page, { bid: 'b1', text: 'Submit Application' }, SUBMIT_BUTTON_PATTERNS)
    expect(v.clicked).toBe(true)
  })

  it('never widens the choice: a re-detected control with DIFFERENT text is not clicked', async () => {
    const page = makePage({
      handles: { b2: clickableHandle() },
      redetected: [{ bid: 'b2', text: 'Submit Feedback', inForm: true, formFieldCount: 1, isPageFeedback: false }],
    })
    const v = await clickSubmitControl(page, { bid: 'b1', text: 'Submit Application' }, SUBMIT_BUTTON_PATTERNS)
    expect(v.clicked).toBe(false)
    expect(v.dispatched).toBe(false)
  })
})
