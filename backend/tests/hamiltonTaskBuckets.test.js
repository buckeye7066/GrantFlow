/**
 * The bucket map must be TOTAL over the canonical status vocabulary, and the
 * counts it produces must sum to the list it was given.
 *
 * This is the guard for the defect that produced the owner's 2026-08-21
 * report: three surfaces each hand-typed a subset of `TASK_STATUSES`, and the
 * statuses none of them named became invisible. On production that was 523 of
 * 931 tasks. A registry plus a totality test is the repo's standing answer to
 * exactly this shape (see the MIGRATION PARITY section of CLAUDE.md).
 */
import { describe, it, expect } from 'vitest'
import {
  BUCKET_ORDER,
  TASK_BUCKETS,
  TASK_STATUS_BUCKET,
  TRACKER_STATUS_BY_BUCKET,
  bucketForTaskStatus,
  countTaskBuckets,
  isRecognisedTaskStatus,
  terminalOutcome,
} from '../../shared/hamiltonTaskLifecycle.js'
import { TASK_STATUSES, TASK_TERMINAL_STATUSES } from '../services/hamilton/applicationTaskStore.js'
import { mapHamiltonStatus, terminalReasonLabel } from '../services/hamilton/applicationStatusPresentation.js'

describe('the Hamilton task bucket map', () => {
  it('assigns EVERY canonical task status to a bucket', () => {
    const unmapped = TASK_STATUSES.filter((s) => !Object.prototype.hasOwnProperty.call(TASK_STATUS_BUCKET, s))
    expect(unmapped).toEqual([])
  })

  it('never invents a status the canonical vocabulary does not have', () => {
    const canonical = new Set(TASK_STATUSES)
    const strays = Object.keys(TASK_STATUS_BUCKET).filter((s) => !canonical.has(s))
    expect(strays).toEqual([])
  })

  it('only ever uses the four declared buckets', () => {
    const buckets = new Set(Object.values(TASK_STATUS_BUCKET))
    for (const bucket of buckets) expect(TASK_BUCKETS).toContain(bucket)
    for (const bucket of TASK_BUCKETS) expect(BUCKET_ORDER[bucket]).toBeTypeOf('number')
  })

  it('counts sum to the list length — nothing is invisible', () => {
    const tasks = TASK_STATUSES.map((status, i) => ({ id: `t${i}`, status }))
    const counts = countTaskBuckets(tasks)
    expect(counts.total).toBe(TASK_STATUSES.length)
    expect(counts.working + counts.needs_you + counts.waiting + counts.finished).toBe(counts.total)
    expect(counts.unrecognised).toBe(0)
  })

  it('puts an UNKNOWN status somewhere loud rather than swallowing it', () => {
    expect(bucketForTaskStatus('a_status_that_does_not_exist')).toBe('needs_you')
    expect(isRecognisedTaskStatus('a_status_that_does_not_exist')).toBe(false)
    const counts = countTaskBuckets([{ id: 'x', status: 'a_status_that_does_not_exist' }])
    expect(counts.unrecognised).toBe(1)
    expect(counts.total).toBe(1)
  })

  it('counts a task that is filling a portal as WORKING', () => {
    // The exact production case: two tasks in `filling_portal` while the
    // header read "Hamilton is not working right now · 0 working".
    expect(bucketForTaskStatus('filling_portal')).toBe('working')
    expect(countTaskBuckets([{ status: 'filling_portal' }]).working).toBe(1)
  })

  it('counts a captcha or login wall as NEEDS YOU, in both spellings', () => {
    for (const status of [
      'waiting_for_captcha', 'blocked_captcha',
      'waiting_for_login', 'blocked_login_required',
      'waiting_for_2fa', 'blocked_2fa',
      'waiting_for_missing_info', 'blocked_missing_info',
      'waiting_for_review',
    ]) {
      expect(bucketForTaskStatus(status), status).toBe('needs_you')
    }
  })

  it('counts a COMPLETED task as finished', () => {
    // `completed` was in no bucket at all, which is why production cards read
    // "completed · auto profile" under the heading "Waiting".
    expect(bucketForTaskStatus('completed')).toBe('finished')
  })

  it('gives every terminal status a distinct outcome word', () => {
    for (const status of TASK_TERMINAL_STATUSES) {
      expect(terminalOutcome(status), status).toBeTruthy()
    }
    expect(terminalOutcome('submitted')).toBe('submitted')
    expect(terminalOutcome('cancelled')).toBe('cancelled')
    expect(terminalOutcome('failed')).toBe('failed')
    expect(terminalOutcome('in_progress')).toBeNull()
  })
})

describe('the tracker status mapping', () => {
  it('never calls a system cancellation "withdrawn"', () => {
    // 295 of production's 331 cancellations were written by one boot sweep in
    // a single second. "Withdrawn" claims the applicant changed their mind.
    expect(mapHamiltonStatus({ status: 'cancelled' })).not.toBe('withdrawn')
    expect(mapHamiltonStatus({ status: 'cancelled' })).toBe('closed')
    expect(terminalReasonLabel({ status: 'cancelled' })).toBe('cancelled')
  })

  it('does not park a FAILED task in the "In Progress" lane', () => {
    expect(mapHamiltonStatus({ status: 'failed' })).toBe('closed')
  })

  it('routes a wall to the lane that exists for it', () => {
    // "Needs review" was unreachable, which is why the tracker read
    // "Needs review 0" on the same data the run view read "8 need you".
    for (const status of ['blocked', 'waiting_for_captcha', 'waiting_for_login']) {
      expect(mapHamiltonStatus({ status }), status).toBe('unknown')
    }
  })

  it('only calls a task submitted when it carries the timestamp too', () => {
    expect(mapHamiltonStatus({ status: 'submitted', submitted_at: '2026-08-03T05:29:00Z' })).toBe('submitted')
    expect(mapHamiltonStatus({ status: 'submitted', submitted_at: null })).toBe('in_progress')
  })

  it('routes an unrecognised status to review rather than hiding it', () => {
    expect(mapHamiltonStatus({ status: 'not_a_real_status' })).toBe('unknown')
  })

  it('produces a tracker lane for every canonical status', () => {
    for (const status of TASK_STATUSES) {
      const lane = mapHamiltonStatus({ status, submitted_at: '2026-01-01T00:00:00Z' })
      expect(lane, status).toBeTruthy()
      expect(
        ['draft', 'in_progress', 'submitted', 'under_review', 'awarded', 'denied', 'withdrawn', 'closed', 'unknown'],
        status,
      ).toContain(lane)
    }
  })

  it('has a tracker lane for every bucket', () => {
    for (const bucket of TASK_BUCKETS) {
      expect(TRACKER_STATUS_BY_BUCKET[bucket], bucket).toBeTruthy()
    }
  })
})
