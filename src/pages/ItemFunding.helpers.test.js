/**
 * Item Funding scanner regression guards (owner QA pass, 2026-08-03):
 *
 * BUG 1 — the selected profile silently reset to "All profiles" after the
 * first fruitless search: the reset (wired to the zero-result guidance's
 * "Try broader words" action) wrote `profileId: "all"`, so every follow-up
 * search returned 0 with the live web lane reporting "Needs a profile".
 * `resetFiltersPreservingProfile` is the fix: a reset clears WHAT is
 * searched, never WHO it is searched for.
 *
 * This test FAILS on the pre-fix shape (verified by mutation: restoring
 * `profileId: "all"` in the helper reddens it).
 */

import { describe, it, expect } from 'vitest'
import { resetFiltersPreservingProfile } from './itemFundingState.js'

describe('ItemFunding — reset preserves the selected profile', () => {
  it('keeps profileId across a reset (the "Needs a profile" regression)', () => {
    const next = resetFiltersPreservingProfile({
      item: 'wheelchair ramp',
      state: 'TN',
      includeNational: false,
      profileId: 'profile-lisa-klinger',
    })
    expect(next.profileId).toBe('profile-lisa-klinger')
    expect(next.item).toBe('')
    expect(next.state).toBe('all')
    expect(next.includeNational).toBe(true)
  })

  it('an admin browsing "all" stays on "all" — the helper never invents a profile either', () => {
    const next = resetFiltersPreservingProfile({ item: 'x', state: 'all', includeNational: true, profileId: 'all' })
    expect(next.profileId).toBe('all')
  })
})
