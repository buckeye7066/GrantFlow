import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import { listToolMetadata, invokeTool as invokeRegisteredTool } from './anyaToolRegistry.js'

const TASK_STATUSES = new Set(['open', 'in_progress', 'completed', 'cancelled'])
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

// Admin configuration from environment
// Note: The fallback 'admin@grantflow.app' is a safe default that won't match real users
// In production, ADMIN_EMAIL should always be explicitly set to the actual admin email
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grantflow.app'

let cachedOpenAI = null

function getOpenAIClient() {
  if (cachedOpenAI) return cachedOpenAI
  
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    const error = new Error('OPENAI_API_KEY environment variable is not set')
    error.code = 'MISSING_API_KEY'
    throw error
  }
  
  try {
    cachedOpenAI = new OpenAI({ apiKey })
    return cachedOpenAI
  } catch (error) {
    console.error('[Anya] Failed to initialize OpenAI client:', error.message)
    throw error
  }
}

const DEFAULT_ASSISTANT_MODEL = process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini'

function coerceProfileId(requestedProfileId) {
  if (!requestedProfileId) return null
  return String(requestedProfileId).trim() || null
}

function assertAuthenticated(user) {
  if (!user || user.role === 'guest') {
    const error = new Error('Authentication required')
    error.status = 401
    throw error
  }
}

function assertProfileAccess(user, profileId) {
  if (!profileId) return
  if (user.role === 'admin') return
  if (user.profileId && user.profileId === profileId) return
  const error = new Error('Not authorized to access this profile')
  error.status = 403
  throw error
}

function assertSessionAccess(user, session) {
  if (!session) {
    const error = new Error('Session not found')
    error.status = 404
    throw error
  }
  if (user.role === 'admin') return
  if (session.user_id && user.userId && session.user_id === user.userId) return
  if (session.profile_id && user.profileId && session.profile_id === user.profileId) return
  const error = new Error('Not authorized to access this session')
  error.status = 403
  throw error
}

function mapSession(row) {
  if (!row) return null
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    title: row.title ?? null,
    profile_id: row.profile_id ?? null,
    user_id: row.user_id ?? null,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }
}

function mapMessage(row) {
  if (!row) return null
  return {
    id: row.id,
    session_id: row.session_id,
    created_at: row.created_at,
    role: row.role,
    content: row.content,
    tool_name: row.tool_name ?? null,
    tool_payload: row.tool_payload ? JSON.parse(row.tool_payload) : null,
  }
}

function mapTask(row) {
  if (!row) return null
  return {
    id: row.id,
    session_id: row.session_id,
    profile_id: row.profile_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by ?? null,
    title: row.title,
    notes: row.notes ?? null,
    status: row.status,
    priority: row.priority,
    due_date: row.due_date ?? null,
    completed_at: row.completed_at ?? null,
    metadata: row.metadata ? JSON.parse(row.metadata) : {},
  }
}

function normalizeTaskStatus(status) {
  if (!status) return null
  const normalized = String(status).trim().toLowerCase()
  if (!TASK_STATUSES.has(normalized)) {
    const error = new Error('Invalid task status')
    error.status = 400
    throw error
  }
  return normalized
}

function normalizeTaskPriority(priority) {
  if (!priority) return null
  const normalized = String(priority).trim().toLowerCase()
  if (!TASK_PRIORITIES.has(normalized)) {
    const error = new Error('Invalid task priority')
    error.status = 400
    throw error
  }
  return normalized
}

function normalizeDate(value) {
  if (value == null || value === '') return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed
    }
    const parsed = new Date(trimmed)
    if (Number.isNaN(parsed.getTime())) {
      const error = new Error('Invalid due date')
      error.status = 400
      throw error
    }
    return parsed.toISOString().slice(0, 10)
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  const error = new Error('Invalid due date')
  error.status = 400
  throw error
}

export function createSession(db, user, { profileId, title, metadata } = {}) {
  assertAuthenticated(user)
  const normalizedProfileId = coerceProfileId(profileId ?? user.profileId ?? null)
  assertProfileAccess(user, normalizedProfileId)

  const id = randomUUID()
  const info = db
    .prepare(
      `
        INSERT INTO anya_sessions (id, user_id, profile_id, status, title, metadata)
        VALUES (?, ?, ?, 'open', ?, ?)
      `,
    )
    .run(
      id,
      user.userId ?? null,
      normalizedProfileId,
      title?.trim() || null,
      metadata ? JSON.stringify(metadata) : '{}',
    )

  if (info.changes !== 1) {
    throw new Error('Unable to create session')
  }

  return getSession(db, user, id)
}

export function getSession(db, user, sessionId) {
  assertAuthenticated(user)
  const row = db
    .prepare(
      `
        SELECT *
        FROM anya_sessions
        WHERE id = ?
      `,
    )
    .get(sessionId)

  assertSessionAccess(user, row)
  return mapSession(row)
}

export function listSessions(db, user, { limit = 20 } = {}) {
  assertAuthenticated(user)
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100))

  let rows = []
  if (user.role === 'admin') {
    rows = db
      .prepare(
        `
          SELECT *
          FROM anya_sessions
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(safeLimit)
  } else if (user.userId) {
    rows = db
      .prepare(
        `
          SELECT *
          FROM anya_sessions
          WHERE user_id = ?
             OR (profile_id IS NOT NULL AND profile_id = ?)
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(user.userId, user.profileId ?? null, safeLimit)
  } else {
    rows = db
      .prepare(
        `
          SELECT *
          FROM anya_sessions
          WHERE profile_id = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(user.profileId ?? null, safeLimit)
  }

  return rows.map(mapSession)
}

export function addMessage(db, user, sessionId, { role, content, toolName, toolPayload } = {}) {
  assertAuthenticated(user)
  const session = getSession(db, user, sessionId)

  if (!content || typeof content !== 'string') {
    const error = new Error('Message content required')
    error.status = 400
    throw error
  }

  const messageId = randomUUID()
  const payload = toolPayload ? JSON.stringify(toolPayload) : null
  const stmt = db.prepare(
    `
      INSERT INTO anya_messages (id, session_id, role, content, tool_name, tool_payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
  )

  stmt.run(messageId, session.id, role, content, toolName ?? null, payload)

  db.prepare(
    `
      UPDATE anya_sessions
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(session.id)

  return getMessages(db, user, session.id, { limit: 1, direction: 'latest' })[0]
}

export function getMessages(db, user, sessionId, { limit = 50, direction = 'asc' } = {}) {
  assertAuthenticated(user)
  const session = getSession(db, user, sessionId)
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
  const order = direction === 'latest' ? 'DESC' : 'ASC'

  const rows = db
    .prepare(
      `
        SELECT *
        FROM anya_messages
        WHERE session_id = ?
        ORDER BY created_at ${order}, rowid ${order}
        LIMIT ?
      `,
    )
    .all(session.id, safeLimit)

  const mapped = rows.map(mapMessage)
  return direction === 'latest' ? mapped : mapped
}

export function listTasks(db, user, sessionId) {
  assertAuthenticated(user)
  const session = getSession(db, user, sessionId)

  const rows = db
    .prepare(
      `
        SELECT *
        FROM anya_tasks
        WHERE session_id = ?
        ORDER BY created_at ASC, rowid ASC
      `,
    )
    .all(session.id)

  return rows.map(mapTask)
}

export function listProfileTasks(db, user, profileId, { status } = {}) {
  assertAuthenticated(user)
  const normalizedProfileId = coerceProfileId(profileId ?? user.profileId ?? null)
  assertProfileAccess(user, normalizedProfileId)

  if (!normalizedProfileId) {
    const error = new Error('Profile id is required')
    error.status = 400
    throw error
  }

  let statusClause = ''
  const params = [normalizedProfileId]

  if (status !== undefined && status !== null && status !== '') {
    const normalized = String(status).trim().toLowerCase()
    let statuses = null
    if (normalized === 'active' || normalized === 'pending') {
      statuses = ['open', 'in_progress']
    } else if (normalized === 'all') {
      statuses = null
    } else if (TASK_STATUSES.has(normalized)) {
      statuses = [normalized]
    } else {
      const error = new Error('Invalid task status filter')
      error.status = 400
      throw error
    }

    if (Array.isArray(statuses) && statuses.length > 0) {
      statusClause = `AND status IN (${statuses.map(() => '?').join(', ')})`
      params.push(...statuses)
    }
  }

  const rows = db
    .prepare(
      `
        SELECT *
        FROM anya_tasks
        WHERE profile_id = ?
          ${statusClause}
        ORDER BY
          CASE status
            WHEN 'open' THEN 0
            WHEN 'in_progress' THEN 1
            WHEN 'completed' THEN 2
            WHEN 'cancelled' THEN 3
            ELSE 4
          END,
          COALESCE(due_date, '9999-12-31') ASC,
          created_at ASC
      `,
    )
    .all(...params)

  return rows.map(mapTask)
}

export function createTask(
  db,
  user,
  sessionId,
  { title, notes = null, status = 'open', priority = 'normal', dueDate = null, metadata = null } = {},
) {
  assertAuthenticated(user)
  const session = getSession(db, user, sessionId)

  const normalizedTitle = typeof title === 'string' ? title.trim() : ''
  if (!normalizedTitle) {
    const error = new Error('Task title is required')
    error.status = 400
    throw error
  }

  const normalizedStatus = normalizeTaskStatus(status ?? 'open') ?? 'open'
  const normalizedPriority = normalizeTaskPriority(priority ?? 'normal') ?? 'normal'
  const normalizedDueDate = normalizeDate(dueDate)
  const normalizedNotes = typeof notes === 'string' ? notes.trim() || null : null
  const metadataJson = metadata ? JSON.stringify(metadata) : '{}'

  const id = randomUUID()
  db.prepare(
    `
      INSERT INTO anya_tasks (
        id,
        session_id,
        profile_id,
        created_by,
        title,
        notes,
        status,
        priority,
        due_date,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    session.id,
    session.profile_id ?? null,
    user.userId ?? null,
    normalizedTitle,
    normalizedNotes,
    normalizedStatus,
    normalizedPriority,
    normalizedDueDate,
    metadataJson,
  )

  const task = db
    .prepare(
      `
        SELECT *
        FROM anya_tasks
        WHERE id = ?
      `,
    )
    .get(id)

  return mapTask(task)
}

export function updateTask(
  db,
  user,
  sessionId,
  taskId,
  { title, notes, status, priority, dueDate, metadata } = {},
) {
  assertAuthenticated(user)
  const session = getSession(db, user, sessionId)

  const existing = db
    .prepare(
      `
        SELECT *
        FROM anya_tasks
        WHERE id = ? AND session_id = ?
      `,
    )
    .get(taskId, session.id)

  if (!existing) {
    const error = new Error('Task not found')
    error.status = 404
    throw error
  }

  const updates = []
  const params = []

  if (title !== undefined) {
    const normalizedTitle = typeof title === 'string' ? title.trim() : ''
    if (!normalizedTitle) {
      const error = new Error('Task title cannot be empty')
      error.status = 400
      throw error
    }
    updates.push('title = ?')
    params.push(normalizedTitle)
  }

  if (notes !== undefined) {
    const normalizedNotes = typeof notes === 'string' ? notes.trim() || null : null
    updates.push('notes = ?')
    params.push(normalizedNotes)
  }

  if (status !== undefined) {
    const normalizedStatus = normalizeTaskStatus(status)
    updates.push('status = ?')
    params.push(normalizedStatus)
    if (normalizedStatus === 'completed') {
      updates.push('completed_at = CURRENT_TIMESTAMP')
    } else if (existing.completed_at) {
      updates.push('completed_at = NULL')
    }
  }

  if (priority !== undefined) {
    const normalizedPriority = normalizeTaskPriority(priority)
    updates.push('priority = ?')
    params.push(normalizedPriority)
  }

  if (dueDate !== undefined) {
    const normalizedDueDate = normalizeDate(dueDate)
    updates.push('due_date = ?')
    params.push(normalizedDueDate)
  }

  if (metadata !== undefined) {
    const metadataJson = metadata ? JSON.stringify(metadata) : '{}'
    updates.push('metadata = ?')
    params.push(metadataJson)
  }

  if (updates.length === 0) {
    return mapTask(existing)
  }

  params.push(taskId, session.id)

  db.prepare(
    `
      UPDATE anya_tasks
      SET ${updates.join(', ')},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND session_id = ?
    `,
  ).run(...params)

  const updated = db
    .prepare(
      `
        SELECT *
        FROM anya_tasks
        WHERE id = ?
      `,
    )
    .get(taskId)

  return mapTask(updated)
}

export async function generateAssistantResponse(db, user, sessionId, { content }) {
  const trimmed = (content ?? '').trim()
  if (!trimmed) {
    return "I'm here and ready to help—just let me know what you'd like to work on."
  }

  // Extract user context for personalization
  const userName = user?.display_name || user?.full_name || user?.profileName || 'there'
  const userEmail = user?.primary_email || user?.email || ''
  const isAdmin = Boolean(user?.is_admin || user?.role === 'admin')
  // Check if this is the primary admin (configured via ADMIN_EMAIL env var)
  // This provides special recognition for the main system administrator
  const isPrimaryAdmin = isAdmin && userEmail === ADMIN_EMAIL

  // Check for health-related queries and respond with system diagnostics
  const lowerContent = trimmed.toLowerCase()
  const healthKeywords = ['working', 'health', 'status', 'crawler', 'error', 'broken', 'fine', 'running']
  const isHealthQuery = healthKeywords.some(keyword => lowerContent.includes(keyword))
  
  if (isHealthQuery && isAdmin) {
    try {
      // Call system.health tool to get actual system status
      const { invokeTool: invokeRegisteredTool } = await import('./anyaToolRegistry.js')
      const healthResult = await invokeRegisteredTool('system.health', {}, { db, user })
      const health = healthResult?.output || {}
      
      // Build response based on actual system state
      const statusEmoji = {
        'healthy': '✅',
        'warning': '⚠️',
        'degraded': '🔴',
        'error': '❌'
      }[health.status] || '❓'
      
      let response = `Hi ${userName}! ${statusEmoji} System Status: **${health.status?.toUpperCase()}**\n\n`
      
      if (health.issues && health.issues.length > 0) {
        response += '**Issues Detected:**\n'
        health.issues.forEach(issue => {
          response += `• ${issue}\n`
        })
        response += '\n'
      } else {
        response += '✓ All systems operational!\n\n'
      }
      
      response += '**Quick Stats:**\n'
      response += `• ${health.counts?.opportunities || 0} funding opportunities\n`
      response += `• ${health.counts?.activeProfiles || 0} active profiles\n`
      response += `• ${health.crawlers?.totalRuns || 0} total crawler runs\n`
      
      if (health.crawlers?.recentFailures > 0) {
        response += `\n⚠️ ${health.crawlers.recentFailures} crawler failures in the last 24 hours\n`
      }
      
      if (health.lastError) {
        response += `\n**Last Error:**\n`
        response += `• ${health.lastError.crawler}: ${health.lastError.message}\n`
      }
      
      return response
    } catch (error) {
      console.error('[anya] Failed to get system health:', error)
      // Fall through to normal AI response
    }
  }

  let openai = null
  try {
    openai = getOpenAIClient()
  } catch (error) {
    console.warn('[anya] OpenAI client unavailable; providing guided assistance instead:', error.message)
    
    // Provide helpful responses without AI with personalization
    const lowerContent = trimmed.toLowerCase()
    
    if (lowerContent.includes('grant') || lowerContent.includes('funding')) {
      return `Hi ${userName}! I can help you discover grants! Try:\n• Click 'Discover Grants' to browse opportunities\n• Use 'Smart Matcher' for AI-powered recommendations\n• Check 'Pipeline' to track your applications`
    }
    
    if (lowerContent.includes('profile') || lowerContent.includes('organization')) {
      return `Hi ${userName}! To manage your profile:\n• Go to 'My Profiles' to view and edit profile details\n• Upload documents in the profile section\n• Set your organization type and focus areas`
    }
    
    return [
      `Hi ${userName}! I can help guide you through GrantFlow! Here are key features:`,
      "• **Discover Grants** - Find funding opportunities",
      "• **Smart Matcher** - Get personalized recommendations", 
      "• **Pipeline** - Track your applications",
      "",
      "What would you like to work on?"
    ].join('\n')
  }

  let historyMessages = null
  try {
    // Ensure the caller has access and load recent history for context.
    getSession(db, user, sessionId)
    historyMessages = getMessages(db, user, sessionId, { limit: 20, direction: 'asc' })
  } catch (historyError) {
    console.warn('[anya] Unable to load session history; continuing with minimal context:', historyError)
    historyMessages = []
  }

  // Build message history for OpenAI
  const conversationMessages = historyMessages
    .filter((msg) => typeof msg?.content === 'string' && msg.content.trim().length > 0)
    .map((msg) => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content,
    }))

  // Ensure current message is included (CRITICAL BUG FIX)
  if (!conversationMessages.some(msg => msg.role === 'user' && msg.content === trimmed)) {
    conversationMessages.push({ role: 'user', content: trimmed })
  }

  // Build personalized system prompt
  // Extract first name safely, handling edge cases
  const firstName = (!userName || userName === 'there') 
    ? 'the user' 
    : (typeof userName === 'string' ? userName.split(' ')[0] : userName)
  
  const systemPromptParts = [
    'You are Anya, the GrantFlow AI assistant. You are helpful, warm, and personable.',
    '',
    `Current User: ${userName}`,
    `User Email: ${userEmail}`,
    `Is Admin: ${isAdmin ? 'Yes' : 'No'}`,
    '',
    'Personalization Guidelines:',
    (!userName || userName === 'there')
      ? '- Address the user in a friendly, welcoming manner'
      : `- Always address the user by their first name (${firstName})`,
    '- Feel free to ask how their day is going or about their current situation in a natural, friendly way',
    '- Be conversational and friendly while remaining helpful and professional',
    `- Remember you're speaking to ${userName}`,
    '- Use a warm, supportive tone and occasionally use friendly emojis (👋, ✨, 🎯) when appropriate',
    '',
    'Your Role:',
    '- Help users with grant discovery, application management, funding opportunity tracking, and document preparation',
    '- Always be concise, actionable, and specific',
    '- Ground your guidance in GrantFlow features',
    '- Keep responses focused and practical',
    '',
  ]

  if (isAdmin) {
    systemPromptParts.push(
      'Admin Access:',
      isPrimaryAdmin 
        ? `- The current user is ${userName}, the primary system administrator`
        : '- The current user is a system administrator',
      '- You can perform admin actions such as:',
      '  • Running system crawlers (scholarship, local, comprehensive)',
      '  • Accessing and modifying system settings',
      '  • Viewing all user profiles and data',
      '  • Managing database operations',
      '  • System diagnostics and health checks',
      '',
      'CRITICAL - System Health Reporting:',
      '- NEVER claim "everything is fine" or "all systems working" without checking system.health tool first',
      '- When asked about system status, crawlers, or errors, ALWAYS use the system.health tool',
      '- Report actual issues found in system.health output - do not sugarcoat problems',
      '- If system.health shows failures, missing API keys, or zero opportunities, report them clearly',
      '- Base all health-related responses on actual data from system.health, not assumptions',
      '- Feel free to acknowledge their admin status when greeting them',
      ''
    )
  } else {
    systemPromptParts.push(
      'Admin Restrictions:',
      '- The current user is NOT an administrator',
      '- Admin-only actions include: running system crawlers, database operations, accessing all profiles, system configuration',
      '- If the user requests admin actions, politely explain that those features are restricted to administrators',
      '- Suggest alternative ways they can achieve their goals within their user permissions',
      '- Be kind and helpful in your explanation',
      ''
    )
  }

  const systemPrompt = systemPromptParts.join('\n')

  try {
    console.log('[Anya] Calling OpenAI API with model:', DEFAULT_ASSISTANT_MODEL)
    const response = await openai.chat.completions.create({
      model: DEFAULT_ASSISTANT_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversationMessages
      ],
      temperature: 0.3,
      max_tokens: 1000,
    })

    const reply = response.choices[0]?.message?.content?.trim()
    if (reply) {
      console.log('[Anya] OpenAI API response received successfully')
      return reply
    }
  } catch (error) {
    console.error('[Anya] OpenAI API Error:', error.message)
  }

  return "I'm having trouble reaching the AI service right now. Please try again in a moment."
}

export function listTools(user) {
  assertAuthenticated(user)
  return listToolMetadata(user)
}

export async function invokeTool(db, user, toolName, params, { sessionId } = {}) {
  assertAuthenticated(user)
  const result = await invokeRegisteredTool(toolName, params, {
    user,
    db,
    sessionId,
  })

  if (sessionId) {
    try {
      const session = getSession(db, user, sessionId)
      addMessage(db, user, session.id, {
        role: 'assistant',
        content: `Tool ${toolName} executed.`,
        toolName,
        toolPayload: result,
      })
    } catch (error) {
      console.warn('[anya] Unable to log tool invocation', error)
    }
  }

  return result
}
