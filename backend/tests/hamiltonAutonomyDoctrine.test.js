/**
 * Full-automation doctrine — the orchestrator-side stalls measured on a real
 * full-automation profile (prod 2026-08-31) and what replaces each:
 *
 *  - the run-loop tripwire counted SCHEDULED deferrals (an LLM-credit outage)
 *    and bounded auth backoffs as "opened 3 times, needs a human look" on 15
 *    tasks, naming nothing → deferrals/auth backoffs are not counted; the
 *    tripwire names the dominant outcome; a transient class pauses 24 h.
 *  - transient engine failures (context destroyed, browser closed, timeouts,
 *    connection reset) landed in TERMINAL `failed` → bounded retry, then a
 *    NAMED blocked state with the link.
 *  - CAPTCHA / 2FA hand-offs read "retried this login several times" → the
 *    message names the wall, the URL, the solver's last verdict, the fix.
 *  - studentaid.gov Pell/FSEOG/Work-Study/FAFSA and benefits.gov were printed
 *    as mail packets "waiting for review" → routed through the FAFSA-link
 *    pathway / closed as a finder research lead.
 *  - seven `submission_verification_required` cards were newsletter forms →
 *    settled by a sweep from the retained run's own evidence.
 *  - "waiting for review" parking under full automation → auto-released,
 *    bounded, using the owner's own release classification.
 */
import { describe, it, expect, beforeEach } from 'vitest'

const Database = (await import('better-sqlite3')).default
const { _internal, MAX_AUTOPILOT_RUNS_PER_DAY, FAILURE_BACKOFF_MINUTES } = await import('../services/hamilton/hamiltonAutomationOrchestrator.js')
const { ensureApplicationTaskSchema, appendTaskEvent, _resetSchemaCache, setMissingInfo } = await import('../services/hamilton/applicationTaskStore.js')
const { createAutopilotRun, updateAutopilotRun, _resetAuthSchemaCache, recordAuthorizations } = await import('../services/hamilton/hamiltonAuthorizationStore.js')
const { planAuthBackup, AUTH_MAX_ATTEMPTS } = await import('../services/hamilton/hamiltonAuthBackupPlan.js')
const {
  resolveContactFormVerifications, releaseParkedReviewsUnderFullAutomation, isContactShapedSubmission,
  MAX_AUTO_RELEASES, CONTACT_SHAPED_KEYS,
} = await import('../services/hamilton/hamiltonAutonomySweeps.js')

const { detectAutopilotRunLoop, diagnoseRunOutcomes, classifyEngineFailure, decideTermsForbiddenSource } = _internal

function makeDb() {
  _resetSchemaCache()
  _resetAuthSchemaCache()
  return new Database(':memory:')
}

async function seedTask(db, id, status = 'ready_to_start', extra = {}) {
  await db.prepare(`
    INSERT INTO application_tasks (id, profile_id, user_id, opportunity_id, status, allow_auto_submit, auto_submit_enabled, updated_at, last_agent_message, application_url)
    VALUES (?, ?, 'u1', ?, ?, 1, 1, ?, ?, ?)
  `).run(id, extra.profileId || 'p1', `opp-${id}`, status, new Date().toISOString(), extra.message || null, extra.url || null)
}

async function seedRun(db, taskId, { status = 'blocked', blockerKind = null, blockerDetail = null, ageMs = 60_000, result = null } = {}) {
  const run = await createAutopilotRun(db, { taskId, profileId: 'p1', status: 'running' })
  await updateAutopilotRun(db, run.id, { status, blockerKind, blockerDetail, ...(result ? { result } : {}), finishedAt: new Date().toISOString() })
  db.prepare('UPDATE hamilton_autopilot_runs SET created_at = ? WHERE id = ?').run(new Date(Date.now() - ageMs).toISOString(), run.id)
  return run
}

// ── A. run-loop tripwire diagnoses; scheduled deferrals are not a loop ───────
describe('run-loop tripwire under full automation', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
    await seedTask(db, 't1')
  })

  it('does NOT count scheduled deferrals (the LLM-credit outage class) or bounded auth backoffs', async () => {
    for (let i = 0; i < MAX_AUTOPILOT_RUNS_PER_DAY + 2; i += 1) await seedRun(db, 't1', { status: 'deferred', ageMs: 1000 * (i + 1) })
    expect(await detectAutopilotRunLoop(db, { taskId: 't1' })).toBeNull()
    for (let i = 0; i < MAX_AUTOPILOT_RUNS_PER_DAY; i += 1) await seedRun(db, 't1', { status: 'blocked', blockerKind: 'login', blockerDetail: 'Saved login could not be completed automatically', ageMs: 2000 * (i + 1) })
    expect(await detectAutopilotRunLoop(db, { taskId: 't1' })).toBeNull()
  })

  it('still trips on real repeated hard outcomes and NAMES the dominant one', async () => {
    for (let i = 0; i < MAX_AUTOPILOT_RUNS_PER_DAY; i += 1) {
      await seedRun(db, 't1', { status: 'blocked', blockerKind: 'no_application_form', blockerDetail: 'This page has no application form to fill', ageMs: 1000 * (i + 1) })
    }
    const loop = await detectAutopilotRunLoop(db, { taskId: 't1' })
    expect(loop?.kind).toBe('run_loop')
    expect(loop.runs).toBe(MAX_AUTOPILOT_RUNS_PER_DAY)
    expect(loop.retryable).toBe(false)
    expect(loop.detail).toMatch(/opened this source 3 times/)
    expect(loop.detail).toContain('no_application_form — This page has no application form to fill')
    expect(loop.detail).not.toMatch(/needs a human look/)
  })

  it('a repeated TRANSIENT outcome is retryable (pause, not park)', async () => {
    for (let i = 0; i < MAX_AUTOPILOT_RUNS_PER_DAY; i += 1) {
      await seedRun(db, 't1', { status: 'failed', blockerKind: 'portal_unreachable', blockerDetail: 'Hamilton could not reach www.tn.gov', ageMs: 1000 * (i + 1) })
    }
    const loop = await detectAutopilotRunLoop(db, { taskId: 't1' })
    expect(loop?.retryable).toBe(true)
    expect(loop.detail).toMatch(/pauses this source for 24 hours/)
  })

  it('diagnoseRunOutcomes ranks the dominant outcome', () => {
    const d = diagnoseRunOutcomes([
      { status: 'blocked', blocker_kind: 'login', blocker_detail: 'Saved login could not be completed automatically\nCall log' },
      { status: 'blocked', blocker_kind: 'login', blocker_detail: 'Saved login could not be completed automatically' },
      { status: 'failed', blocker_kind: 'engine_error', blocker_detail: 'x' },
    ])
    expect(d.dominant_kind).toBe('login')
    expect(d.dominant_count).toBe(2)
    expect(d.summary).toBe('login — Saved login could not be completed automatically')
    expect(d.retryable).toBe(false)
  })
})

// ── C/D. auth hand-offs name the wall, the URL, and the fix ─────────────────
describe('planAuthBackup messages are kind-aware and name the portal', () => {
  it('a CAPTCHA hand-off never reads "retried this login"', () => {
    const p = planAuthBackup({ blockerKind: 'captcha', retryCount: AUTH_MAX_ATTEMPTS, portalUrl: 'https://csc.mtsu.edu/scholarships/', lastReason: 'solver: poll_failed:ERROR_INVALID_TASK_DATA' })
    expect(p.exhausted).toBe(true)
    expect(p.message).toMatch(/CAPTCHA/)
    expect(p.message).toContain('https://csc.mtsu.edu/scholarships/')
    expect(p.message).toContain('ERROR_INVALID_TASK_DATA')
    expect(p.message).not.toMatch(/retried this login/)
    const deferred = planAuthBackup({ blockerKind: 'captcha', retryCount: 0, portalUrl: 'https://csc.mtsu.edu/scholarships/' })
    expect(deferred.status).toBe('waiting_for_captcha')
    expect(deferred.message).toMatch(/CAPTCHA/)
    expect(deferred.message).not.toMatch(/sign in to this portal once/)
  })
  it('a login hand-off names the portal and the side-by-side fix; a 2FA hand-off names the code', () => {
    const login = planAuthBackup({ blockerKind: 'login', retryCount: AUTH_MAX_ATTEMPTS, portalUrl: 'https://www.tvfcu.com/' })
    expect(login.message).toContain('https://www.tvfcu.com/')
    expect(login.message).toMatch(/side-by-side/)
    expect(login.message).not.toMatch(/Final Submit remains yours/)
    const twofa = planAuthBackup({ blockerKind: '2fa', retryCount: 1, portalUrl: 'https://portal.example.org/' })
    expect(twofa.status).toBe('waiting_for_2fa')
    expect(twofa.message).toMatch(/one-time code/)
  })
  it('the schedule itself is unchanged', () => {
    expect(planAuthBackup({ blockerKind: 'login', retryCount: 0 }).retryInMinutes).toBe(15)
    expect(planAuthBackup({ blockerKind: 'login', retryCount: 4 }).retryInMinutes).toBe(1440)
    expect(planAuthBackup({ blockerKind: 'nope' }).isAuth).toBe(false)
  })
})

// ── I. transient failures are retried, then parked NAMED — never terminal `failed`
describe('classifyEngineFailure', () => {
  it('context-destroyed / browser-closed / timeout / unreachable / click_failed are transient and back off 30m → 2h → 8h', () => {
    const cases = [
      { blocker_kind: 'engine_error', blocker_detail: 'page.$$eval: Execution context was destroyed, most likely because of a navigation' },
      { blocker_kind: 'engine_error', blocker_detail: 'page.goto: Target page, context or browser has been closed\nCall log:' },
      { blocker_kind: 'portal_unreachable', blocker_detail: 'Hamilton could not reach www.tn.gov — the site may be down' },
      { blocker_kind: 'click_failed', blocker_detail: 'Submit button could not be clicked' },
    ]
    for (const c of cases) {
      const p0 = classifyEngineFailure(c, { retryCount: 0, now: 0, url: 'https://www.tn.gov/collegepays' })
      expect(p0.transient).toBe(true)
      expect(p0.status).toBe('waiting_for_window')
      expect(p0.retryCount).toBe(1)
      expect(Date.parse(p0.nextRetryAt)).toBe(FAILURE_BACKOFF_MINUTES[0] * 60_000)
      expect(p0.message).toMatch(/retries automatically/)
      const p2 = classifyEngineFailure(c, { retryCount: 2, now: 0, url: 'https://www.tn.gov/collegepays' })
      expect(Date.parse(p2.nextRetryAt)).toBe(FAILURE_BACKOFF_MINUTES[2] * 60_000)
    }
  })
  it('the exhausted case parks BLOCKED with the URL and the side-by-side instruction — never failed', () => {
    const p = classifyEngineFailure({ blocker_kind: 'portal_unreachable', blocker_detail: 'Hamilton could not reach www.tn.gov' }, { retryCount: FAILURE_BACKOFF_MINUTES.length, url: 'https://www.tn.gov/collegepays' })
    expect(p.transient).toBe(true)
    expect(p.exhausted).toBe(true)
    expect(p.status).toBe('blocked')
    expect(p.message).toContain('https://www.tn.gov/collegepays')
    expect(p.message).toMatch(/side-by-side/)
  })
  it('a genuine engine error (not a race) is not transient', () => {
    expect(classifyEngineFailure({ blocker_kind: 'engine_error', blocker_detail: 'TypeError: cannot read properties of undefined' }).transient).toBe(false)
    expect(classifyEngineFailure({ blocker_kind: 'no_browser', blocker_detail: 'x' }).transient).toBe(false)
  })
})

// ── F. ToS-forbidden federal hosts route, they are not printed ───────────────
describe('decideTermsForbiddenSource', () => {
  it('studentaid.gov with the FAFSA filed → completed, covered by the FAFSA', () => {
    const d = decideTermsForbiddenSource({ host: 'studentaid.gov', title: 'Federal Pell Grant', fafsa: { filed: true, stage: 'processed', updated_at: '2026-08-02T03:16:40Z' } })
    expect(d.route).toBe('fafsa_covered')
    expect(d.status).toBe('completed')
    expect(d.message).toMatch(/awarded through your FAFSA/)
    expect(d.message).toContain('processed')
  })
  it('studentaid.gov with NO FAFSA on file → the FAFSA-link ask pathway (the one structured ask that auto-resumes)', () => {
    expect(decideTermsForbiddenSource({ host: 'studentaid.gov', title: 'FAFSA', fafsa: { filed: false, stage: 'not_started' } }).route).toBe('fafsa_link')
  })
  it('benefits.gov is a finder → research lead; other ToS hosts fall through to the packet', () => {
    expect(decideTermsForbiddenSource({ host: 'www.benefits.gov', title: 'SPAP', fafsa: { filed: false } })).toMatchObject({ route: 'benefit_finder', status: 'completed' })
    expect(decideTermsForbiddenSource({ host: 'commonapp.org', title: 'x', fafsa: { filed: true } })).toBeNull()
  })
})

// ── G. quarantined newsletter "submissions" are settled from their own evidence
describe('resolveContactFormVerifications', () => {
  let db
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
  })

  it('isContactShapedSubmission mirrors the engine vocabulary and refuses anything application-shaped', () => {
    expect(CONTACT_SHAPED_KEYS).toContain('first_name')
    expect(isContactShapedSubmission({ filled_fields: [{ key: 'first_name' }, { key: 'last_name' }, { key: 'email' }], pages_visited: 1 })).toBe(true)
    expect(isContactShapedSubmission({ filled_fields: [{ key: 'zip' }], pages_visited: 1 })).toBe(true)
    expect(isContactShapedSubmission({ filled_fields: [{ key: 'first_name' }, { key: 'essay', source: 'narrative' }], pages_visited: 1 })).toBe(false)
    expect(isContactShapedSubmission({ filled_fields: [{ key: 'first_name' }, { key: 'id_ssn', source: 'identity_vault' }], pages_visited: 1 })).toBe(false)
    expect(isContactShapedSubmission({ filled_fields: [{ key: 'first_name' }, { key: 'email' }], pages_visited: 6 })).toBe(false)
    expect(isContactShapedSubmission({ filled_fields: [] })).toBe(false)
  })

  it('closes a contact-shaped quarantine as "no application was submitted" and leaves a real one alone', async () => {
    await seedTask(db, 'news', 'submission_verification_required', { url: 'https://www.familypromisebradleytn.org/' })
    await seedRun(db, 'news', {
      status: 'submission_verification_required', blockerKind: 'submission_verification_required',
      result: { submit_clicked: true, pages_visited: 1, filled_fields: [{ key: 'first_name', fid: 'f1' }, { key: 'last_name', fid: 'f2' }, { key: 'email', fid: 'f3' }] },
    })
    await seedTask(db, 'real', 'submission_verification_required', { url: 'https://portal.example.org/apply' })
    await seedRun(db, 'real', {
      status: 'submission_verification_required', blockerKind: 'submission_verification_required',
      result: { submit_clicked: true, pages_visited: 4, filled_fields: [{ key: 'first_name' }, { key: 'essay', source: 'narrative' }, { key: 'gpa' }] },
    })
    const out = await resolveContactFormVerifications(db, { logger: { info() {}, warn() {} } })
    expect(out).toMatchObject({ scanned: 2, resolved: 1, kept: 1, failed: 0 })
    const news = db.prepare(`SELECT status, last_agent_message FROM application_tasks WHERE id='news'`).get()
    expect(news.status).toBe('completed')
    expect(news.last_agent_message).toMatch(/contact \/ newsletter sign-up/)
    expect(news.last_agent_message).toContain('https://www.familypromisebradleytn.org/')
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='real'`).get().status).toBe('submission_verification_required')
    // idempotent
    const again = await resolveContactFormVerifications(db, { logger: { info() {}, warn() {} } })
    expect(again.scanned).toBe(1)
    expect(again.resolved).toBe(0)
  })
})

// ── H. "waiting for review" is not a full-automation state ──────────────────
describe('releaseParkedReviewsUnderFullAutomation', () => {
  let db
  const quiet = { info() {}, warn() {} }
  beforeEach(async () => {
    db = makeDb()
    await ensureApplicationTaskSchema(db)
  })

  async function grantFullAutomation(profileId) {
    await recordAuthorizations(db, {
      userId: 'u1', profileId, scope: 'profile', authorizationTypes: ['submit_applications', 'complete_forms'],
      authorizationText: 'full automation', options: { allow_auto_submit: true, require_human_review: false },
    })
  }

  it('releases a releasable card ONLY for a full-automation profile, keeps legitimate hand-offs, and is bounded', async () => {
    await grantFullAutomation('p1')
    await seedTask(db, 'stale', 'waiting_for_review', { message: 'Hamilton Autopilot finished filling the application and saved a draft. Authorize submit_applications and click "Run to completion" to finish.' })
    await seedTask(db, 'physical', 'waiting_for_review', { message: 'Hamilton produced a printable packet (mail) — print, sign and mail it.' })
    await seedTask(db, 'ask', 'waiting_for_review', { message: 'Hamilton needs one more answer.' })
    await setMissingInfo(db, 'ask', [{ kind: 'field', key: 'oldest_sibling', label: 'Oldest sibling?', required: true }])
    await seedTask(db, 'other', 'waiting_for_review', { profileId: 'p2', message: 'Hamilton Autopilot switched to the manual pathway: No clear application URL' })

    const out = await releaseParkedReviewsUnderFullAutomation(db, { logger: quiet })
    expect(out.released).toBe(1)
    expect(out.released_ids).toEqual(['stale'])
    expect(out.kept).toBe(2)
    expect(out.not_full_automation).toBe(1)
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='stale'`).get().status).toBe('ready_to_start')
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='physical'`).get().status).toBe('waiting_for_review')
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='ask'`).get().status).toBe('waiting_for_review')
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='other'`).get().status).toBe('waiting_for_review')

    // Cooldown: parked again within 24h → not re-released.
    db.prepare(`UPDATE application_tasks SET status='waiting_for_review' WHERE id='stale'`).run()
    const cooled = await releaseParkedReviewsUnderFullAutomation(db, { logger: quiet })
    expect(cooled.released).toBe(0)
    expect(cooled.cooled_down).toBe(1)
    // After the cooldown a second release is allowed; a third is capped.
    const later = Date.now() + 25 * 60 * 60_000
    const second = await releaseParkedReviewsUnderFullAutomation(db, { logger: quiet, now: later })
    expect(second.released).toBe(1)
    db.prepare(`UPDATE application_tasks SET status='waiting_for_review' WHERE id='stale'`).run()
    const third = await releaseParkedReviewsUnderFullAutomation(db, { logger: quiet, now: later + 25 * 60 * 60_000 })
    expect(third.released).toBe(0)
    expect(third.capped).toBe(1)
    expect(MAX_AUTO_RELEASES).toBe(2)
    const events = db.prepare(`SELECT step FROM application_task_events WHERE task_id='stale' AND step='auto_release_full_automation'`).all()
    expect(events).toHaveLength(2)
  })

  it('re-queues a TERMINAL failed task only when its recorded failure is transient (the pre-existing backlog)', async () => {
    await grantFullAutomation('p1')
    await seedTask(db, 'unreach', 'failed', { message: 'Hamilton Autopilot failed: Hamilton could not reach www.tn.gov — the site may be down or the saved portal link may be outdated.' })
    await seedTask(db, 'race', 'failed', { message: 'Hamilton Autopilot failed: page.$$eval: Execution context was destroyed, most likely because of a navigation' })
    await seedTask(db, 'click', 'failed', { message: 'Hamilton Autopilot failed: Submit button could not be clicked' })
    await seedTask(db, 'hard', 'failed', { message: 'Hamilton Autopilot failed: TypeError: cannot read properties of undefined' })
    const out = await releaseParkedReviewsUnderFullAutomation(db, { logger: quiet })
    expect(out.released).toBe(3)
    expect(out.released_ids.sort()).toEqual(['click', 'race', 'unreach'])
    expect(out.kept_by_category.hard_failure).toBe(1)
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='unreach'`).get().status).toBe('ready_to_start')
    expect(db.prepare(`SELECT status FROM application_tasks WHERE id='hard'`).get().status).toBe('failed')
  })
})
