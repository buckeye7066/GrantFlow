/**
 * Tests the single fundability predicate that keeps directories / benefit
 * entitlements / past-award intel out of proposal-writing surfaces (the grant
 * pipeline and the AI Grant Scorer dropdown). Shared by backend + frontend so
 * the two can never drift.
 */
import { describe, it, expect } from 'vitest'
import {
  isProposalEligibleOpportunity,
  PROPOSAL_ELIGIBLE_KINDS,
  NON_PROPOSAL_KINDS,
} from '../../shared/opportunityFundability.js'

describe('isProposalEligibleOpportunity', () => {
  it('accepts real proposal targets', () => {
    for (const kind of PROPOSAL_ELIGIBLE_KINDS) {
      expect(isProposalEligibleOpportunity({ opportunity_kind: kind })).toBe(true)
    }
  })

  it('rejects directories, benefits, and past-award intel', () => {
    for (const kind of NON_PROPOSAL_KINDS) {
      expect(isProposalEligibleOpportunity({ opportunity_kind: kind })).toBe(false)
    }
    // The exact rows the user flagged:
    expect(isProposalEligibleOpportunity({ title: 'Veterans Crisis Line', opportunity_kind: 'DIRECTORY' })).toBe(false)
    expect(isProposalEligibleOpportunity({ title: 'Medicaid and CHIP', opportunity_kind: 'BENEFIT' })).toBe(false)
    expect(isProposalEligibleOpportunity({ title: 'HRSA Find a Health Center', opportunity_kind: 'DIRECTORY' })).toBe(false)
  })

  it('treats a legacy row with no kind as eligible (does not hide real grants)', () => {
    expect(isProposalEligibleOpportunity({ title: 'Some real grant', opportunity_kind: null })).toBe(true)
    expect(isProposalEligibleOpportunity({ title: 'Some real grant' })).toBe(true)
  })

  it('honors legacy directory signals without a canonical kind', () => {
    expect(isProposalEligibleOpportunity({ type: 'DIRECTORY' })).toBe(false)
    expect(isProposalEligibleOpportunity({ is_directory_resource: true })).toBe(false)
    expect(isProposalEligibleOpportunity({ excluded_from_grant_scoring: true })).toBe(false)
  })

  it('is case-insensitive on kind', () => {
    expect(isProposalEligibleOpportunity({ opportunity_kind: 'directory' })).toBe(false)
    expect(isProposalEligibleOpportunity({ kind: 'direct_grant' })).toBe(true)
  })
})
