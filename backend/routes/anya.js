import express from 'express'
import {
  addMessage,
  createSession,
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
import { createAnyaRun, appendAnyaRunLog, completeAnyaRun } from '../services/anyaRuns.js'

const router = express.Router()

const resolveAdminToken = () => process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

function adminAuth(req, res, next) {
  if (req.ctx?.isAdmin) return next()
  return res.status(403).json({ error: 'Admin privileges required' })
}

function handleError(res, error) {
  const status = error?.status || 500
  return res.status(status).json({ error: error.message || 'Unexpected error' })
}

router.get('/status', adminAuth, async (_req, res) => {
  const shouldTest = String(_req.query?.test || '').toLowerCase() === 'true'
  const isProd = process.env.NODE_ENV === 'production'

  // Never call external AI providers by default. Allow explicit opt-in via ?test=true.
  let anthropicStatus = process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing_key'
  let anthropicError = null
  let modelInfo = null

  if (shouldTest) {
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
          model: 'claude-3-haiku-20240307',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say "ok"' }],
        })

        if (testResponse?.content?.[0]?.text) {
          anthropicStatus = 'connected'
          modelInfo = {
            model: 'claude-3-haiku-20240307',
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

  res.json({
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
  })
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

router.post('/sessions/:sessionId/messages', async (req, res) => {
  let runId = null
  try {
    const content = req.body?.message ?? req.body?.content
    const mode = (req.body?.mode ?? 'copilot') || 'copilot'
    if (mode === 'admin_ops' && !req.ctx?.isAdmin) {
      return res.status(403).json({ error: 'Admin privileges required' })
    }
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Message content is required' })
    }

    runId = await createAnyaRun(req.db, {
      mode,
      kind: 'assistant_message',
      sessionId: req.params.sessionId,
      userId: req.ctx?.userId ?? null,
      profileId: req.ctx?.activeProfileId ?? null,
      request: { content },
    })

    const userMessage = await addMessage(req.db, req.ctx, req.params.sessionId, {
      role: 'user',
      content,
    })

    let assistantText
    try {
      assistantText = await generateAssistantResponse(req.db, req.ctx, req.params.sessionId, {
        content,
      })
    } catch (assistantError) {
      console.error('[anya] Unable to generate assistant reply:', assistantError)
      await appendAnyaRunLog(req.db, runId, 'error', 'assistant_generation_failed', {
        message: assistantError?.message || String(assistantError),
      })
      assistantText =
        "I hit a snag while reaching the AI service. Try again in a moment or share more details so I can help manually."
    }

    const assistantMessage = await addMessage(req.db, req.ctx, req.params.sessionId, {
      role: 'assistant',
      content: assistantText,
    })

    await completeAnyaRun(req.db, runId, { status: 'completed', response: { assistantText } })

    res.status(201).json({
      session_id: req.params.sessionId,
      messages: [userMessage, assistantMessage],
    })
  } catch (error) {
    try {
      await completeAnyaRun(req.db, runId, { status: 'failed', error: error?.message || String(error) })
    } catch {
      // ignore
    }
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
// ============================================================================

router.post('/autonomous/code', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.runAutonomous', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/crawlers', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.runCrawlers', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/functions', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.testFunctions', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/buttons', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.testButtons', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/autonomous/status', adminAuth, async (req, res) => {
  try {
    const operationType = req.query.type || 'all'
    const result = await invokeTool(req.db, req.ctx, 'admin.anya.getStatus', { operationType }, {})
    res.json(result)
  } catch (error) {
    handleError(res, error)
  }
})

export default router
