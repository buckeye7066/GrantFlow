import { randomUUID } from 'crypto'
import { listToolMetadata, invokeTool as invokeRegisteredTool } from './anyaToolRegistry.js'

const TASK_STATUSES = new Set(['open', 'in_progress', 'completed', 'cancelled'])
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

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

export function generatePlaceholderResponse({ content }) {
  const trimmed = (content ?? '').trim()
  if (!trimmed) {
    return "I'm ready when you are—let me know how I can help."
  }

  return [
    "I'm warming up the tooling pipeline. Here’s what I can do next:",
    '• Inspect relevant code modules.',
    '• Propose the safest change set.',
    '• Run targeted tests once you approve.',
    '',
    'Give me a specific task or question and I’ll walk you through it.',
  ].join('\n')
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
