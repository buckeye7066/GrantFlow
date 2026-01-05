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

router.get('/status', adminAuth, (_req, res) => {
  res.json({
    status: 'ready',
    last_action_at: null,
    active_sessions: null,
  })
})

router.get('/sessions', (req, res) => {
  try {
    const sessions = listSessions(req.db, req.user, {
      limit: req.query.limit,
    })
    res.json({ sessions })
  } catch (error) {
    handleError(res, error)
  }
})

router.post('/sessions', (req, res) => {
  try {
    const session = createSession(req.db, req.user, {
      profileId: req.body?.profile_id,
      title: req.body?.title,
      metadata: req.body?.metadata,
    })
    res.status(201).json(session)
  } catch (error) {
    handleError(res, error)
  }
})

router.get('/sessions/:sessionId', (req, res) => {
  try {
    const session = getSession(req.db, req.user, req.params.sessionId)
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

export default router
