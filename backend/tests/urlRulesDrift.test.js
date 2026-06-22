/**
 * Guards the single-source-of-truth rule for URL validation.
 *
 * backend/config/urlRules.js is the canonical list. Any crawler/policy module
 * that still holds its own copy must at least *extend* the canonical list,
 * never replace it.
 */
import { describe, it, expect } from 'vitest'
import {
  PLACEHOLDER_HOSTNAMES as CANONICAL_HOSTS,
  PLACEHOLDER_TEXT_PATTERNS as CANONICAL_TEXT,
  pickRealUrl,
  isPlaceholderUrl,
  isNonActionableUrl,
} from '../config/urlRules.js'
import {
  getPlaceholderHostnames,
  pickRealUrl as policyPickRealUrl,
  isPlaceholderOpportunity,
} from '../services/shared/opportunityPolicy.js'

describe('urlRules drift protection', () => {
  it('opportunityPolicy reuses canonical placeholder hostnames', () => {
    const policyList = new Set(getPlaceholderHostnames())
    for (const host of CANONICAL_HOSTS) {
      expect(policyList.has(host), `policy list missing canonical host ${host}`).toBe(true)
    }
  })

  it('opportunityPolicy.pickRealUrl delegates to canonical pickRealUrl semantics', () => {
    const opp = {
      application_url: 'https://example.com/apply', // placeholder hostname
      apply_url: 'https://grants.nih.gov/foa',
      source_url: 'https://facebook.com/foo', // non-actionable
    }
    // Both pickRealUrl variants must reject the placeholder and prefer the
    // real apply URL. (Policy variant goes through the canonical picker.)
    expect(pickRealUrl(opp)).toBe('https://grants.nih.gov/foa')
    expect(policyPickRealUrl(opp)).toBe('https://grants.nih.gov/foa')
  })

  it('isPlaceholderUrl recognises every canonical host', () => {
    for (const host of CANONICAL_HOSTS) {
      // synthesize a URL (skip numeric hosts that are IPs only)
      const url = `https://${host}/path`
      expect(isPlaceholderUrl(url), `expected placeholder: ${url}`).toBe(true)
    }
  })

  it('isNonActionableUrl catches social links', () => {
    expect(isNonActionableUrl('https://twitter.com/someone')).toBe(true)
    expect(isNonActionableUrl('https://grants.gov/foa')).toBe(false)
  })

  it('isPlaceholderOpportunity catches the canonical placeholder phrases', () => {
    const samples = [
      'lorem ipsum body text here',
      'placeholder opportunity for testing',
      'coming soon — details to follow',
      'TBD until funder publishes',
      'to be determined by committee',
      'test opportunity fixture',
      'N/A',
      'sample grant program',
    ]
    for (const text of samples) {
      const opp = { title: text, description: text }
      expect(isPlaceholderOpportunity(opp), `expected placeholder for: ${text}`).toBe(true)
    }
  })

  it('CANONICAL_TEXT is non-empty (drift guard)', () => {
    expect(CANONICAL_TEXT.length).toBeGreaterThan(0)
  })
})
