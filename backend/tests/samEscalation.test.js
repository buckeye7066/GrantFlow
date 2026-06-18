/**
 * Unit tests for backend/services/sam/samEscalation.js
 *
 * Proves Sam's active admin escalation (charter §3/§6):
 *   - fires only on critical findings (never on clean/degraded runs)
 *   - is opt-out via SAM_ESCALATE_ADMIN=false
 *   - calls the canonical notifier with the right payload
 *   - is best-effort (a notifier failure is swallowed, never thrown)
 */

import { describe, it, expect, vi } from 'vitest'
import { escalateSamCritical, __testing__ } from '../services/sam/samEscalation.js'

const DB = { dialect: 'sqlite' } // opaque; the injected notify never touches it

describe('escalationEnabled', () => {
  it('defaults ON and respects opt-out values', () => {
    expect(__testing__.escalationEnabled({})).toBe(true)
    expect(__testing__.escalationEnabled({ SAM_ESCALATE_ADMIN: 'true' })).toBe(true)
    expect(__testing__.escalationEnabled({ SAM_ESCALATE_ADMIN: 'false' })).toBe(false)
    expect(__testing__.escalationEnabled({ SAM_ESCALATE_ADMIN: 'off' })).toBe(false)
    expect(__testing__.escalationEnabled({ SAM_ESCALATE_ADMIN: '0' })).toBe(false)
  })
})

describe('escalateSamCritical', () => {
  it('escalates and calls the notifier when there are critical findings', async () => {
    const notify = vi.fn().mockResolvedValue('notif-123')
    const res = await escalateSamCritical(DB, {
      runId: 'run-1',
      findingSummary: { total: 5, critical: 2 },
      healthScore: 41,
      productionReady: false,
      env: {},
      notify,
    })
    expect(res).toMatchObject({ escalated: true, notification_id: 'notif-123', critical_count: 2 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith(DB, {
      runId: 'run-1',
      criticalCount: 2,
      totalFindings: 5,
      healthScore: 41,
      productionReady: false,
    })
  })

  it('does NOT escalate when there are no critical findings', async () => {
    const notify = vi.fn()
    const res = await escalateSamCritical(DB, { findingSummary: { total: 4, critical: 0 }, env: {}, notify })
    expect(res).toEqual({ escalated: false, reason: 'no_critical_findings' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('does NOT escalate when disabled, even with critical findings', async () => {
    const notify = vi.fn()
    const res = await escalateSamCritical(DB, {
      findingSummary: { total: 3, critical: 3 },
      env: { SAM_ESCALATE_ADMIN: 'false' },
      notify,
    })
    expect(res).toEqual({ escalated: false, reason: 'disabled' })
    expect(notify).not.toHaveBeenCalled()
  })

  it('is best-effort — a notifier failure is reported, not thrown', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('smtp down'))
    const res = await escalateSamCritical(DB, {
      findingSummary: { total: 2, critical: 1 },
      env: {},
      notify,
    })
    expect(res.escalated).toBe(false)
    expect(res.reason).toBe('notify_failed')
    expect(res.error).toMatch(/smtp down/)
  })

  it('skips when no db is provided', async () => {
    const notify = vi.fn()
    const res = await escalateSamCritical(null, { findingSummary: { critical: 9 }, env: {}, notify })
    expect(res).toEqual({ escalated: false, reason: 'no_db' })
    expect(notify).not.toHaveBeenCalled()
  })
})
