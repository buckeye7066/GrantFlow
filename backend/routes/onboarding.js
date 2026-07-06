/**
 * onboarding.js
 *
 * Public conversational onboarding endpoints driven by `anyaInterviewEngine`.
 * The flow is intentionally usable WITHOUT a logged-in user — anyone landing
 * on /start can complete the interview, hand over an email, and finally have
 * a real profile + email-OTP credential created for them in one step.
 *
 * Routes:
 *   POST   /api/onboarding/start           → create session, return first question
 *   POST   /api/onboarding/answer          → submit answer, return next question
 *   GET    /api/onboarding/sessions/:id    → resume an existing session
 *   POST   /api/onboarding/complete        → finalise profile + send sign-in code
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
// Creates (or reuses) a user + credential for the email captured during the
// interview, creates a profile, populates every section the engine collected,
// and triggers an email-OTP code so the user can sign in immediately.
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
    const ensureEmailCredential = authHelpers.ensureEmailCredential
      ?? authHelpers.default?.ensureEmailCredential
    const sendVerificationEmail = authHelpers.sendVerificationEmail
      ?? authHelpers.default?.sendVerificationEmail
    const generateSixDigitCode = authHelpers.generateSixDigitCode
      ?? authHelpers.default?.generateSixDigitCode
    const hashValue = authHelpers.hashValue
      ?? authHelpers.default?.hashValue
    const signOtpToken = authHelpers.signOtpToken
      ?? authHelpers.default?.signOtpToken
    const insertVerificationCode = authHelpers.insertVerificationCode
      ?? authHelpers.default?.insertVerificationCode
    const EMAIL_CODE_TTL = authHelpers.EMAIL_CODE_TTL
      ?? authHelpers.default?.EMAIL_CODE_TTL
      ?? 600

    if (
      typeof ensureEmailCredential !== 'function' ||
      typeof generateSixDigitCode !== 'function' ||
      typeof hashValue !== 'function' ||
      typeof signOtpToken !== 'function' ||
      typeof insertVerificationCode !== 'function'
    ) {
      qualityLog.error('[onboarding/complete] auth helpers missing exports')
      return res.status(500).json({ error: 'Auth subsystem unavailable.' })
    }

    // -------------------------------------------------------------------
    // 1) Ensure a user + email_otp credential exist.
    // -------------------------------------------------------------------
    const { user, credential } = await ensureEmailCredential(req.db, email)

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
      // Update existing profile with anything new the interview learned.
      // Note: `assignProfileToUser` (called by `ensureEmailCredential`) creates
      // a fallback profile with `created_by = NULL` for brand-new users — we
      // overwrite it here so audits can see this profile came from the Anya
      // conversational onboarding funnel.
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
    // 5) Generate + persist an email OTP code, mirror the path used by
    //    /api/auth/email/start so the existing /api/auth/email/verify
    //    flow accepts it. Also send the code (best-effort).
    // -------------------------------------------------------------------
    const code = generateSixDigitCode()
    const codeHash = hashValue(`${email}:${code}`)
    const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL * 1000).toISOString()
    const verificationToken = signOtpToken({
      kind: 'email',
      identifier: email,
      codeHash,
      ttlSeconds: EMAIL_CODE_TTL,
    })

    try {
      await insertVerificationCode(req.db, credential.id, codeHash, expiresAt)
      await req.db
        .prepare(
          `UPDATE user_credentials
              SET secret_hash = ?,
                  last_sent_at = ?,
                  attempt_count = 0
            WHERE id = ?`,
        )
        .run(codeHash, nowISO(), credential.id)
    } catch (codeErr) {
      console.warn('[onboarding/complete] could not persist OTP:', codeErr?.message ?? codeErr)
    }

    let emailSent = false
    if (typeof sendVerificationEmail === 'function') {
      try {
        const emailPromise = sendVerificationEmail(email, code)
        const timeoutPromise = new Promise((resolve) => {
          setTimeout(
            () => resolve(false),
            Number(process.env.AUTH_EMAIL_SEND_TIMEOUT_MS || 15000),
          )
        })
        emailSent = (await Promise.race([emailPromise, timeoutPromise])) === true
      } catch (sendErr) {
        emailSent = false
        console.warn('[onboarding/complete] email send failed:', sendErr?.message ?? sendErr)
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
    // 7) Respond with everything the frontend needs to ask for the OTP
    //    and complete sign-in via /api/auth/email/verify.
    // -------------------------------------------------------------------
    const response = {
      session_id: sessionId,
      status: 'completed',
      profile_id: profileId,
      user_id: user.id,
      email,
      email_sent: emailSent,
      verification_token: verificationToken,
      message: emailSent
        ? "Sent a 6-digit sign-in code to your email."
        : "We generated a sign-in code. If your inbox is slow, check spam.",
    }
    if (process.env.NODE_ENV !== 'production') {
      response.preview_code = code
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


export default router
