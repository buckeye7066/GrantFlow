import { randomUUID } from 'crypto'
import { listToolMetadata, invokeTool as invokeRegisteredTool } from './anyaToolRegistry.js'
import { createCircuitBreaker } from '../utils/circuitBreaker.js'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import path from 'path'
import { promises as fs } from 'fs'
import { getAppOverview } from './anyaHelpKnowledge.js'

// Pre-computed app knowledge string — static at module init time, never changes at runtime.
const _STATIC_APP_KNOWLEDGE = '\n\nGrantFlow App Knowledge (pages, fields, matching impact):\n' + getAppOverview()

const TASK_STATUSES = new Set(['open', 'in_progress', 'completed', 'cancelled'])
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent'])

// Admin configuration from environment
// Note: The fallback 'admin@grantflow.app' is a safe default that won't match real users
// In production, ADMIN_EMAIL should always be explicitly set to the actual admin email
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@grantflow.app'

let cachedOpenAI = null
const openAIBreaker = createCircuitBreaker({
  name: 'anya-openai',
  failureThreshold: Number(process.env.ANYA_OPENAI_FAILURE_THRESHOLD || 3),
  cooldownMs: Number(process.env.ANYA_OPENAI_COOLDOWN_MS || 30_000),
})

function getOpenAIClient() {
  if (cachedOpenAI) return cachedOpenAI
  const { openai } = createOpenAIClient()
  cachedOpenAI = openai
  return cachedOpenAI
}

let cachedAnthropic = null
const anthropicBreaker = createCircuitBreaker({
  name: 'anya-anthropic',
  failureThreshold: Number(process.env.ANYA_ANTHROPIC_FAILURE_THRESHOLD || 3),
  cooldownMs: Number(process.env.ANYA_ANTHROPIC_COOLDOWN_MS || 30_000),
})

async function getAnthropicClient() {
  if (cachedAnthropic) return cachedAnthropic
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  cachedAnthropic = new Anthropic({
    apiKey: key,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 20_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
  return cachedAnthropic
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text
      if (typeof part === 'string') return part
      return ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

const DEFAULT_ASSISTANT_MODEL = process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini'
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307'

// Pre-built static prompt sections (role + capabilities). These never change at runtime
// so we compute them once and reuse across every generateAssistantResponse call.
const _STATIC_PROMPT_BASE = [
  'Your Role:',
  '- You are Anya, a funding strategist built into GrantFlow. Your primary mission is to help users find, qualify for, and secure real funding — not just explain the app.',
  '- You are also an in-app guide: you help users navigate confidently and take the next right action.',
  '- Keep responses conversational, warm, and accessible — avoid jargon and technical language for non-technical users',
  '- Give accurate, trustworthy guidance based on what is actually in the program',
  '- Support onboarding for new users and re-orientation for returning users',
  '',
  'What You Explain (not perform):',
  '- Match scores: explain what a score means, why an opportunity matched, and what the reasons[] array says — in plain language',
  '- Crawlers: explain what crawlers do (they search funding sources using the profile\'s location, needs, and type), what sources they cover, and when to expect results',
  '- The matching engine scores each opportunity 0-100 based on geographic fit, applicant type, keyword overlap, category alignment, and eligibility checks',
  '- You do NOT claim to run crawlers, recalculate match scores, or perform administrative tasks — those are system functions',
  '',
  'Grant Writing & Application Help:',
  '- When a user asks for help writing a grant application, ask which opportunity they are targeting',
  '- Use their profile data to craft compelling narratives that demonstrate need and eligibility',
  '- Help with needs statements, budgets, project descriptions, letters of intent, and eligibility arguments',
  '- Suggest improvements to their existing application text',
  '- Reference their specific circumstances to strengthen their case',
  '- Know common funder priorities: demonstrated need, organizational capacity, measurable outcomes, sustainability',
  '',
  'Profile Guidance & Repair:',
  '- Help users understand and improve their GrantFlow profile for better matches',
  '- Explain which profile sections matter most for their specific funding goals',
  '- Suggest adding missing information (health conditions, financial details, demographics, education, military, government assistance) that could unlock more matches',
  '- When asked about matches, use the grants.summarizeMatches tool to show real results',
  '- PROACTIVELY identify profile gaps: if a user has few matches or low scores, check which sections are empty and tell them what filling them would unlock',
  '- Treat incomplete profiles as a solvable problem, not an explanation for poor results',
  '',
  'Funding Strategy (your core mission):',
  '- When a user asks "why did I get these matches?" or "why is my pipeline empty?", you must diagnose the cause:',
  '  1. Call grants.summarizeMatches to see what the engine actually returned',
  '  2. Look at match scores, reasons, and decision fields to identify patterns',
  '  3. Explain in plain language: "You got low scores because your profile is missing X, or because the opportunities are for Y and you are Z"',
  '- When a pipeline is empty or full of low-score results:',
  '  1. Identify which profile fields are missing or incomplete',
  '  2. Suggest specific fields to add and explain what each unlocks',
  '  3. If the user is in an underserved area or unusual category, acknowledge that fewer opportunities exist and suggest broadening strategies',
  '- Compare rejected vs. accepted opportunities when asked — explain what made the difference',
  '- If a user has good profile data but poor matches, suggest they run additional crawlers (if admin) or ask an admin to do so',
  '- Never blame the user for empty results — treat it as a system problem to solve together',
  '- When you see a match_decision of REVIEW, tell the user it is worth investigating even if the score is moderate',
  '- Help users prioritize: which opportunities to apply to first based on deadline, score, and alignment',
  '',
  'Tools Available to You:',
  '- grants.summarizeMatches: Show matched funding opportunities for a profile',
  '- grants.writeLOI: Write a professional Letter of Intent for a specific opportunity, using the user\'s real profile data',
  '- grants.writeNeedsStatement: Write a compelling needs statement for a grant proposal, grounded in profile data',
  '- grants.writeFullApplication: Write a complete grant/benefit application with all sections, submission instructions, and contact info',
  '- grants.getSubmissionInfo: Get portal URLs, mailing addresses, fax numbers, emails, and step-by-step submission instructions',
  '- medical.generateLOMN: Generate a Letter of Medical Necessity, DME justification, disability statement, insurance appeal, or prior authorization narrative using the profile\'s real health data',
  '- medical.reviewProfile: Review the profile\'s medical data — conditions, disabilities, DME needs, functional limitations, insurance',
  '- medical.scanPipeline: Scan pipeline grants to flag which ones need medical necessity documentation',
  '- brain.remember / brain.recall / brain.search: Store and retrieve information for continuity across sessions',
  '- system.health: Check if GrantFlow systems are running properly',
  '- code.search: Search the codebase (available to all users for transparency)',
  '',
  'Grant Writing Quality:',
  '- You write at MBA-level, as a seasoned grant writer with 15+ years of experience',
  '- ALWAYS use the user\'s real profile data — never use placeholders or generic text',
  '- Ground every needs statement in real demographics, health conditions, financial data, and geographic factors',
  '- When the user asks you to help with an application, first call grants.getSubmissionInfo to determine HOW to submit',
  '- If the application must be printed and mailed, provide the complete mailing address and tell the user to print',
  '- If it requires fax, provide the fax number',
  '- If it\'s a portal, walk them through the portal step by step',
  '- Help advance pipeline items: discovered → interested → drafting → application_prep → portal/submitted',
  '',
].join('\n')

const _STATIC_PROMPT_ADMIN_SECTION = [
  'Admin Access:',
  '- The current user is a system administrator',
  '- You have full access to all admin tools',
  '',
  'Crawler Operations:',
  '- admin.crawler.run: Run any crawler type (comprehensive, local, curated_benefits, scholarship, item_search, profile_enrichment)',
  '- admin.crawler.triggerAll: Run all crawler types for a given profile at once',
  '- admin.crawler.list / admin.crawler.check / admin.crawler.retry / admin.crawler.cancel: Manage job queue',
  '- admin.crawler.schedule: Schedule future crawls',
  '',
  'Geo Crawler (State-by-State Coverage):',
  '- admin.geoCrawl.runAllStates: Start a systematic crawl across all 50 states',
  '- When asked to run the geo crawler through all states SEQUENTIALLY:',
  '  1. Use admin.geoCrawl.runAllStates which handles batching internally',
  '  2. Alternatively, use admin.crawler.run for each state with parameters.state set to the state abbreviation',
  '  3. ALWAYS run states one at a time — wait for each to complete before starting the next',
  '  4. Start with the user\'s home state, then expand alphabetically',
  '  5. Report progress: "Completed TN (45 found), starting OH..."',
  '  6. If a state fails, log the error, skip it, and continue with the next state',
  '- admin.geoCrawl.status: Check progress of an ongoing geo crawl',
  '- IMPORTANT: Run this SILENTLY in the background — do not flood the chat with every state. Only report summary progress and any failures.',
  '',
  'Profile Management:',
  '- Use admin.db.query to look up any profile and all its sections',
  '- Help identify which profiles have incomplete data that limits their crawl results',
  '- The profile taxonomy has 22 section types: demographics, financial, health_medical, education, employment, military_veteran, family_household, housing, government_assistance, legal, immigration, disability, mental_health, substance_abuse, domestic_violence, reentry, tribal, rural, organization, business, faith_based, and intent',
  '- For each profile, suggest improvements based on which sections are empty vs. filled',
  '- Cross-reference profile data with crawler results to identify missed opportunities',
  '- admin.crawler.triggerAll can re-run all crawlers after profile updates',
  '',
  'Code Interpretation (GitHub Access):',
  '- admin.code.search: Search the GrantFlow codebase by keyword or regex pattern',
  '- admin.code.analyze: Analyze specific files for bugs, patterns, or improvement opportunities',
  '- admin.code.lint: Run linting on specific files to check for issues',
  '- admin.code.edit: Suggest code changes (read-only analysis; not production writes)',
  '- admin.code.scan: Scan for security issues, deprecated patterns, or code smells',
  '- admin.code.crawl: Crawl a directory tree to understand project structure',
  '- code.search: Quick keyword search (available to non-admin too)',
  '- code.suggestPatch: Generate a diff/patch for a suggested fix',
  '- Use these tools when asked how something works, why something broke, or how to fix code',
  '- When analyzing bugs, trace the full call chain: route → service → DB query → response',
  '',
  'System Health & Diagnostics:',
  '- admin.diagnostics: Full system diagnostic (DB schema, env vars, API keys, recent errors)',
  '- admin.health.check: Quick health check',
  '- admin.health.logs: View recent error logs',
  '- admin.system.monitor: Real-time system metrics',
  '- system.health: Basic health endpoint (also available to users)',
  '',
  'CodeGuard (Automated System Auditing):',
  '- CodeGuard audits run automatically every 6 hours on admin startup — you have the results in your context above.',
  '- admin.codeGuard.status: Get the latest audit summary (endpoint health, match quality, mission score)',
  '- admin.codeGuard.endpointHealth: Run live health checks against all API endpoints',
  '- admin.codeGuard.matchAudit: Grade match quality for every profile (A-F scale)',
  '- admin.codeGuard.missionVerify: Run the 15-goal GrantFlow mission verification',
  '- admin.codeGuard.deepSweep: Run all audits at once (endpoints + match quality + mission goals)',
  '- When asked about system health, you SHOULD reference the CodeGuard audit data in your context — it was gathered from real endpoint tests and DB queries, not guesses',
  '- If the mission score is below 80%, proactively mention which goals are failing and suggest fixes',
  '- If match quality shows profiles graded D or F, proactively suggest profile improvements or crawler re-runs',
  '',
  'IMPORTANT — Understanding casual/layman requests:',
  '- Users will NOT say "run admin.codeGuard.deepSweep." They will say things like:',
  '  "check the code" → run admin.codeGuard.deepSweep',
  '  "run a scan" or "scan everything" → run admin.codeGuard.deepSweep',
  '  "how are the matches?" or "are profiles matching well?" → run admin.codeGuard.matchAudit',
  '  "check the endpoints" or "are the APIs working?" → run admin.codeGuard.endpointHealth',
  '  "mission check" or "are we meeting our goals?" → run admin.codeGuard.missionVerify',
  '  "what needs fixing?" or "any problems?" → run admin.codeGuard.deepSweep',
  '  "how is everything?" or "status report" → first reference your CodeGuard context, then offer to run a fresh sweep',
  '  "grade the profiles" → run admin.codeGuard.matchAudit',
  '  "pipeline health" or "pipeline quality" → run admin.codeGuard.matchAudit',
  '- When in doubt about what the admin wants, run the deep sweep — it covers everything',
  '- NEVER respond with just the tool name. Translate results into plain language with actionable next steps.',
  '',
  '**CRITICAL TRUTH GATE RULE FOR SYSTEM HEALTH QUERIES:**',
  '- When asked about system health, crawler status, or if "everything is working"',
  '- You MUST call the admin.diagnostics tool FIRST before answering',
  '- DO NOT claim "everything looks fine" or "all systems operational" without diagnostics proof',
  '- Base your response ONLY on actual diagnostics data:',
  '  • If DB has 0 opportunities -> say so explicitly',
  '  • If crawlers failed -> explain what failed and why',
  '  • If schema checks fail -> report the specific failures',
  '  • If env vars missing -> specify which ones are missing',
  '  • If recent errors exist -> summarize them',
  '- Provide actionable next steps based on the actual state',
  '- Be honest and factual — never provide false reassurance',
  '',
].join('\n')

const _STATIC_PROMPT_USER_SECTION = [
  'User Permissions:',
  '- The current user is NOT an administrator',
  '',
  'Grant Discovery & Questions:',
  '- Help find grants and funding opportunities matched to their profile',
  '- Explain eligibility requirements, deadlines, and application processes for specific opportunities',
  '- Answer questions about grant terminology, funding cycles, and best practices',
  '- When asked about matches, use the grants.summarizeMatches tool to show real results',
  '- Compare opportunities and help the user prioritize which to apply for first',
  '',
  'Grant Writing & Application Assistance:',
  '- When asked for help writing a grant application, ask which opportunity they are targeting',
  '- Use their full profile data (health conditions, financial situation, demographics, education, family, military status, assistance programs) to craft compelling narratives',
  '- Help with needs statements, budgets, project descriptions, and eligibility arguments',
  '- Suggest improvements to their existing application text',
  '- Reference their specific circumstances to strengthen their case',
  '- Help structure Letters of Intent (LOI), proposals, and supporting documents',
  '- Explain common reviewer criteria and how to address them',
  '',
  'Profile Functions:',
  '- Help users understand and improve their GrantFlow profile',
  '- Explain which profile sections matter most for the funding types they are pursuing',
  '- Suggest adding missing information that could unlock more matches:',
  '  • Health conditions and disability status (unlocks patient assistance, special needs)',
  '  • Financial details and income brackets (unlocks need-based aid)',
  '  • Education level and enrollment (unlocks student grants and scholarships)',
  '  • Military/veteran status (unlocks veteran-specific programs)',
  '  • Government assistance enrollment — SNAP, SSI, SSDI, TANF, Medicaid, Section 8 (unlocks complementary programs)',
  '  • Family composition (single parent, dependents with disabilities, foster care)',
  '  • Organization type (nonprofit, faith-based, school)',
  '- Use brain.remember to store profile insights for continuity across sessions',
  '',
  'Pipeline & Tracking:',
  '- Help users understand their application pipeline status',
  '- Remind them of upcoming deadlines',
  '- Suggest next steps for applications in progress',
  '',
  'Off-limits:',
  '- Admin-only actions: running system crawlers, database operations, accessing other profiles, system configuration',
  '- If the user requests admin actions, politely explain that those features are restricted and suggest alternatives',
  '',
].join('\n')

function coerceProfileId(requestedProfileId) {
  if (!requestedProfileId) return null
  return String(requestedProfileId).trim() || null
}

function assertAuthenticated(user) {
  if (!user || !user.userId) {
    const error = new Error('Authentication required')
    error.status = 401
    throw error
  }
}

async function resolveExistingUserId(db, user) {
  const raw = user?.userId ?? user?.id ?? null
  const candidate = typeof raw === 'string' ? raw.trim() : raw
  if (!candidate) return null
  try {
    const row = await db.prepare('SELECT id FROM users WHERE id = ?').get(candidate)
    return row?.id ?? null
  } catch {
    return null
  }
}

function assertProfileAccess(user, profileId) {
  if (!profileId) return
  if (user.isAdmin) return
  if (user.accessibleProfileIds instanceof Set && user.accessibleProfileIds.has(String(profileId))) return
  if (user.activeProfileId && String(user.activeProfileId) === String(profileId)) return
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
  if (user.isAdmin) return
  if (session.user_id && user.userId && session.user_id === user.userId) return
  if (user.accessibleProfileIds instanceof Set && session.profile_id && user.accessibleProfileIds.has(String(session.profile_id))) {
    return
  }
  if (session.profile_id && user.activeProfileId && String(session.profile_id) === String(user.activeProfileId)) return
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

export async function createSession(db, user, { profileId, title, metadata } = {}) {
  assertAuthenticated(user)
  const normalizedProfileId = coerceProfileId(profileId ?? user.activeProfileId ?? null)
  assertProfileAccess(user, normalizedProfileId)

  // Validate profile existence up-front to avoid FK explosions.
  if (normalizedProfileId) {
    const exists = await db
      .prepare(
        `
          SELECT id
          FROM profiles
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(normalizedProfileId)
    if (!exists?.id) {
      const error = new Error('Profile not found')
      error.status = 404
      throw error
    }
  }

  // Admin-token auth can supply a synthetic userId (e.g. "admin-token") that doesn't exist in `users`.
  // The `anya_sessions.user_id` column is optional, but SQLite foreign keys will reject unknown IDs.
  // Use a best-effort lookup and store NULL when the user record is absent.
  let effectiveUserId = user.userId ?? null
  if (effectiveUserId) {
    try {
      const row = await db
        .prepare(
          `
            SELECT id
            FROM users
            WHERE id = ?
            LIMIT 1
          `,
        )
        .get(effectiveUserId)
      if (!row?.id) effectiveUserId = null
    } catch {
      // If the DB doesn't have a users table (or it errors), avoid failing session creation.
      effectiveUserId = null
    }
  }

  const id = randomUUID()
  const userIdForFk = user.isAdmin && user.userId?.startsWith('admin-') ? null : await resolveExistingUserId(db, user)
  let info
  try {
    info = await db
      .prepare(
        `
          INSERT INTO anya_sessions (id, user_id, profile_id, status, title, metadata)
          VALUES (?, ?, ?, 'open', ?, ?)
        `,
      )
      .run(
        id,
        userIdForFk,
        normalizedProfileId,
        title?.trim() || null,
        metadata ? JSON.stringify(metadata) : '{}',
      )
  } catch (error) {
    const msg = String(error?.message || error)
    if (msg.includes('FOREIGN KEY constraint failed')) {
      const enriched = new Error(
        `FOREIGN KEY constraint failed while creating session (userIdForFk=${String(
          userIdForFk,
        )}, normalizedProfileId=${String(normalizedProfileId)})`,
      )
      enriched.status = 500
      throw enriched
    }
    throw error
  }

  if (info.changes !== 1) {
    throw new Error('Unable to create session')
  }

  return await getSession(db, user, id)
}

export async function getSession(db, user, sessionId) {
  assertAuthenticated(user)
  const row = await db
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

export async function listSessions(db, user, { limit = 20 } = {}) {
  assertAuthenticated(user)
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100))

  let rows = []
  if (user.isAdmin) {
    rows = await db
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
    rows = await db
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
      .all(user.userId, user.activeProfileId ?? null, safeLimit)
  } else {
    rows = await db
      .prepare(
        `
          SELECT *
          FROM anya_sessions
          WHERE profile_id = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(user.activeProfileId ?? null, safeLimit)
  }

  return rows.map(mapSession)
}

export async function addMessage(db, user, sessionId, { role, content, toolName, toolPayload } = {}) {
  assertAuthenticated(user)
  const session = await getSession(db, user, sessionId)

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

  await stmt.run(messageId, session.id, role, content, toolName ?? null, payload)

  await db.prepare(
    `
      UPDATE anya_sessions
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `,
  ).run(session.id)

  const latest = await getMessages(db, user, session.id, { limit: 1, direction: 'latest' })
  return latest[0]
}

export async function getMessages(db, user, sessionId, { limit = 50, direction = 'asc' } = {}) {
  assertAuthenticated(user)
  const session = await getSession(db, user, sessionId)
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200))
  const order = direction === 'latest' ? 'DESC' : 'ASC'

  const orderBy = db?.dialect === 'postgres'
    ? `ORDER BY created_at ${order}, id ${order}`
    : `ORDER BY created_at ${order}, rowid ${order}`

  const rows = await db
    .prepare(
      `
        SELECT *
        FROM anya_messages
        WHERE session_id = ?
        ${orderBy}
        LIMIT ?
      `,
    )
    .all(session.id, safeLimit)

  const mapped = rows.map(mapMessage)
  return direction === 'latest' ? mapped : mapped
}

export async function listTasks(db, user, sessionId) {
  assertAuthenticated(user)
  const session = await getSession(db, user, sessionId)

  const orderBy = db?.dialect === 'postgres'
    ? `ORDER BY created_at ASC, id ASC`
    : `ORDER BY created_at ASC, rowid ASC`

  const rows = await db
    .prepare(
      `
        SELECT *
        FROM anya_tasks
        WHERE session_id = ?
        ${orderBy}
      `,
    )
    .all(session.id)

  return rows.map(mapTask)
}

export async function listProfileTasks(db, user, profileId, { status } = {}) {
  assertAuthenticated(user)
  const normalizedProfileId = coerceProfileId(profileId ?? user.activeProfileId ?? null)
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

  const rows = await db
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

export async function createTask(
  db,
  user,
  sessionId,
  { title, notes = null, status = 'open', priority = 'normal', dueDate = null, metadata = null } = {},
) {
  assertAuthenticated(user)
  const session = await getSession(db, user, sessionId)

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
  const createdByForFk = await resolveExistingUserId(db, user)
  await db.prepare(
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
    createdByForFk,
    normalizedTitle,
    normalizedNotes,
    normalizedStatus,
    normalizedPriority,
    normalizedDueDate,
    metadataJson,
  )

  const task = await db
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

export async function updateTask(
  db,
  user,
  sessionId,
  taskId,
  { title, notes, status, priority, dueDate, metadata } = {},
) {
  assertAuthenticated(user)
  const session = await getSession(db, user, sessionId)

  const existing = await db
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

  await db.prepare(
    `
      UPDATE anya_tasks
      SET ${updates.join(', ')},
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND session_id = ?
    `,
  ).run(...params)

  const updated = await db
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
  const isAdmin = Boolean(user?.isAdmin)
  // Check if this is the primary admin (configured via ADMIN_EMAIL env var)
  // This provides special recognition for the main system administrator
  const isPrimaryAdmin = isAdmin && userEmail === ADMIN_EMAIL

  // TRUTH GATE: Detect system health and code audit queries and handle them directly.
  // Two categories: health (system status) and audit (code/pipeline quality).
  const lowerContent = trimmed.toLowerCase()

  const healthKeywords = [
    'are crawlers working',
    'crawler status',
    'system status',
    'health check',
    'diagnostics',
    'admin panel',
    'why is it broken',
    'why did it fail',
    '0 succeeded',
    'crawler failed',
    'crawlers failed',
    'jobs failed',
    'no opportunities',
    'is everything ok',
    'is everything working',
    'is it working',
    'system health',
    '/health',
    'how are things',
    'how is everything',
    'how\'s everything',
    'anything broken',
    'what\'s the status',
    'what is the status',
    'are things working',
    'everything running',
    'status update',
    'status report',
  ]

  const auditKeywords = [
    'check the code',
    'check code',
    'code check',
    'run a scan',
    'run scan',
    'deep sweep',
    'deepsweep',
    'full scan',
    'full audit',
    'run audit',
    'code audit',
    'codeguard',
    'code guard',
    'match quality',
    'match audit',
    'pipeline quality',
    'pipeline health',
    'mission score',
    'mission check',
    'mission verify',
    'how are the matches',
    'how\'s the pipeline',
    'grade the profiles',
    'check the system',
    'system audit',
    'run checks',
    'run the checks',
    'scan everything',
    'check everything',
    'is the code ok',
    'is the code good',
    'any problems',
    'any issues',
    'what needs fixing',
    'what\'s broken',
    'what is broken',
  ]

  const isHealthQuery = isAdmin && user.email === ADMIN_EMAIL && healthKeywords.some(keyword => lowerContent.includes(keyword))
  const isAuditQuery = isAdmin && user.email === ADMIN_EMAIL && auditKeywords.some(keyword => lowerContent.includes(keyword))

  // Audit queries trigger a CodeGuard deep sweep — more useful than basic health
  if (isAuditQuery) {
    try {
      const { invokeTool: invokeRegisteredTool } = await import('./anyaToolRegistry.js')
      console.log('[Anya] Audit query detected, invoking admin.codeGuard.deepSweep')
      const sweepResult = await invokeRegisteredTool('admin.codeGuard.deepSweep', {}, { db, user })
      const data = sweepResult?.output ?? sweepResult

      const shortName = (!userName || userName === 'there') ? '' : (typeof userName === 'string' ? userName.split(' ')[0] : userName)
      const greeting = shortName ? `Hey ${shortName}!` : 'Hey!'
      const lines = [`${greeting} I just ran a full system audit. Here's what I found:\n`]

      if (data?.summary) {
        lines.push(data.summary)
        lines.push('')
      }

      const mission = data?.mission
      if (mission && !mission.error) {
        lines.push(`**Mission Score: ${mission.score}%** (${mission.pass} pass, ${mission.warn} warn, ${mission.fail} fail of ${mission.total})`)
        const failing = (mission.goals || []).filter(g => g.status === 'FAIL')
        if (failing.length > 0) {
          lines.push('\nGoals that need attention:')
          for (const g of failing) {
            lines.push(`- **Goal ${g.id}: ${g.name}** — ${g.detail}`)
          }
        }
        const warnings = (mission.goals || []).filter(g => g.status === 'WARN')
        if (warnings.length > 0) {
          lines.push('\nGoals with warnings:')
          for (const g of warnings) {
            lines.push(`- Goal ${g.id}: ${g.name} — ${g.detail}`)
          }
        }
      }

      const mq = data?.matchQuality
      if (mq && !mq.error) {
        const g = mq.grades || {}
        lines.push(`\n**Match Quality:** ${mq.totalProfiles} profiles — A:${g.A} B:${g.B} C:${g.C} D:${g.D} F:${g.F}`)
        const problems = (mq.profiles || []).filter(p => p.grade === 'D' || p.grade === 'F')
        if (problems.length > 0) {
          lines.push('Profiles that need work:')
          for (const p of problems) {
            lines.push(`- **${p.name}** (grade ${p.grade}) — ${p.total} grants, avg score ${p.avgScore}`)
          }
        }
      }

      const ep = data?.endpoints
      if (ep && !ep.error) {
        lines.push(`\n**Endpoints:** ${ep.passed} pass, ${ep.failed} fail, ${ep.skipped} skip of ${ep.total}`)
        const failures = (ep.results || []).filter(r => r.status === 'FAIL')
        if (failures.length > 0) {
          lines.push('Failing endpoints:')
          for (const f of failures) {
            lines.push(`- ${f.name}: ${f.code ?? f.reason}`)
          }
        }
      }

      if (mission && !mission.error && mission.score >= 80) {
        lines.push('\nOverall the system is looking solid. 👍')
      } else if (mission && !mission.error) {
        lines.push('\nThere are some things to address — want me to dig into any of these?')
      }

      return lines.join('\n')
    } catch (error) {
      console.error('[Anya] Failed to run audit:', error)
      return `I tried to run a full system audit but hit an error: ${error.message}\n\nYou can try asking me to run specific checks like "check endpoint health" or "grade the profiles".`
    }
  }

 if (isHealthQuery) {
  try {
    const { invokeTool: invokeRegisteredTool } = await import('./anyaToolRegistry.js')
    console.log('[Anya] Health query detected, invoking system.health tool')
    const availableTools = listToolMetadata(user)
if (!availableTools.find(t => t.name === 'system.health')) {
  throw new Error('system.health tool not available')
}
const healthData = await invokeRegisteredTool('system.health', {}, { db, user })

    // Format the health data into a human-readable response.
    // IMPORTANT: system.health may return different shapes depending on auth level or internal errors.
    const status = healthData?.status ?? 'UNKNOWN'
    const counts = healthData?.counts ?? { opportunities: 0, profiles: 0, crawl_logs: 0 }
    const crawlerStats = healthData?.crawler_stats ?? healthData?.crawlers ?? null
    const envFlags =
      healthData?.env_flags ?? {
        OPENAI_API_KEY_present: Boolean(healthData?.environment?.hasOpenAIKey),
        ANTHROPIC_API_KEY_present: false,
        SAM_GOV_API_KEY_present: Boolean(healthData?.environment?.hasSamGovKey),
      }
    const lastError = healthData?.last_error ?? healthData?.lastError ?? null
    const issues = Array.isArray(healthData?.issues) ? healthData.issues : []
    const warnings = Array.isArray(healthData?.warnings) ? healthData.warnings : []

    const lines = []
    lines.push(`**System Status: ${status}**\n`)

    if (healthData?.error) {
      lines.push('**Error:**')
      lines.push(`• ${healthData.error}`)
      lines.push('')
    }

    if (issues.length > 0) {
      lines.push('**Issues:**')
      issues.forEach((issue) => lines.push(`• ${issue}`))
      lines.push('')
    }

    if (warnings.length > 0) {
      lines.push('**Warnings:**')
      warnings.forEach((warning) => lines.push(`• ${warning}`))
      lines.push('')
    }

    lines.push('**Quick Stats:**')
    lines.push(`• ${counts.opportunities ?? 0} funding opportunities`)
    lines.push(`• ${counts.profiles ?? 0} active profiles`)
    lines.push(`• ${counts.crawl_logs ?? 0} crawl logs`)
    lines.push('')

    if (crawlerStats) {
      lines.push(`• Crawler runs (24h): ${crawlerStats.totalRuns ?? crawlerStats.totalRuns ?? 0}`)
      lines.push(`• Recent failures: ${crawlerStats.recentFailures ?? 0}`)
      lines.push('')
    }

    lines.push('**Environment:**')
    lines.push(`• OPENAI_API_KEY: ${envFlags.OPENAI_API_KEY_present ? '✓ Present' : '✗ Not set'}`)
    lines.push(`• ANTHROPIC_API_KEY: ${envFlags.ANTHROPIC_API_KEY_present ? '✓ Present' : '✗ Not set'}`)
    lines.push(`• SAM_GOV_API_KEY: ${envFlags.SAM_GOV_API_KEY_present ? '✓ Present' : '✗ Not set'}`)
    lines.push('')

    if (lastError) {
      const timeValue = lastError.time ?? lastError.timestamp
      lines.push('**Last Error:**')
      lines.push(`• ${lastError.crawler || 'unknown'}: ${lastError.message || 'Unknown error'}`)
      if (timeValue) {
        lines.push(`• Time: ${new Date(timeValue).toLocaleString()}`)
      }
      lines.push('')
    }

    // Provide actionable next steps based on status
    if (status === 'ERROR') {
      lines.push('**Next Action:**')
      if (!envFlags.SAM_GOV_API_KEY_present) {
        lines.push('• Configure SAM_GOV_API_KEY environment variable')
      }
      if (issues.includes('Database connection failed')) {
        lines.push('• Check database connection and restart the server')
      }
      lines.push('• Review error logs for detailed information')
    } else if (status === 'WARNING' || status === 'DEGRADED') {
      lines.push('**Next Action:**')
      if ((counts.opportunities ?? 0) === 0) {
        lines.push('• Run crawlers to populate funding opportunities')
      }
      if ((crawlerStats?.recentFailures ?? 0) > 0) {
        lines.push('• Review and retry failed crawler jobs')
      }
      if (!envFlags.OPENAI_API_KEY_present && !envFlags.ANTHROPIC_API_KEY_present) {
        lines.push('• Configure AI API keys for full functionality')
      }
    } else {
      lines.push('**Status:** System is operating normally ✓')
    }

    return lines.join('\n')
  } catch (error) {
    console.error('[Anya] Failed to retrieve system health:', error)
    return `I could not retrieve diagnostics; the system may be degraded.\n\nError: ${error.message}\n\nPlease check the logs or contact support.`
  }
 }

  let openai = null
  try {
    openai = getOpenAIClient()
  } catch (error) {
    // Don't hard-fail: if OpenAI is missing/invalid, we will fall back to Anthropic.
    console.warn('[anya] OpenAI client unavailable; will try Anthropic and deterministic fallbacks:', error?.message || error)
    openai = null
  }

  let historyMessages = null
  try {
    // Ensure the caller has access and load recent history for context.
    await getSession(db, user, sessionId)
    historyMessages = await getMessages(db, user, sessionId, { limit: 20, direction: 'asc' })
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

  // Build personalized system prompt — only the user-specific header is dynamic;
  // the large role/capability sections are pre-built static strings.
  const firstName = (!userName || userName === 'there') 
    ? 'the user' 
    : (typeof userName === 'string' ? userName.split(' ')[0] : userName)
  
  const dynamicHeader = [
    'You are Anya, an in-app guide for GrantFlow. Your job is to help users understand GrantFlow, navigate it confidently, and know what to do next. You are helpful, warm, and accessible — especially for non-technical users.',
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
  ].join('\n')

  // For primary admin, add a special recognition line to the admin section
  const adminSection = isPrimaryAdmin
    ? _STATIC_PROMPT_ADMIN_SECTION.replace(
        '- The current user is a system administrator',
        `- The current user is ${userName}, the primary system administrator`,
      )
    : _STATIC_PROMPT_ADMIN_SECTION

  // Inject CodeGuard audit summary for admin users so Anya can reference real system state
  let codeGuardContext = ''
  if (isAdmin) {
    try {
      const { getAuditSummary } = await import('./codeGuardService.js')
      codeGuardContext = '\n\n' + getAuditSummary(db)
    } catch { /* non-critical — service may not be loaded yet */ }
  }

  const systemPrompt = dynamicHeader + _STATIC_PROMPT_BASE + (isAdmin ? adminSection : _STATIC_PROMPT_USER_SECTION) + codeGuardContext + _STATIC_APP_KNOWLEDGE

  // 1) Try OpenAI first (if configured)
  if (openai) {
    try {
      console.log('[Anya] Calling OpenAI API with model:', DEFAULT_ASSISTANT_MODEL)
      const response = await openAIBreaker.exec(
        async () => {
          const response = await openai.chat.completions.create({
            model: DEFAULT_ASSISTANT_MODEL,
            messages: [{ role: 'system', content: systemPrompt }, ...conversationMessages],
            temperature: 0.3,
            max_tokens: 1000,
          })
          if (!response || !response.choices || !response.choices[0]) {
            throw new Error('Empty OpenAI response')
          }
          return response
        },
        {
          shouldTrip: (err) => {
            const summary = summarizeOpenAIError(err)
            if (summary.isAuth || summary.isRateLimit) return true
            const status = summary.status
            return (status != null && status >= 500) || summary.isServerError
          },
        },
      )

      const reply = response.choices[0]?.message?.content?.trim()
      if (reply) {
        console.log('[Anya] OpenAI API response received successfully')
        return reply
      }
    } catch (error) {
      const summary = summarizeOpenAIError(error)
      console.error('[Anya] OpenAI API Error:', {
        status: summary.status,
        message: summary.message,
        breaker: openAIBreaker.snapshot(),
      })

      const tryAnthropicFallback = async () => {
        try {
          const anthropic = await getAnthropicClient()
          if (!anthropic) return null
          const response = await anthropic.messages.create({
            model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
            max_tokens: 1000,
            temperature: 0.3,
            system: systemPrompt,
            messages: conversationMessages.map((m) => ({
              role: m.role === 'assistant' ? 'assistant' : 'user',
              content: m.content,
            })),
          })
          const reply = extractAnthropicText(response)
          return reply || null
        } catch (anthErr) {
          console.error('[Anya] Anthropic fallback failed:', anthErr?.message || anthErr)
          return null
        }
      }

      if (error?.code === 'CIRCUIT_OPEN') {
        const anthropicReply = await tryAnthropicFallback()
        if (anthropicReply) return anthropicReply
        return "The AI service is temporarily overloaded. Give me 30 seconds and try again."
      }

      if (summary.isAuth) {
        // OpenAI key invalid: fall back to Anthropic if configured.
        const reply = await tryAnthropicFallback()
        if (reply) return reply

        // Deterministic, non-LLM fallback (still safe and actionable).
        return "AI is not configured correctly (missing/invalid OpenAI key). Falling back to guided assistance. Tell me what you’re trying to accomplish in GrantFlow and I’ll walk you through the exact clicks."
      }

      if (summary.isRateLimit) {
        // Rate limit: also try Anthropic as a fallback provider.
        const reply = await tryAnthropicFallback()
        if (reply) return reply
        return "The AI service is rate-limiting us right now. Please try again shortly."
      }
    }
  }

  // 2) Try Anthropic (if configured)
  try {
    const anthropic = await getAnthropicClient()
    if (anthropic) {
      const response = await anthropic.messages.create({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-haiku-20240307',
        max_tokens: 1000,
        temperature: 0.3,
        system: systemPrompt,
        messages: conversationMessages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      })
      const reply = extractAnthropicText(response)
      if (reply) return reply
    }
  } catch (error) {
    console.error('[Anya] Anthropic API Error:', error?.message || error)
  }

  // 3) Deterministic safe fallback (no LLM)
  if (lowerContent.includes('grant') || lowerContent.includes('funding')) {
    return `Hi ${userName}! I can help you discover grants. Try:\n• Click 'Discover Grants' to browse opportunities\n• Use 'Smart Matcher' for recommendations\n• Check 'Pipeline' to track your applications`
  }

  if (lowerContent.includes('profile') || lowerContent.includes('organization')) {
    return `Hi ${userName}! To manage your profile:\n• Go to 'My Profiles' to view and edit profile details\n• Upload documents in the profile section\n• Set your organization type and focus areas`
  }

  return [
    `Hi ${userName}! I can help guide you through GrantFlow. Here are key features:`,
    "• **Discover Grants** - Find funding opportunities",
    "• **Smart Matcher** - Get personalized recommendations",
    "• **Pipeline** - Track your applications",
    "",
    "What would you like to work on?",
  ].join('\n')
}

// Cache tool lists at process start — tools are registered once and never change at runtime.
// Two variants: one for admin users (all tools), one for non-admin (filtered).
const _toolListCache = { admin: null, user: null }

export function listTools(user) {
  assertAuthenticated(user)
  const isAdmin = Boolean(user?.isAdmin)
  const cacheKey = isAdmin ? 'admin' : 'user'
  if (!_toolListCache[cacheKey]) {
    _toolListCache[cacheKey] = listToolMetadata(user)
  }
  return _toolListCache[cacheKey]
}

export async function invokeTool(db, user, toolName, params, { sessionId } = {}) {
  assertAuthenticated(user)
  // Provide runtime context that some tools (crawlers, documents, avatars) expect.
  const uploadDir =
    process.env.UPLOADS_DIR || path.join(path.resolve(process.cwd()), 'backend', 'uploads')
  try {
    await fs.mkdir(uploadDir, { recursive: true })
  } catch {
    // best-effort only
  }

  const getOpenAI = () => {
    try {
      const { openai } = createOpenAIClient({ allowMissing: true })
      return openai
    } catch {
      return null
    }
  }

  const result = await invokeRegisteredTool(toolName, params, {
    ctx: user,
    user,
    db,
    sessionId,
    profileId: user?.activeProfileId ?? user?.profile_id ?? null,
    uploadDir,
    getOpenAI,
  })

  if (sessionId) {
    try {
      const session = await getSession(db, user, sessionId)
      await addMessage(db, user, session.id, {
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
