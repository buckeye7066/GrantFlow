import { describe, expect, it, vi } from 'vitest'
import { listScopedHamiltonTasks } from '../services/hamilton/hamiltonTaskListing.js'
import { mapHamiltonStatus } from '../services/hamilton/applicationStatusPresentation.js'
import {
  candidateIsFalsePositive,
  profileOutcomeAtFloor,
  sweepFloors,
} from '../services/amy/crawlerMetrics.js'
import { partitionFundingSources } from '../services/matching/fundingSourcePresentation.js'
import { guardDirectFundingDecision } from '../services/matching/resourceDecisionGuard.js'
import {
  DISCOVERY_MIN_SCORE_FLOOR,
  STRONG_MATCH_SCORE,
} from '../config/matchThresholds.js'

describe('remaining 2026-07-28 production-audit corrections', () => {
  describe('Hamilton task scoping', () => {
    it('honors an accessible requested profile instead of aggregating every profile', async () => {
      const listTasks = vi.fn(async ({ profileId }) => [{ id: `task-${profileId}`, profile_id: profileId }])
      const result = await listScopedHamiltonTasks({
        requestedProfileId: 'p1',
        accessibleProfileIds: new Set(['p1', 'p2']),
        listTasks,
      })

      expect(result.forbidden).toBe(false)
      expect(result.tasks).toEqual([{ id: 'task-p1', profile_id: 'p1' }])
      expect(listTasks).toHaveBeenCalledTimes(1)
      expect(listTasks).toHaveBeenCalledWith(expect.objectContaining({ profileId: 'p1' }))
    })

    it('refuses a requested profile outside the caller access set', async () => {
      const listTasks = vi.fn()
      const result = await listScopedHamiltonTasks({
        requestedProfileId: 'p3',
        accessibleProfileIds: new Set(['p1', 'p2']),
        listTasks,
      })

      expect(result).toEqual({ forbidden: true, tasks: [] })
      expect(listTasks).not.toHaveBeenCalled()
    })

    it('aggregates accessible profiles only when no profile filter was requested', async () => {
      const listTasks = vi.fn(async ({ profileId }) => [{ id: `task-${profileId}`, profile_id: profileId }])
      const result = await listScopedHamiltonTasks({
        accessibleProfileIds: new Set(['p1', 'p2']),
        listTasks,
      })

      expect(result.tasks.map((task) => task.profile_id)).toEqual(['p1', 'p2'])
      expect(listTasks).toHaveBeenCalledTimes(2)
    })
  })

  describe('submission evidence', () => {
    it('does not call a completed draft submitted', () => {
      expect(mapHamiltonStatus({ task_status: 'completed_draft' })).toBe('in_progress')
      expect(mapHamiltonStatus({ task_status: 'draft_completed' })).toBe('in_progress')
      expect(mapHamiltonStatus({ task_status: 'completed' })).toBe('in_progress')
    })

    it('requires submitted_at before reporting submitted', () => {
      expect(mapHamiltonStatus({ task_status: 'submitted', submitted_at: null })).toBe('in_progress')
      expect(mapHamiltonStatus({ task_status: 'submitted', submitted_at: '2026-07-28T20:00:00Z' })).toBe('submitted')
    })
  })

  describe('Amy metric integrity', () => {
    it('uses the same narrow false-positive rule as the finding generator', () => {
      const falsePositive = { score: 12, decision: 'ACCEPT', genericOnly: true, locator: false }
      const locator = { score: 12, decision: 'REVIEW', genericOnly: true, locator: true }
      const direct = { score: 12, decision: 'ACCEPT', genericOnly: false, locator: false }

      expect(candidateIsFalsePositive(falsePositive)).toBe(true)
      expect(candidateIsFalsePositive(locator)).toBe(false)

      const outcome = profileOutcomeAtFloor({ candidates: [falsePositive, locator, direct] }, 8)
      expect(outcome).toEqual({
        qualified: 3,
        accepted: 1,
        resources: 1,
        falsePositives: 1,
        covered: true,
      })
    })

    it('sweeps the active data-point scale, not the retired 50-90 scale', () => {
      const result = sweepFloors([{ candidates: [{ score: 10, decision: 'ACCEPT' }] }])
      expect(result.sweep[0].floor).toBe(DISCOVERY_MIN_SCORE_FLOOR)
      expect(result.sweep.at(-1).floor).toBe(STRONG_MATCH_SCORE + 10)
    })
  })

  describe('funding versus resources', () => {
    it('keeps directories visible without inflating the funding-source total', () => {
      const direct = { id: 'direct', match_decision: 'accept', is_directory: false }
      const directory = { id: 'directory', match_decision: 'review', is_directory: true }
      const result = partitionFundingSources([direct, directory])

      expect(result.total).toBe(1)
      expect(result.sources).toEqual([direct])
      expect(result.best_matches).toEqual([direct])
      expect(result.directories).toEqual([directory])
      expect(result.resource_count).toBe(1)
    })

    it('demotes a directory ACCEPT at the canonical decision boundary', () => {
      const result = guardDirectFundingDecision({
        decision: 'ACCEPT',
        explanation: 'Strong match',
        reasons: ['score above threshold'],
        isDirectoryResource: true,
      })

      expect(result.decision).toBe('REVIEW')
      expect(result.explanation).toMatch(/directory or referral/i)
      expect(result.reasons).toContain('Directory locator cannot be certified as a direct funding match')
    })
  })
})
