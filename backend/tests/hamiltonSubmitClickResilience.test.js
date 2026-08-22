/**
 * "Submit button could not be clicked" must not kill a real submission over a
 * cosmetic overlay.
 *
 * Live evidence 2026-08-21 (Anastasia's run): HOPE, Aspire, GAMS and TSAA — the
 * exact Tennessee awards she most wants — all FAILED with "Submit button could
 * not be clicked". On real portals the submit control is routinely below the
 * fold and covered by a sticky footer / cookie banner / consent overlay, so
 * Playwright's actionability-checked click throws "element intercepts pointer
 * events" and the whole run fails. clickButtonByBid now falls back: scroll into
 * view → normal click → FORCED click (bypasses the pointer-intercept check) →
 * direct DOM click. A forced/DOM click still cannot fire a genuinely DISABLED
 * button, so this never submits a form the portal considers invalid.
 */
import { describe, it, expect, vi } from 'vitest'
import { _internal } from '../services/hamilton/hamiltonAutopilotEngine.js'

const { clickButtonByBid } = _internal

// A page whose $() returns a handle with configurable click behaviour.
function pageWithButton(handle) {
  return {
    $: async () => handle,
    waitForNavigation: async () => null,
    waitForLoadState: async () => null,
  }
}

describe('clickButtonByBid — resilient submit click', () => {
  it('returns false when the button is not present', async () => {
    const page = { $: async () => null, waitForNavigation: async () => null, waitForLoadState: async () => null }
    expect(await clickButtonByBid(page, 'b0')).toBe(false)
  })

  it('clicks normally when the button is actionable', async () => {
    const click = vi.fn(async () => {})
    const handle = { scrollIntoViewIfNeeded: async () => {}, click, evaluate: vi.fn() }
    expect(await clickButtonByBid(pageWithButton(handle), 'b1')).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
    expect(click.mock.calls[0][0]?.force).toBeUndefined() // first attempt is NOT forced
  })

  it('falls back to a FORCED click when a normal click is intercepted by an overlay', async () => {
    const calls = []
    const handle = {
      scrollIntoViewIfNeeded: async () => {},
      click: vi.fn(async (opts) => {
        calls.push(opts)
        if (!opts?.force) throw new Error('element intercepts pointer events')
        // forced click succeeds
      }),
      evaluate: vi.fn(),
    }
    expect(await clickButtonByBid(pageWithButton(handle), 'b2')).toBe(true)
    expect(handle.click).toHaveBeenCalledTimes(2)
    expect(calls[0]?.force).toBeUndefined()
    expect(calls[1]?.force).toBe(true)
    expect(handle.evaluate).not.toHaveBeenCalled() // forced click already worked
  })

  it('falls back to a direct DOM click when even a forced click throws', async () => {
    const domClicked = { fired: false }
    const handle = {
      scrollIntoViewIfNeeded: async () => {},
      click: vi.fn(async () => { throw new Error('not clickable') }),
      evaluate: vi.fn(async (fn) => fn({ click: () => { domClicked.fired = true } })),
    }
    expect(await clickButtonByBid(pageWithButton(handle), 'b3')).toBe(true)
    expect(handle.click).toHaveBeenCalledTimes(2) // normal + forced both tried
    expect(handle.evaluate).toHaveBeenCalledTimes(1)
    expect(domClicked.fired).toBe(true)
  })

  it('returns false only when every strategy fails', async () => {
    const handle = {
      scrollIntoViewIfNeeded: async () => {},
      click: vi.fn(async () => { throw new Error('nope') }),
      evaluate: vi.fn(async () => { throw new Error('nope') }),
    }
    expect(await clickButtonByBid(pageWithButton(handle), 'b4')).toBe(false)
  })

  it('does not fail when scrollIntoViewIfNeeded is unavailable (older handle)', async () => {
    const handle = { click: vi.fn(async () => {}), evaluate: vi.fn() }
    expect(await clickButtonByBid(pageWithButton(handle), 'b5')).toBe(true)
  })
})
