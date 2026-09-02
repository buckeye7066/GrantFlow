import express from 'express'
import crypto from 'crypto'
import {
  addMessage,
  createSession,
  deleteSession,
  generateAssistantResponse,
  getMessages,
  getSession,
  listSessions,
  listTools,
  invokeTool,
  listTasks,
  createTask,
  updateTask,
  listProfileTasks,
} from '../services/anyaOrchestrator.js'
import { createAnyaRun, appendAnyaRunLog, completeAnyaRun, getAnyaRun, requestAnyaRunCancel } from '../services/anyaRuns.js'
import { resolveInternalSelfBaseUrl } from '../utils/internalSelfBaseUrl.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:anya')

const router = express.Router()

const resolveAdminToken = () => process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

// Hard ceiling on how long Anya may take to produce a reply for the interactive
// chat. The frontend API client (src/api/client.js) aborts any request at 60s and
// the Railway/Vercel gateway can cut it even sooner — an unbounded reply (OpenAI
// 30s × retries + tool-call loops + Anthropic fallback) blew past that, surfacing
// as a 504 and a "dead" Anya button. Bounding the work *under* the client window
// guarantees the endpoint always returns: a real answer if the model is quick, or
// the graceful degraded fallback below if it is not. Tunable via env.
const ASSISTANT_REPLY_TIMEOUT_MS = Number(process.env.ANYA_REPLY_TIMEOUT_MS || 45_000)

function withReplyTimeout(promise, ms) {
  let timeoutId = null
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const err = new Error(`Assistant reply timed out after ${ms}ms`)
      err.code = 'ASSISTANT_TIMEOUT'
      reject(err)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

// Cache for the ?test=true status check result (5-minute TTL)
let _statusTestCache = null
let _statusTestCacheExpiry = 0
const STATUS_TEST_CACHE_TTL_MS = 5 * 60 * 1000

function getInternalBaseUrl() {
  const resolved = resolveInternalSelfBaseUrl()
  if (!resolved.ok) {
    routeLogger.warn('[anya] internal self URL unavailable', { reason: resolved.reason })
    return null
  }
  return resolved.baseUrl
}

/**
 * Admin authentication middleware for Anya routes.
 * Uses req.ctx.isAdmin (DB-backed) as the canonical source of truth.
 * Token-claim fallbacks (req.user.role/is_admin) are deliberately NOT
 * honored — a JWT claiming admin for a user whose DB row says otherwise
 * must not pass. Explicit admin-token headers remain for autonomous ops.
 */
function adminAuth(req, res, next) {
  // Priority 1: Use req.ctx if available (preferred, DB-backed)
  if (req.ctx && req.ctx.isAdmin === true) {
    return next()
  }

  // Priority 2: Check admin token headers (for autonomous operations)
  const configuredToken = resolveAdminToken()
  if (!configuredToken) {
    return res.status(401).json({ error: 'Admin token not configured' })
  }
  
  const headerToken =
    req.headers.authorization?.replace('Bearer ', '') ||
    req.headers['x-admin-token'] ||
    req.headers['x-anya-token']
  
  if (!headerToken) {
    return res.status(401).json({ error: 'Missing admin credentials' })
  }
  
  // Use timing-safe comparison to prevent timing attacks on the admin token
  const a = Buffer.from(String(headerToken))
  const b = Buffer.from(String(configuredToken))
  const tokenMatch = a.length === b.length && crypto.timingSafeEqual(a, b)
  if (!tokenMatch) {
    return res.status(403).json({ error: 'Invalid admin credentials' })
  }
  
  return next()
}

function handleError(res, error) {
  const status = error?.status || 500
  return res.status(status).json({ ok: false, error: error.message || 'Unexpected error' })
}

// Public Anya health probe — used by endpointHealth + external uptime checks.
// Returns counters so a single GET is enough to see whether Anya is grounded.
router.get('/health', async (req, res) => {
  const db = req.db
  async function safeCount(sql, params = []) {
    try {
      const row = await db.prepare(sql).get(...params)
      if (!row) return 0
      const v = row.count ?? row.c ?? row.n ?? Object.values(row)[0]
      return Number(v) || 0
    } catch {
      return 0
    }
  }
  const now = new Date()
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const [brain_memories, tool_usage_24h, sessions_24h] = await Promise.all([
    safeCount('SELECT COUNT(*) AS count FROM anya_brain_memory'),
    safeCount('SELECT COUNT(*) AS count FROM anya_tool_usage WHERE created_at >= ?', [dayAgo]),
    safeCount("SELECT COUNT(*) AS count FROM anya_sessions WHERE created_at >= ?", [dayAgo]),
  ])

  // Registry metadata is process-owned, not database-owned. The old health
  // probe queried a never-populated snapshot table and falsely reported zero
  // even while the in-memory registry served tools to authenticated sessions.
  let tool_registry = 0
  try {
    tool_registry = listTools({ userId: 'anya-health-probe', isAdmin: true }).length
  } catch {
    tool_registry = 0
  }

  res.json({
    ok: tool_registry > 0,
    service: 'anya',
    version: process.env.RAILWAY_DEPLOYMENT_ID || process.env.npm_package_version || 'dev',
    checked_at: now.toISOString(),
    brain_memories,
    tool_usage_24h,
    sessions_24h,
    tool_registry,
  })
})

router.get('/status', adminAuth, async (_req, res) => {
  const shouldTest = String(_req.query?.test || '').toLowerCase() === 'true'
  const isProd = process.env.NODE_ENV === 'production'

  // Never call external AI providers by default. Allow explicit opt-in via ?test=true.
  let anthropicStatus = process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing_key'
  let anthropicError = null
  let modelInfo = null

  if (shouldTest) {
    // Return cached result if still valid (avoids redundant API calls)
    if (_statusTestCache && Date.now() < _statusTestCacheExpiry) {
      return res.json(_statusTestCache)
    }

    if (isProd) {
      anthropicStatus = anthropicStatus === 'missing_key' ? 'missing_key' : 'not_tested'
      anthropicError = {
        message: 'Live provider tests are disabled in production. Remove ?test=true or test from a non-prod environment.',
      }
    } else if (!process.env.ANTHROPIC_API_KEY) {
      anthropicStatus = 'missing_key'
    } else {
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default
        const client = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
          timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
          maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
        })

        const testResponse = await client.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }],
        })

        if (testResponse?.content?.[0]?.text) {
          anthropicStatus = 'connected'
          modelInfo = {
            model: 'claude-haiku-4-5',
            test_response: testResponse.content[0].text,
          }
        } else {
          anthropicStatus = 'invalid_response'
        }
      } catch (error) {
        anthropicStatus = 'error'
        anthropicError = {
          type: error?.constructor?.name ?? 'Error',
          message: error?.message || String(error),
          status: error?.status ?? null,
          hint:
            error?.status === 401
              ? 'Invalid API key'
              : error?.status === 429
                ? 'Rate limited'
                : String(error?.message || '').includes('model')
                  ? 'Invalid model name'
                  : 'Unknown error',
        }
      }
    }
  }

  const responseBody = {
    status: 'ready',
    anthropic: {
      status: anthropicStatus,
      tested: shouldTest && !isProd,
      api_key_configured: Boolean(process.env.ANTHROPIC_API_KEY),
      error: anthropicError,
      model: modelInfo,
    },
    openai: {
      api_key_configured: Boolean(process.env.OPENAI_API_KEY),
    },
    environment: { node_env: process.env.NODE_ENV },
    last_action_at: null,
    active_sessions: null,
  }

  // Cache the test result to avoid redundant external API calls
  if (shouldTest && !isProd) {
    _statusTestCache = responseBody
    _statusTestCacheExpiry = Date.now() + STATUS_TEST_CACHE_TTL_MS
  }

  res.json(responseBody)
})

router.get('/sessions', async (req, res) => {
  try {
    const sessions = await listSessions(req.db, req.ctx, {
      limit: req.query.limit,
    })
    res.json({ sessions })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/sessions', async (req, res) => {
  try {
    const session = await createSession(req.db, req.ctx, {
      profileId: req.body?.profile_id,
      title: req.body?.title,
      metadata: req.body?.metadata,
    })
    res.status(201).json(session)
  } catch (error) {
    handleError(res, error)
  }
})

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const result = await deleteSession(req.db, req.ctx, req.params.sessionId)
    res.json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/sessions/:sessionId', async (req, res) => {
  try {
    const session = await getSession(req.db, req.ctx, req.params.sessionId)
    res.json(session)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const messages = await getMessages(req.db, req.ctx, req.params.sessionId, {
      limit: req.query.limit,
      direction: req.query.direction === 'latest' ? 'latest' : 'asc',
    })
    res.json({ messages })
  } catch (error) {
    handleError(res, error)
  }
})

// Generate Anya's reply, persist it as an assistant message, and close out the
// run. Shared by the synchronous and background message paths so both behave
// identically (same timeout, same degraded fallback, same run bookkeeping).
async function generateAndStoreReply(db, ctx, sessionId, runId, { content, currentPage, pageContext }, timeoutMs) {
  let assistantText
  let degraded = false
  // Collects UI-affecting tool results (chat.setAppearance) from the tool loop.
  // The last one is persisted on the assistant message so the chat panel — on
  // any device, sync or background — applies it from message history.
  const uiEffects = []
  try {
    assistantText = await withReplyTimeout(
      // runId lets the orchestrator publish a live step feed and honor the
      // user's Stop/Escape (cooperative cancel between tool steps).
      generateAssistantResponse(db, ctx, sessionId, { content, currentPage, pageContext, runId, uiEffects }),
      timeoutMs,
    )
  } catch (assistantError) {
    const timedOut = assistantError?.code === 'ASSISTANT_TIMEOUT'
    console.error('[anya] Unable to generate assistant reply:', assistantError)
    await appendAnyaRunLog(db, runId, 'error', timedOut ? 'assistant_timeout' : 'assistant_generation_failed', {
      message: assistantError?.message || String(assistantError),
    })
    // This is a fallback, NOT a genuine answer. Flag it so the UI can render
    // an error/retry affordance instead of presenting canned text as if Anya
    // actually responded (silent-failure / trust violation otherwise).
    degraded = true
    assistantText = timedOut
      ? "That took longer than I allow for a single reply, so I stopped before the page timed out. Ask me again — a shorter, more specific question usually comes back fast."
      : "I hit a snag while reaching the AI service. Try again in a moment or share more details so I can help manually."
    // A degraded fallback is NOT Anya's real reply — don't let a tool effect
    // collected mid-generation ride on it (the colors would change while the
    // message says "I hit a snag"; the user re-asks and gets the honest pair).
    uiEffects.length = 0
  }

  const lastAppearanceEffect = uiEffects.filter((e) => e?.tool === 'chat.setAppearance').pop() ?? null
  const assistantMessage = await addMessage(db, ctx, sessionId, {
    role: 'assistant',
    content: assistantText,
    ...(lastAppearanceEffect
      ? { toolName: 'chat.setAppearance', toolPayload: lastAppearanceEffect.payload }
      : {}),
  })

  await completeAnyaRun(db, runId, {
    status: 'completed',
    // assistant_message_id lets the client's background poller pull the exact
    // reply when the run finishes (panel may be closed by then).
    response: { assistantText, degraded, assistant_message_id: assistantMessage.id },
  })

  return { assistantMessage, degraded }
}

router.post('/sessions/:sessionId/messages', async (req, res) => {
  let runId = null
  let responded = false
  try {
    const content = req.body?.message ?? req.body?.content
    const mode = (req.body?.mode ?? 'copilot') || 'copilot'
    // background=true: return immediately and let Anya finish the reply out of
    // band. The interactive request never holds open long enough to hit the
    // client's 60s abort or the Vercel/Railway gateway timeout, so the old
    // "long reply → 504 → dead Anya" failure can't happen. The client polls the
    // run status (GET .../runs/:runId) and pings the user when it's ready.
    const background = req.body?.background === true || req.body?.background === 'true'
    // hidden=true → this content is Anya's PRIVATE script (an interview seed /
    // question queue the chat should not paint as a user bubble). SECURITY: the
    // message ROLE is never client-controlled — the row stays role 'user' (it
    // reaches the model as an ordinary user turn either way) and `hidden` only
    // stamps a tool_name marker the chat UI collapses. The full content remains
    // in the transcript for admin/audit review.
    const hidden = req.body?.hidden === true || req.body?.hidden === 'true'
    const currentPage = (typeof req.body?.current_page === 'string' && req.body.current_page.trim())
      ? req.body.current_page.trim()
      : null
    const pageContext = (req.body?.page_context && typeof req.body.page_context === 'object')
      ? req.body.page_context
      : null
    if (mode === 'admin_ops' && !req.ctx?.isAdmin) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Message content is required' })
    }

    runId = await createAnyaRun(req.db, {
      mode,
      // Keep `kind` within the table's CHECK constraint
      // ('assistant_message' | 'tool_invoke'); the background flag rides in the
      // request payload for observability rather than as a new kind value.
      kind: 'assistant_message',
      sessionId: req.params.sessionId,
      userId: req.ctx?.userId ?? null,
      profileId: req.ctx?.activeProfileId ?? null,
      request: { content, background, hidden },
    })

    const userMessage = await addMessage(req.db, req.ctx, req.params.sessionId, {
      role: 'user',
      content,
      toolName: hidden ? 'anya_private_seed' : null,
    })

    if (background) {
      // Acknowledge now; finish the reply afterwards.
      res.status(202).json({
        session_id: req.params.sessionId,
        messages: [userMessage],
        run_id: runId,
        pending: true,
      })
      responded = true

      // Generous ceiling — no client is blocking, so allow slow tool chains to
      // finish, but still bound it so a wedged provider call can't run forever.
      const bgTimeout = Number(process.env.ANYA_BG_REPLY_TIMEOUT_MS || 240_000)
      // Fire-and-forget. req.db is the app's long-lived shared handle (see
      // server.js), so it stays valid after the response is sent. Never let a
      // rejection escape as an unhandledRejection — mark the run failed instead.
      void generateAndStoreReply(
        req.db,
        req.ctx,
        req.params.sessionId,
        runId,
        { content, currentPage, pageContext },
        bgTimeout,
      ).catch(async (bgError) => {
        console.error('[anya] Background reply failed:', bgError)
        try {
          await completeAnyaRun(req.db, runId, { status: 'failed', error: bgError?.message || String(bgError) })
        } catch {
          // ignore — run bookkeeping is best-effort
        }
      })
      return
    }

    const { assistantMessage, degraded } = await generateAndStoreReply(
      req.db,
      req.ctx,
      req.params.sessionId,
      runId,
      { content, currentPage, pageContext },
      ASSISTANT_REPLY_TIMEOUT_MS,
    )

    res.status(201).json({
      session_id: req.params.sessionId,
      messages: [userMessage, assistantMessage],
      degraded,
    })
  } catch (error) {
    try {
      await completeAnyaRun(req.db, runId, { status: 'failed', error: error?.message || String(error) })
    } catch {
      // ignore
    }
    // If we already sent the 202 ack, the failure was handled in the background
    // .catch above; don't try to send a second response.
    if (!responded) handleError(res, error)
  }
})

// Poll a single run's status. The client uses this after a background send to
// learn when Anya's reply is ready (and to pull it), and to render the live
// step feed (run.progress). Owner-scoped.
router.get('/sessions/:sessionId/runs/:runId', async (req, res) => {
  try {
    const run = await getAnyaRun(req.db, req.params.runId, {
      userId: req.ctx?.userId ?? null,
      sessionId: req.params.sessionId,
    })
    if (!run) {
      return res.status(404).json({ error: 'Run not found' })
    }
    res.json({ run })
  } catch (error) {
    handleError(res, error)
  }
})

// Stop a running Anya turn (the chat panel's Stop button / Escape key).
// Cooperative: sets cancel_requested; the orchestrator halts before its next
// step, so completed work stays and nothing further changes. Owner-scoped.
router.post('/sessions/:sessionId/runs/:runId/cancel', async (req, res) => {
  try {
    const result = await requestAnyaRunCancel(req.db, req.params.runId, {
      userId: req.ctx?.userId ?? null,
      sessionId: req.params.sessionId,
    })
    if (!result.ok && result.reason === 'not_found') {
      return res.status(404).json({ error: 'Run not found' })
    }
    res.json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/sessions/:sessionId/tasks', async (req, res) => {
  try {
    const tasks = await listTasks(req.db, req.ctx, req.params.sessionId)
    res.json({ tasks })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/sessions/:sessionId/tasks', async (req, res) => {
  try {
    const task = await createTask(req.db, req.ctx, req.params.sessionId, {
      title: req.body?.title,
      notes: req.body?.notes,
      status: req.body?.status,
      priority: req.body?.priority,
      dueDate: req.body?.due_date ?? req.body?.dueDate,
      metadata: req.body?.metadata,
    })

    try {
      const summaryParts = [
        `Logged task: "${task.title}"`,
        task.due_date ? `due ${task.due_date}` : null,
        task.priority && task.priority !== 'normal' ? `priority ${task.priority}` : null,
      ].filter(Boolean)
      if (summaryParts.length > 0) {
        await addMessage(req.db, req.ctx, req.params.sessionId, {
          role: 'assistant',
          content: summaryParts.join(' · '),
        })
      }
    } catch (messageError) {
      console.warn('[anya] Failed to log task creation message', messageError)
    }

    res.status(201).json({ task })
  } catch (error) {
    handleError(res, error)
  }
})

router.patch('/sessions/:sessionId/tasks/:taskId', (req, res) => {
  Promise.resolve()
    .then(async () => {
      const task = await updateTask(req.db, req.ctx, req.params.sessionId, req.params.taskId, {
        title: req.body?.title,
        notes: req.body?.notes,
        status: req.body?.status,
        priority: req.body?.priority,
        dueDate: req.body?.due_date ?? req.body?.dueDate,
        metadata: req.body?.metadata,
      })
      res.json({ task })
    })
    .catch((error) => handleError(res, error))
})

// POST /api/anya/sessions/:sessionId/tasks/:taskId/execute
// Mark a task as executed and log the action
router.post('/sessions/:sessionId/tasks/:taskId/execute', async (req, res) => {
  try {
    const { markTaskExecuted } = await import('../services/anyaTaskExecutionHelper.js')
    
    const result = await markTaskExecuted({
      db: req.db,
      user: req.ctx,
      sessionId: req.params.sessionId,
      taskId: req.params.taskId,
      executionNotes: req.body?.notes || null,
      executionResult: req.body?.result || null,
    })
    
    res.json({ ok: true, ...result })
  } catch (error) {
    handleError(res, error)
  }
})

// GET /api/anya/tasks/executable
// List all tasks that can be executed (open or in_progress)
router.get('/tasks/executable', adminAuth, async (req, res) => {
  try {
    const { listExecutableTasks } = await import('../services/anyaTaskExecutionHelper.js')
    
    const profileId = req.query.profile_id || null
    // Validate and bound the limit parameter
    const rawLimit = parseInt(req.query.limit || '50', 10)
    const limit = Math.max(1, Math.min(rawLimit, 500)) // Clamp between 1 and 500
    
    const tasks = await listExecutableTasks(req.db, { profileId, limit })
    res.json({ ok: true, tasks, count: tasks.length })
  } catch (error) {
    handleError(res, error)
  }
})

// GET /api/anya/tasks/:taskId/execution-history
// Get execution history for a specific task
router.get('/tasks/:taskId/execution-history', async (req, res) => {
  try {
    if (!req.ctx?.userId && !req.ctx?.isAdmin) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    const { getTaskExecutionHistory } = await import('../services/anyaTaskExecutionHelper.js')
    const history = await getTaskExecutionHistory(req.db, req.params.taskId, req.ctx)
    if (history.error === 'forbidden') {
      return res.status(403).json({ error: 'Not authorized to view this task' })
    }
    res.json({ ok: true, ...history })
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/profiles/:profileId/tasks', async (req, res) => {
  try {
    const requestedProfileId = req.params.profileId?.toLowerCase()
    const resolvedProfileId =
      requestedProfileId === 'me' || requestedProfileId === 'current'
        ? req.ctx?.activeProfileId ?? null
        : req.params.profileId

    const status =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : 'active'

    const tasks = await listProfileTasks(req.db, req.ctx, resolvedProfileId, { status })
    res.json({ tasks })
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/tools', (req, res) => {
  try {
    const tools = listTools(req.ctx)
    res.json({ tools })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/tools/:toolName/invoke', async (req, res) => {
  let runId = null
  try {
    const sessionId = req.body?.session_id ?? req.body?.sessionId ?? null
    const mode = (req.body?.mode ?? 'copilot') || 'copilot'
    if (mode === 'admin_ops' && !req.ctx?.isAdmin) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }
    if (mode === 'code_advisor') {
      // Code advisor is strictly non-destructive: only allow code.* tools that return patch text.
      if (!String(req.params.toolName || '').startsWith('code.')) {
        return res.status(403).json({ error: 'Tool not allowed in code_advisor mode' })
      }
    }
    const params =
      (req.body && typeof req.body === 'object' && 'parameters' in req.body
        ? req.body.parameters
        : req.body) ?? {}

    runId = await createAnyaRun(req.db, {
      mode,
      kind: 'tool_invoke',
      sessionId,
      userId: req.ctx?.userId ?? null,
      profileId: req.ctx?.activeProfileId ?? null,
      toolName: req.params.toolName,
      request: { params },
    })

    const result = await invokeTool(req.db, req.ctx, req.params.toolName, params, {
      sessionId,
      internalBaseUrl: getInternalBaseUrl(),
    })

    await completeAnyaRun(req.db, runId, { status: 'completed', response: result })
    res.status(201).json({ result })
  } catch (error) {
    try {
      await completeAnyaRun(req.db, runId, { status: 'failed', error: error?.message || String(error) })
    } catch {
      // ignore
    }
    handleError(res, error)
  }
})

// ============================================================================
// Autonomous Operations Endpoints
//
// These endpoints predate Sam (GrantFlow's production-readiness agent). The
// canonical home for production-health work is now `/api/sam/*`. We keep
// these routes intact so existing admin UI / Anya tooling does not break,
// but we mark each response with a `Deprecation` header pointing at the
// matching Sam route. Internally they still delegate to the same Anya tool
// registry — Sam itself delegates to those tools too, so we are not
// duplicating work.
// ============================================================================

function attachSamDeprecationHeader(res, samPath) {
  // RFC 8594 deprecation header (informational; clients keep working).
  res.set('Deprecation', 'true')
  res.set('Link', `</api/sam/${samPath}>; rel="successor-version"`)
  res.set('X-Sam-Owns', 'production_readiness')
}

router.post('/autonomous/code', adminAuth, async (req, res) => {
  try {
    attachSamDeprecationHeader(res, 'run')
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.runAutonomous', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/code/background', adminAuth, async (req, res) => {
  try {
    attachSamDeprecationHeader(res, 'run')
    const { startBackgroundCodeCrawlAndRepair } = await import('../services/anyaAutonomousScheduler.js')
    const context = { db: req.db, user: req.ctx?.user ?? req.user }
    const result = startBackgroundCodeCrawlAndRepair(context)
    if (result.queued) {
      res.status(202).json(result)
    } else {
      res.status(200).json(result)
    }
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/crawlers', adminAuth, async (req, res) => {
  try {
    attachSamDeprecationHeader(res, 'run')
    // Fire-and-forget (mirrors /autonomous/code/background just above): this
    // drives the Crawler OS synchronously, one real profile at a time, which
    // routinely exceeds the platform's proxy timeout and 504s the button even
    // though the run succeeds server-side. Poll GET /autonomous/status
    // (background_crawler_run) for progress/result.
    const { startBackgroundCrawlerRun } = await import('../services/anyaAutonomousScheduler.js')
    const context = { db: req.db, user: req.ctx?.user ?? req.user }
    const result = startBackgroundCrawlerRun(req.body, context)
    res.status(result.queued ? 202 : 200).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/functions', adminAuth, async (req, res) => {
  try {
    attachSamDeprecationHeader(res, 'diagnose')
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.testFunctions', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/buttons', adminAuth, async (req, res) => {
  try {
    attachSamDeprecationHeader(res, 'diagnose')
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.testButtons', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/autonomous/status', adminAuth, async (req, res) => {
  try {
    attachSamDeprecationHeader(res, 'status')
    const operationType = req.query.type || 'all'
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.getStatus', { operationType }, {})
    res.json(result)
  } catch (error) {
    handleError(res, error)
  }
})

export default router
