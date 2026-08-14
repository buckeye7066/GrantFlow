/**
 * relevanceFilterStateExtraction.test.js
 *
 * Regression coverage for extractStateNameFromTitle() in relevanceFilter.js.
 * This function is a fork of the same original implementation duplicated
 * across relevanceFilterRules.js, matchEngine.js, pipelineGoalCleanupService.js
 * and two one-time scripts (scripts/cleanup-all-profiles-pipeline.mjs,
 * scripts/run-pipeline-cleanup-now.mjs). It had two bugs shared by most of
 * the forks:
 *   1. A bare substring match resolved a county/city NAME sharing a state
 *      name ("Delaware County, Ohio") as a claim about that state (DE).
 *   2. 'washington' was missing entirely from the state-name list, so a
 *      title naming the state of Washington could never be detected.
 */
import { describe, it, expect } from 'vitest'
import { extractStateNameFromTitle } from '../services/relevanceFilter.js'

describe('extractStateNameFromTitle', () => {
  it('detects a plain state name in a title', () => {
    expect(extractStateNameFromTitle('Ohio Family and Children First')).toBe('OH')
    expect(extractStateNameFromTitle('New York Tuition Assistance Program')).toBe('NY')
  })

  it('detects the state of Washington (previously missing from the list)', () => {
    expect(extractStateNameFromTitle('Washington State Housing Assistance Program')).toBe('WA')
  })

  it('does NOT resolve a county/city name sharing a state name (county-as-state guard)', () => {
    // "Delaware County, Ohio" is a real Ohio county; the bare substring
    // "delaware" must not be read as a claim about the state of Delaware.
    expect(extractStateNameFromTitle('Delaware County, Ohio 211 Community Resources')).toBe('OH')
    expect(extractStateNameFromTitle('Washington County, PA Assistance Fund')).not.toBe('WA')
    expect(extractStateNameFromTitle('Indiana County, PA Community Grant')).not.toBe('IN')
  })

  it('returns null when no state name appears', () => {
    expect(extractStateNameFromTitle('Community Development Block Grant')).toBe(null)
  })

  it('returns null for empty/missing titles', () => {
    expect(extractStateNameFromTitle('')).toBe(null)
    expect(extractStateNameFromTitle(null)).toBe(null)
    expect(extractStateNameFromTitle(undefined)).toBe(null)
  })
})
