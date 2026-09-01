/**
 * hamiltonAuthBackupPlan — first direct coverage (2026-08-31; the module had
 * ZERO test importers while it decided every auth-blocked task's fate).
 *
 * Pins:
 *  - the login ladder (15m → 1h → 4h → 12h → 24h) and its exhaustion hand-off;
 *  - the CAPTCHA-specific schedule (4h → 12h → 24h): a captcha does not clear
 *    itself on a 15-minute cadence — recovery is the solver on the next run or
 *    a human co-browse that saves a session (which now resumes tasks
 *    immediately via resumeAuthWaitingTasksForHost, so the timer is only the
 *    fallback);
 *  - kind mapping totality for the statuses the scheduler re-picks;
 *  - non-auth kinds stay the caller's ordinary blocked path.
 */
import { describe, it, expect } from 'vitest'
import {
  planAuthBackup,
  isAuthBlocker,
  AUTH_BACKOFF_MINUTES,
  CAPTCHA_BACKOFF_MINUTES,
  AUTH_MAX_ATTEMPTS,
} from '../services/hamilton/hamiltonAuthBackupPlan.js'

describe('planAuthBackup', () => {
  it('login ladder: 15m first, escalating, exhausting into a hard blocked hand-off', () => {
    const now = Date.parse('2026-08-31T00:00:00Z')
    const first = planAuthBackup({ blockerKind: 'login', retryCount: 0, now })
    expect(first.isAuth).toBe(true)
    expect(first.status).toBe('waiting_for_login')
    expect(first.retryInMinutes).toBe(AUTH_BACKOFF_MINUTES[0])
    expect(first.nextRetryAt).toBe(new Date(now + 15 * 60_000).toISOString())

    const last = planAuthBackup({ blockerKind: 'login', retryCount: AUTH_MAX_ATTEMPTS - 1, now })
    expect(last.retryInMinutes).toBe(AUTH_BACKOFF_MINUTES[AUTH_MAX_ATTEMPTS - 1])

    const done = planAuthBackup({ blockerKind: 'login', retryCount: AUTH_MAX_ATTEMPTS, now })
    expect(done.exhausted).toBe(true)
    expect(done.status).toBe('blocked')
    expect(done.nextRetryAt).toBeNull()
    expect(done.message).toMatch(/sign in once side-by-side|complete the sign-in/i)
  })

  it('CAPTCHA gets its own sane schedule: first retry is HOURS out, not 15 minutes', () => {
    const now = Date.parse('2026-08-31T00:00:00Z')
    const first = planAuthBackup({ blockerKind: 'captcha', retryCount: 0, now })
    expect(first.status).toBe('waiting_for_captcha')
    expect(first.retryInMinutes).toBe(CAPTCHA_BACKOFF_MINUTES[0])
    expect(first.retryInMinutes).toBeGreaterThanOrEqual(240)
    expect(first.maxAttempts).toBe(CAPTCHA_BACKOFF_MINUTES.length)
    expect(first.message).toMatch(/side-by-side|co-browse/i)

    const done = planAuthBackup({ blockerKind: 'captcha', retryCount: CAPTCHA_BACKOFF_MINUTES.length, now })
    expect(done.exhausted).toBe(true)
    expect(done.message).toMatch(/co-browse|side-by-side/i)
  })

  it('every waiting status the scheduler re-picks is produced by some kind (totality)', () => {
    const statuses = new Set(
      ['login', 'sso', '2fa', 'captcha', 'email_verification'].map(
        (k) => planAuthBackup({ blockerKind: k }).status,
      ),
    )
    expect(statuses).toEqual(new Set([
      'waiting_for_login', 'waiting_for_2fa', 'waiting_for_captcha', 'waiting_for_email_verification',
    ]))
  })

  it('non-auth kinds are not auth blockers and take the ordinary blocked path', () => {
    for (const kind of ['payment', 'validation', 'listing_page', 'no_progress', null, '']) {
      expect(isAuthBlocker(kind)).toBe(false)
      expect(planAuthBackup({ blockerKind: kind }).isAuth).toBe(false)
    }
  })

  it('classifier categories map too (login_required / captcha_required)', () => {
    expect(planAuthBackup({ blockerKind: 'login_required' }).status).toBe('waiting_for_login')
    expect(planAuthBackup({ blockerKind: 'captcha_required' }).status).toBe('waiting_for_captcha')
    expect(planAuthBackup({ blockerKind: 'captcha_required' }).retryInMinutes).toBe(CAPTCHA_BACKOFF_MINUTES[0])
  })
})
