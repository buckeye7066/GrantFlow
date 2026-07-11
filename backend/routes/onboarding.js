/**
 * onboarding.js
 *
 * Public conversational onboarding endpoints driven by `anyaInterviewEngine`.
 * The flow is intentionally usable WITHOUT a logged-in user — anyone landing
 * on /start can complete the interview, hand over an email, and finally have
 * a real profile + user account created for them in one step (sign-in is
 * finished via an emailed /set-password link — the same flow as login).
 *
 * Routes:
 *   POST   /api/onboarding/start           → create session, return first question
 *   POST   /api/onboarding/answer          → submit answer, return next question
 *   GET    /api/onboarding/sessions/:id    → resume an existing session
 *   POST   /api/onboarding/complete        → finalise profile + email set-password link
 *
 * Mission alignment:
 *   - Goal 3 / 5: every answer is mapped to canonical profile shapes so
 *     crawlers and the matching engine can use them immediately.
 *   - Goal 7: a single explainable funnel replaces the four overlapping
 *     onboarding modals (OnboardingFlow, FirstRunOnboardingGate,
 *     ProfileCreationWizard, AnyaChat onboarding chips).
 *   - Goal 9: every session is persisted in `onboarding_sessions` so the
 *     experience is auditable and resumable.
 */
import { Router } from 'express'
import crypto from 'node:crypto'

import {
  applyAnswer,
  COMPLETION_TOKEN,
  FIRST_QUESTION_ID,
  getFirstQuestion,
  getQuestion,
  INTERVIEW_VERSION,
  makeInitialState,
  serializeQuestion,
} from '../services/anyaInterviewEngine.js'
import { canonicalizeProfileTypeId } from '../../shared/profileTypeOptions.js'
import { resolveZipLocation } from '../services/geo/zipCountyResolver.js'
import { upsertProfileSections } from '../services/profileSectionWriter.js'
import { ensureAuth } from '../middleware/auth.js'
import { isProductionEnvironment } from '../utils/environment.js'
import { createLogger } from '../utils/logger.js'
const qualityLog = createLogger('routes:onboarding')

const router = Router()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function nowISO() {
  return new Date().toISOString()
}

function hashIp(ip) {
  if (!ip) return null
  try {
    return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32)
  } catch {
    return null
  }
}

async function loadSession(db, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null
  const row = await db
    .prepare(
      `SELECT id, status, current_question, answers, profile_patch, email,
              user_id, profile_id, created_at, updated_at, completed_at
         FROM onboarding_sessions
         WHERE id = ?
         LIMIT 1`,
    )
    .get(sessionId)
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    currentQuestion: row.current_question,
    state: {
      version: INTERVIEW_VERSION,
      answers: parseJson(row.answers, {}),
      patch: parseJson(row.profile_patch, makeInitialState().patch),
    },
    email: row.email ?? null,
    userId: row.user_id ?? null,
    profileId: row.profile_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(String(value))
  } catch {
    return fallback
  }
}

async function persistSession(db, session) {
  await db
    .prepare(
      `UPDATE onboarding_sessions
          SET status           = ?,
              current_question = ?,
              answers          = ?,
              profile_patch    = ?,
              email            = ?,
              user_id          = ?,
              profile_id       = ?,
              updated_at       = ?
        WHERE id = ?`,
    )
    .run(
      session.status,
      session.currentQuestion ?? null,
      JSON.stringify(session.state.answers ?? {}),
      JSON.stringify(session.state.patch ?? {}),
      session.email ?? null,
      session.userId ?? null,
      session.profileId ?? null,
      nowISO(),
      session.id,
    )
}

function formatResponse(session, question, extras = {}) {
  return {
    session_id: session.id,
    status: session.status,
    question: question ? serializeQuestion(question) : null,
    state: {
      primary_type: session.state.patch.primary_type,
      tags: session.state.patch.tags,
      display_name: session.state.patch.display_name,
      email: session.state.patch.email,
    },
    ...extras,
  }
}

// ---------------------------------------------------------------------------
// POST /api/onboarding/start
// ---------------------------------------------------------------------------
router.post('/start', async (req, res) => {
  try {
    const initialState = makeInitialState()
    const sessionId = crypto.randomUUID()

    await req.db
      .prepare(
        `INSERT INTO onboarding_sessions (
            id, status, current_question, answers, profile_patch,
            user_agent, ip_hash, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        'in_progress',
        FIRST_QUESTION_ID,
        JSON.stringify(initialState.answers),
        JSON.stringify(initialState.patch),
        req.get('user-agent') ?? null,
        hashIp(req.ip),
        nowISO(),
        nowISO(),
      )

    const question = getFirstQuestion()
    return res.status(201).json(
      formatResponse(
        {
          id: sessionId,
          status: 'in_progress',
          state: initialState,
          email: null,
          userId: null,
          profileId: null,
        },
        question,
      ),
    )
  } catch (err) {
    qualityLog.error('[onboarding/start] failed:', err)
    return res.status(500).json({
      error: 'Could not start onboarding session.',
      detail: process.env.NODE_ENV === 'production' ? undefined : err?.message,
    })
  }
})

// ---------------------------------------------------------------------------
// GET /api/onboarding/zip/:zip  (public ZIP → city/state/county lookup)
//
// Powers the auto-fill on the location step: as soon as a visitor types a
// valid 5-digit ZIP the frontend pre-populates city + state for them. Uses
// the offline `zipcodes-nrviens` dataset so we never send the user's ZIP to
// a third-party geocoder. Unauthenticated by design — this runs before the
// user has any credential.
// ---------------------------------------------------------------------------
router.get('/zip/:zip', (req, res) => {
  const zip = String(req.params.zip || '').trim()
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'ZIP must be 5 digits.' })
  }
  const location = resolveZipLocation(zip)
  if (!location) {
    return res.status(404).json({ error: 'Unknown ZIP code.' })
  }
  return res.json(location)
})

// ---------------------------------------------------------------------------
// GET /api/onboarding/sessions/:id  (resume)
// ---------------------------------------------------------------------------
router.get('/sessions/:id', async (req, res) => {
  try {
    const session = await loadSession(req.db, req.params.id)
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    const question =
      session.currentQuestion === COMPLETION_TOKEN
        ? null
        : getQuestion(session.currentQuestion)
    return res.json(formatResponse(session, question))
  } catch (err) {
    qualityLog.error('[onboarding/sessions/:id] failed:', err)
    return res.status(500).json({ error: 'Could not load session.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/answer
// ---------------------------------------------------------------------------
router.post('/answer', async (req, res) => {
  const { session_id: sessionId, question_id: questionId, answer } = req.body ?? {}
  if (!sessionId) return res.status(400).json({ error: 'session_id is required.' })
  if (!questionId) return res.status(400).json({ error: 'question_id is required.' })

  try {
    const session = await loadSession(req.db, sessionId)
    if (!session) return res.status(404).json({ error: 'Session not found.' })
    if (session.status === 'completed') {
      return res.status(409).json({
        error: 'Session is already completed.',
        session_id: sessionId,
      })
    }

    // Allow re-answering the current question; reject jumping ahead.
    if (session.currentQuestion !== questionId) {
      return res.status(409).json({
        error: 'Question out of order.',
        expected_question_id: session.currentQuestion,
        received_question_id: questionId,
      })
    }

    let nextState
    let nextQuestionId
    try {
      const result = applyAnswer(session.state, questionId, answer)
      nextState = result.state
      nextQuestionId = result.nextQuestionId
    } catch (validationErr) {
      const status = validationErr.statusCode ?? 400
      return res.status(status).json({
        error: validationErr.message,
        code: validationErr.code ?? 'INVALID_ANSWER',
        question: serializeQuestion(getQuestion(questionId)),
      })
    }

    const isComplete = nextQuestionId === COMPLETION_TOKEN
    const updated = {
      ...session,
      state: nextState,
      currentQuestion: isComplete ? COMPLETION_TOKEN : nextQuestionId,
      email: nextState.patch.email ?? session.email ?? null,
    }
    await persistSession(req.db, updated)

    const nextQuestion = isComplete ? null : getQuestion(nextQuestionId)
    return res.json(
      formatResponse(updated, nextQuestion, {
        complete: isComplete,
      }),
    )
  } catch (err) {
    qualityLog.error('[onboarding/answer] failed:', err)
    return res.status(500).json({ error: 'Could not record answer.' })
  }
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/complete
//
// Creates (or reuses) a user for the email captured during the interview,
// creates a profile, populates every section the engine collected, and emails
// the SAME secure /set-password link the login page uses — signup and login
// share one sign-in flow (no 6-digit codes anywhere; see beginPasswordSetup
// in routes/auth.js).
// ---------------------------------------------------------------------------
router.post('/complete', async (req, res) => {
  const { session_id: sessionId } = req.body ?? {}
  if (!sessionId) return res.status(400).json({ error: 'session_id is required.' })

  try {
    const session = await loadSession(req.db, sessionId)
    if (!session) return res.status(404).json({ error: 'Session not found.' })

    if (session.currentQuestion !== COMPLETION_TOKEN && session.status !== 'completed') {
      return res.status(409).json({
        error: 'Interview is not finished yet.',
        next_question_id: session.currentQuestion,
      })
    }

    const email = String(session.state.patch.email ?? session.email ?? '').trim().toLowerCase()
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email is required to finish onboarding.' })
    }

    // -------------------------------------------------------------------
    // Late-bind auth helpers so route loading stays cheap when the auth
    // module pulls heavy crypto / smtp dependencies.
    // -------------------------------------------------------------------
    const authHelpers = await import('./auth.js')
    const ensurePasswordAuthSchema = authHelpers.ensurePasswordAuthSchema
      ?? authHelpers.default?.ensurePasswordAuthSchema
    const ensureUserForPasswordAuth = authHelpers.ensureUserForPasswordAuth
      ?? authHelpers.default?.ensureUserForPasswordAuth
    const beginPasswordSetup = authHelpers.beginPasswordSetup
      ?? authHelpers.default?.beginPasswordSetup

    if (
      typeof ensurePasswordAuthSchema !== 'function' ||
      typeof ensureUserForPasswordAuth !== 'function' ||
      typeof beginPasswordSetup !== 'function'
    ) {
      qualityLog.error('[onboarding/complete] auth helpers missing exports')
      return res.status(500).json({ error: 'Auth subsystem unavailable.' })
    }

    // -------------------------------------------------------------------
    // 1) Ensure a users row exists for this email (password flow — no
    //    email_otp credential is created anymore).
    // -------------------------------------------------------------------
    await ensurePasswordAuthSchema(req.db)
    const user = await ensureUserForPasswordAuth(req.db, email)
    if (!user) {
      qualityLog.error('[onboarding/complete] could not ensure user for', email)
      return res.status(500).json({ error: 'Could not finish onboarding.' })
    }

    // -------------------------------------------------------------------
    // 2) Create the profile (or reuse the user's existing profile when one
    //    already exists — they may have onboarded once before and clicked
    //    /start again).
    // -------------------------------------------------------------------
    const patch = session.state.patch ?? {}
    const displayName = String(patch.display_name ?? '').trim() ||
      (typeof user?.display_name === 'string' && user.display_name.trim()) ||
      (email.split('@')[0] ?? 'My Profile')
    const primaryType = canonicalizeProfileTypeId(patch.primary_type) || 'individual'
    const tags = Array.isArray(patch.tags) ? Array.from(new Set(patch.tags)) : []

    let existingProfile = null
    try {
      // The SQLite shim's .get() returns the row synchronously (not a Promise),
      // so we can't chain .catch() on it. Wrap in try/catch instead. The
      // Postgres adapter returns a Promise, hence the `await`.
      existingProfile = await req.db
        .prepare(
          `SELECT id FROM profiles
             WHERE user_id = ?
               AND COALESCE(status, 'active') NOT IN ('deleted', 'archived')
             ORDER BY created_at ASC NULLS LAST, id ASC
             LIMIT 1`,
        )
        .get(user.id)
    } catch {
      existingProfile = null
    }

    let profileId = existingProfile?.id ?? null

    if (!profileId) {
      profileId = crypto.randomUUID()
      await req.db.withTransaction(async (tx) => {
        await tx
          .prepare(
            `INSERT INTO profiles (
                id, display_name, primary_type, user_id, created_by, status, tags
              ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            profileId,
            displayName,
            primaryType,
            user.id,
            'anya-onboarding',
            'active',
            JSON.stringify(tags),
          )
      })
    } else {
      // Update existing profile with anything new the interview learned
      // (they may have onboarded before, or a profile was pre-created for
      // them by an admin). Stamp created_by so audits can see this profile
      // was shaped by the Anya conversational onboarding funnel.
      await req.db
        .prepare(
          `UPDATE profiles
              SET display_name = COALESCE(NULLIF(?, ''), display_name),
                  primary_type = COALESCE(?, primary_type),
                  tags         = ?,
                  created_by   = COALESCE(NULLIF(created_by, ''), ?)
            WHERE id = ?`,
        )
        .run(
          displayName,
          primaryType,
          JSON.stringify(tags),
          'anya-onboarding',
          profileId,
        )
    }

    // -------------------------------------------------------------------
    // 3) Persist every section the engine collected.
    //    Use INSERT … ON CONFLICT to be safe against the canonical seed
    //    rows the profile-create flow already wrote.
    // -------------------------------------------------------------------
    const sections = patch.sections ?? {}
    await upsertProfileSections(req.db, profileId, sections, 'anya-onboarding')

    // -------------------------------------------------------------------
    // 4) Mark the user as having completed onboarding so the legacy gates
    //    we removed do not re-trigger anywhere.
    // -------------------------------------------------------------------
    try {
      await req.db
        .prepare(
          `UPDATE users
              SET has_completed_onboarding = 1,
                  onboarding_completed_at = ?,
                  guided_cycle_tour_status = 'pending'
            WHERE id = ?`,
        )
        .run(nowISO(), user.id)
    } catch {
      // Older schemas may not have these columns — onboarding still works.
    }

    // -------------------------------------------------------------------
    // 5) Email the secure /set-password link — the exact same flow the
    //    login page uses (beginPasswordSetup in routes/auth.js), so signup
    //    never shows a code. A returning user who already set a password
    //    just signs in normally.
    // -------------------------------------------------------------------
    const hasPassword = typeof user.password_hash === 'string' && user.password_hash.trim().length > 0
    let setup = null
    if (!hasPassword) {
      try {
        setup = await beginPasswordSetup(req.db, { user, email, req })
      } catch (setupErr) {
        qualityLog.error('[onboarding/complete] could not create password setup link:', setupErr?.message ?? setupErr)
        return res.status(500).json({
          error: 'Could not finish onboarding.',
          detail: process.env.NODE_ENV === 'production' ? undefined : (setupErr?.message ?? String(setupErr)),
        })
      }
    }

    // -------------------------------------------------------------------
    // 6) Mark session as completed and link to the user/profile.
    // -------------------------------------------------------------------
    await req.db
      .prepare(
        `UPDATE onboarding_sessions
            SET status = 'completed',
                user_id = ?,
                profile_id = ?,
                email = ?,
                completed_at = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(user.id, profileId, email, nowISO(), nowISO(), sessionId)

    // -------------------------------------------------------------------
    // 7) Respond with everything the frontend needs to finish sign-in via
    //    the emailed /set-password link (or a normal login for returning
    //    users who already have a password).
    // -------------------------------------------------------------------
    const emailSent = setup ? setup.emailSent === true : false
    const response = {
      session_id: sessionId,
      status: 'completed',
      profile_id: profileId,
      user_id: user.id,
      email,
      signin_flow: hasPassword ? 'password_exists' : 'password_setup_email_sent',
      email_sent: emailSent,
      message: hasPassword
        ? 'You already have a password — sign in with your email and password.'
        : emailSent
          ? 'Check your email for a secure link to set your password and sign in.'
          : 'We created your sign-in link. If your inbox is slow, check spam — or request a new link from the sign-in page.',
    }
    // Dev/test convenience mirroring /password/setup/start: surface the link
    // when email delivery isn't available. NEVER in production.
    if (setup && !isProductionEnvironment()) {
      response.preview_token = setup.token
      response.preview_url = setup.link
    }
    return res.status(201).json(response)
  } catch (err) {
    qualityLog.error('[onboarding/complete] failed:', err)
    return res.status(500).json({
      error: 'Could not finish onboarding.',
      detail: process.env.NODE_ENV === 'production' ? undefined : err?.message,
    })
  }
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/welcome-video/consume  (auth required)
//
// The per-call gate that retires a one-time forced welcome video: stamps
// consumed_at + consumed_by_user_id on the forced_welcome_videos row by id.
// Monotonic + idempotent — an already-consumed row (or a re-POST) returns
// 200 { ok: true }. Once consumed, resolveForcedWelcomeVideo stops matching it,
// so the frontend sequencer falls through to the normal onboarding branches and
// the video never replays. There is no boot net: "consumed stays consumed" is
// the whole invariant, and consume only ever moves in one direction.
// ---------------------------------------------------------------------------
router.post('/welcome-video/consume', ensureAuth, async (req, res) => {
  const id = req.body?.id
  const userId = req.user?.userId ?? req.user?.id ?? null
  if (!id || typeof id !== 'string') {
    return res.status(400).json({ error: 'id is required.' })
  }

  try {
    const row = await req.db
      .prepare('SELECT id, consumed_at FROM forced_welcome_videos WHERE id = ?')
      .get(id)
    if (!row) {
      return res.status(404).json({ error: 'Forced welcome video not found.' })
    }
    if (row.consumed_at) {
      // Idempotent: already retired.
      return res.json({ ok: true, already_consumed: true })
    }
    await req.db
      .prepare(
        `UPDATE forced_welcome_videos
            SET consumed_at = ?, consumed_by_user_id = ?
          WHERE id = ? AND consumed_at IS NULL`,
      )
      .run(nowISO(), userId, id)
    return res.json({ ok: true })
  } catch (err) {
    qualityLog.error('[onboarding/welcome-video/consume] failed:', err)
    return res.status(500).json({ error: 'Could not consume welcome video.' })
  }
})

export default router
