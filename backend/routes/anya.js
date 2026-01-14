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

const router = express.Router()

const resolveAdminToken = () => process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

function adminAuth(req, res, next) {
  if (req.user?.role === 'admin') return next()
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
  if (headerToken !== configuredToken) {
    return res.status(403).json({ error: 'Invalid admin credentials' })
  }
  return next()
}

function handleError(res, error) {
  const status = error?.status || 500
  return res.status(status).json({ error: error.message || 'Unexpected error' })
}

router.get('/status', adminAuth, async (_req, res) => {
  // Test Anthropic connection
  let anthropicStatus = 'not_tested'
  let anthropicError = null
  let modelInfo = null
  
  console.log('[Anya Status] Checking Anthropic API key configuration...')
  console.log('[Anya Status] ANTHROPIC_API_KEY exists:', !!process.env.ANTHROPIC_API_KEY)
  console.log('[Anya Status] OPENAI_API_KEY exists:', !!process.env.OPENAI_API_KEY)
  
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      console.log('[Anya Status] ANTHROPIC_API_KEY is MISSING')
      anthropicStatus = 'missing_key'
    } else {
      console.log('[Anya Status] ANTHROPIC_API_KEY found, prefix:', apiKey.substring(0, 10))
      console.log('[Anya Status] Key starts with sk-ant-:', apiKey.startsWith('sk-ant-'))
      
      // Try to import and test Anthropic
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const client = new Anthropic({ apiKey })
      console.log('[Anya Status] Anthropic client created, testing API...')
      
      // Make a minimal test request
      const testResponse = await client.messages.create({
        model: 'claude-3-haiku-20240307', // Use cheapest model for testing
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Say "ok"' }],
      })
      
      console.log('[Anya Status] API test response received:', !!testResponse)
      
      if (testResponse?.content?.[0]?.text) {
        anthropicStatus = 'connected'
        modelInfo = {
          model: 'claude-3-haiku-20240307',
          test_response: testResponse.content[0].text,
        }
        console.log('[Anya Status] API test SUCCESSFUL:', testResponse.content[0].text)
      } else {
        anthropicStatus = 'invalid_response'
        console.log('[Anya Status] API test returned invalid response')
      }
    }
  } catch (error) {
    anthropicStatus = 'error'
    console.error('[Anya Status] API test FAILED:', error.constructor.name, error.message)
    console.error('[Anya Status] Error status:', error.status)
    anthropicError = {
      type: error.constructor.name,
      message: error.message,
      status: error.status,
      hint: error.status === 401 ? 'Invalid API key' : 
            error.status === 429 ? 'Rate limited' : 
            error.message?.includes('model') ? 'Invalid model name' : 
            'Unknown error'
    }
  }
  
  res.json({
    status: 'ready',
    anthropic: {
      status: anthropicStatus,
      api_key_configured: !!process.env.ANTHROPIC_API_KEY,
      api_key_prefix: process.env.ANTHROPIC_API_KEY ? 
        process.env.ANTHROPIC_API_KEY.substring(0, 10) + '...' : null,
      error: anthropicError,
      model: modelInfo,
    },
    openai: {
      api_key_configured: !!process.env.OPENAI_API_KEY,
      api_key_prefix: process.env.OPENAI_API_KEY ? 
        process.env.OPENAI_API_KEY.substring(0, 7) + '...' : null,
    },
    environment: {
      node_env: process.env.NODE_ENV,
      all_env_keys: Object.keys(process.env).filter(k => 
        k.includes('API') || k.includes('ANTHROPIC') || k.includes('OPENAI')
      ),
    },
    last_action_at: null,
    active_sessions: null,
  })
})

router.get('/sessions', async (req, res) => {
  try {
    const sessions = await listSessions(req.db, req.user, {
      limit: req.query.limit,
    })
    res.json({ sessions })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/sessions', async (req, res) => {
  try {
    const session = await createSession(req.db, req.user, {
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
    const session = await getSession(req.db, req.user, req.params.sessionId)
    res.json(session)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/sessions/:sessionId/messages', (req, res) => {
  try {
    const messages = getMessages(req.db, req.user, req.params.sessionId, {
      limit: req.query.limit,
      direction: req.query.direction === 'latest' ? 'latest' : 'asc',
    })
    res.json({ messages })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const content = req.body?.message ?? req.body?.content
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Message content is required' })
    }

    const userMessage = addMessage(req.db, req.user, req.params.sessionId, {
      role: 'user',
      content,
    })

    let assistantText
    try {
      assistantText = await generateAssistantResponse(req.db, req.user, req.params.sessionId, {
        content,
      })
    } catch (assistantError) {
      console.error('[anya] Unable to generate assistant reply:', assistantError)
      assistantText =
        "I hit a snag while reaching the AI service. Try again in a moment or share more details so I can help manually."
    }

    const assistantMessage = addMessage(req.db, req.user, req.params.sessionId, {
      role: 'assistant',
      content: assistantText,
    })

    res.status(201).json({
      session_id: req.params.sessionId,
      messages: [userMessage, assistantMessage],
    })
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/sessions/:sessionId/tasks', (req, res) => {
  try {
    const tasks = listTasks(req.db, req.user, req.params.sessionId)
    res.json({ tasks })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/sessions/:sessionId/tasks', (req, res) => {
  try {
    const task = createTask(req.db, req.user, req.params.sessionId, {
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
        addMessage(req.db, req.user, req.params.sessionId, {
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
  try {
    const task = updateTask(req.db, req.user, req.params.sessionId, req.params.taskId, {
      title: req.body?.title,
      notes: req.body?.notes,
      status: req.body?.status,
      priority: req.body?.priority,
      dueDate: req.body?.due_date ?? req.body?.dueDate,
      metadata: req.body?.metadata,
    })

    res.json({ task })
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/profiles/:profileId/tasks', (req, res) => {
  try {
    const requestedProfileId = req.params.profileId?.toLowerCase()
    const resolvedProfileId =
      requestedProfileId === 'me' || requestedProfileId === 'current'
        ? req.user?.profileId ?? null
        : req.params.profileId

    const status =
      typeof req.query.status === 'string' && req.query.status.trim()
        ? req.query.status.trim()
        : 'active'

    const tasks = listProfileTasks(req.db, req.user, resolvedProfileId, { status })
    res.json({ tasks })
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/tools', (req, res) => {
  try {
    const tools = listTools(req.user)
    res.json({ tools })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/tools/:toolName/invoke', async (req, res) => {
  try {
    const sessionId = req.body?.session_id ?? req.body?.sessionId ?? null
    const params =
      (req.body && typeof req.body === 'object' && 'parameters' in req.body
        ? req.body.parameters
        : req.body) ?? {}

    const result = await invokeTool(req.db, req.user, req.params.toolName, params, {
      sessionId,
    })

    res.status(201).json({ result })
  } catch (error) {
    handleError(res, error)
  }
})

// ============================================================================
// Autonomous Operations Endpoints
// ============================================================================

router.post('/autonomous/code', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.user, 'admin.anya.runAutonomous', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/crawlers', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.user, 'admin.anya.runCrawlers', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/functions', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.user, 'admin.anya.testFunctions', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/autonomous/buttons', adminAuth, async (req, res) => {
  try {
    const result = await invokeTool(req.db, req.user, 'admin.anya.testButtons', req.body, {})
    res.status(201).json(result)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/autonomous/status', adminAuth, async (req, res) => {
  try {
    const operationType = req.query.type || 'all'
    const result = await invokeTool(req.db, req.user, 'admin.anya.getStatus', { operationType }, {})
    res.json(result)
  } catch (error) {
    handleError(res, error)
  }
})

export default router
