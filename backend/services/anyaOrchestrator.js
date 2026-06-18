import { randomUUID } from 'crypto'
import { listToolMetadata, invokeTool as invokeRegisteredTool } from './anyaToolRegistry.js'
import { createCircuitBreaker } from '../utils/circuitBreaker.js'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import path from 'path'
import { promises as fs } from 'fs'
import { createLogger } from '../utils/logger.js'
const log = createLogger('anyaOrchestrator')

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
const DEFAULT_ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'

// Whitelist of tools the chat path is allowed to call mid-conversation
// via OpenAI tool calling. Keep this list tight — every tool exposed here
// is one Anya can run autonomously on a single user message, so it must
// be safe, idempotent (or confirmation-gated), and scoped to the active
// profile. The wider tool registry stays available via the Admin Tools
// dialog and explicit /tools/invoke calls; this set is the
// "things Anya can do herself when the user just talks to her" surface.
//
// Mission rule: every name here MUST be the canonical id from
// anyaToolRegistry.js. Do not invent shortened variants — Anya looks
// these up by name to invoke them.
// The ONLY tools the chat path actually exposes to the model (see the OpenAI
// tools array build in generateAssistantResponse). The prompt's "tools you can
// call" section is GENERATED from this list so the two can never drift — Anya is
// never told it can directly call a tool the chat path will not hand it.
// (Mission System 8, RC-11.)
export const CHAT_CALLABLE_TOOL_DOCS = [
  ['profile.updateSection', 'Save user-provided information to a specific profile section (merge-safe). Confirmation-gated: first call returns confirmation_required, second call (with confirmed:true) writes.'],
  ['profile.getCompletionStatus', 'Check which sections are filled/empty and get suggestions for what to ask next.'],
  ['student.commitToUniversity', 'For student profiles, mark a single school (by name or id, e.g. "MTSU") as the one the student is attending. Confirmation-gated like profile.updateSection.'],
  ['anya.nextBestAction', 'Return the recommended next action grounded in current page + opportunity + profile gaps.'],
  ['grants.summarizeMatches', 'Show matched funding opportunities for a profile.'],
]
export const CHAT_TOOL_WHITELIST = CHAT_CALLABLE_TOOL_DOCS.map(([name]) => name)

// Prompt lines describing exactly what Anya can call from chat, plus an honest
// statement of what it CANNOT call (so it guides the user / writes content
// inline instead of fabricating tool calls).
const _CHAT_TOOL_PROMPT_LINES = [
  'Tools you can call directly RIGHT NOW (via tool calling — actually call them, never pretend):',
  ...CHAT_CALLABLE_TOOL_DOCS.map(([name, desc]) => `- ${name}: ${desc}`),
  '',
  'You do NOT have a chat tool for anything else. In particular:',
  '- Writing an LOI, needs statement, or full grant/benefit application: there is NO tool — you write the document yourself, directly in your reply, using the user\'s real profile data. Producing the text IS the deliverable; never claim a tool "generated" or "saved" it.',
  '- Submission details, letters of medical necessity, medical profile review, pipeline medical scans, codebase search, cross-session memory, and system-health checks run through GrantFlow\'s app panels, not this chat. If the user needs one, explain it and point them to the exact screen — do NOT claim you executed it.',
]

// OpenAI's tool/function naming spec only allows [a-zA-Z0-9_-], so the
// dotted names from our registry (`profile.updateSection`) need to be
// flattened on the way out and re-expanded on the way back in. We keep
// the mapping here as one-pass lookup tables so the chat path stays
// allocation-light per request.
function _toOpenAIToolName(registryName) {
  return String(registryName).replace(/\./g, '__')
}
function _fromOpenAIToolName(openAIName) {
  return String(openAIName).replace(/__/g, '.')
}

// Pre-built static prompt sections (role + capabilities). These never change at runtime
// so we compute them once and reuse across every generateAssistantResponse call.
const _STATIC_PROMPT_BASE = [
  'CRITICAL HONESTY RULE — ABSOLUTELY MANDATORY:',
  '- NEVER say you are doing, performing, updating, saving, or completing an action unless you have actually called the corresponding tool in this same response. There is no offline "I will do it later" — there is only "I just called the tool and here is the result" or "I cannot do that here, please use [specific UI control]".',
  '- NEVER write theatrical placeholders like "[Updating the profile…]", "[Working on it…]", "[Doing the task…]", "Let me update that for you…", or any phrase that pretends a side-effect happened. Those phrases are forbidden — the user reads them as proof you did the thing, and finds out later you did not.',
  '- If the user asks you to change something (e.g. "only include MTSU as Anastasia\'s university"), choose ONE of these paths:',
  '  1. Call the right tool now (e.g. student.commitToUniversity, profile.updateSection) WITH confirmed:false on the first call to surface the confirmation, then again with confirmed:true after the user approves. The tool result is the proof of work.',
  '  2. If no tool can do it, tell the user plainly: "I cannot do that from chat. Open the Universities tab, find the school card, and click \'I\'m attending\' on the school you chose." Point them to the exact UI control.',
  '- After a tool call, your text reply must reference the tool result truthfully. Do NOT claim success if the tool returned confirmation_required:true, an error, or a "school_not_found" reason — instead, surface what actually happened and what the user needs to do next.',
  '- If you are uncertain whether a tool exists or whether you are allowed to call it, say so honestly: "I am not sure I can do this directly — let me check / let me show you where to do it manually."',
  '',
  'Your Role:',
  '- You are the in-app guide for GrantFlow. Help users understand what GrantFlow is, how it works, and what to do next.',
  '- For new users: explain the app in plain language. Walk them through what a profile is, why it matters, and what happens after they fill it out.',
  '- For returning users: orient them quickly — remind them where they left off and suggest the next most useful action.',
  '- Explain what users are seeing on any screen. If they describe a result, an error, or a section they don\'t understand, explain it clearly.',
  '- Help users with grant discovery, application writing, funding opportunity tracking, and document preparation.',
  '- Always be concise, actionable, and specific — ground your guidance in real GrantFlow data.',
  '- When helping with grant applications, draw on the user\'s full profile: health conditions, financial situation, demographics, education, military status, family, government assistance status.',
  '- Keep responses focused and practical — suggest concrete next steps.',
  '- Make the system less intimidating for nontechnical users. Use plain language. Avoid jargon.',
  '- When a user seems lost or unsure what to do, offer the 2-3 most helpful next actions directly.',
  '',
  'Grant Writing & Application Help:',
  '- When a user asks for help writing a grant application, ask which opportunity they are targeting',
  '- Use their profile data to craft compelling narratives that demonstrate need and eligibility',
  '- Help with needs statements, budgets, project descriptions, letters of intent, and eligibility arguments',
  '- Suggest improvements to their existing application text',
  '- Reference their specific circumstances to strengthen their case',
  '- Know common funder priorities: demonstrated need, organizational capacity, measurable outcomes, sustainability',
  '',
  'Profile Functions:',
  '- Help users understand and improve their GrantFlow profile for better matches',
  '- Explain which profile sections matter most for their specific funding goals',
  '- When a user shares personal information (location, income, health, employment, family, education), use profile.updateSection to save it directly',
  '- Use profile.getCompletionStatus to see which sections are filled and which to ask about next',
  '- Guide the user conversationally: ask about one section at a time, save their answers, then suggest the next most impactful section',
  '- After saving data, tell the user what you saved and why it helps their matches',
  '- When asked about matches, use the grants.summarizeMatches tool to show real results',
  '',
  ..._CHAT_TOOL_PROMPT_LINES,
  '',
  'Grant Writing Quality:',
  '- You write at MBA-level, as a seasoned grant writer with 15+ years of experience',
  '- ALWAYS use the user\'s real profile data — never use placeholders or generic text',
  '- Ground every needs statement in real demographics, health conditions, financial data, and geographic factors',
  '- When the user asks you to help with an application, ask how they plan to submit (portal, email, mail, fax) or point them to the opportunity\'s submission details in the app, then tailor your help to that channel',
  '- If the application must be printed and mailed, provide the complete mailing address and tell the user to print',
  '- If it requires fax, provide the fax number',
  '- If it\'s a portal, walk them through the portal step by step',
  '- Help advance pipeline items: discovered → interested → drafting → application_prep → portal/submitted',
  '',
  'Housing & Living Expense Funding Knowledge:',
  '- Many students and individuals need help with off-campus living expenses (rent, utilities, food) but don\'t realize some funding can be used for this.',
  '- Funding categories that can help with housing:',
  '  • refund_eligible: Scholarships/grants that exceed tuition produce a refund check disbursed to the student for living expenses.',
  '  • stipend: Programs that provide monthly stipends or living allowances.',
  '  • housing_direct: RA positions, housing grants, room and board scholarships.',
  '  • coa_adjustment: Students can request a Cost of Attendance increase from their financial aid office (Professional Judgment) to reflect actual rent/utilities, unlocking more aid.',
  '  • faith_based: Church and denominational scholarships — often overlooked, can be used for any educational expense including housing.',
  '  • talent_based: Music, art, athletic scholarships — many disburse to student accounts and excess is refunded.',
  '- When explaining funding to users, ALWAYS explain HOW the funding can be used for housing when usable_for_housing is true.',
  '- Example explanations:',
  '  "This scholarship can generate a refund that can be used toward rent and utilities."',
  '  "You can request a Cost of Attendance adjustment to include your actual rent — this may increase your financial aid eligibility."',
  '  "This stipend covers living expenses directly — you can use it for rent, food, and utilities."',
  '- Actionable suggestions to prioritize:',
  '  • "Request a COA adjustment from your financial aid office"',
  '  • "Apply for an RA position for free housing"',
  '  • "Stack HOPE with Pell Grant to maximize your refund"',
  '  • "Apply for church scholarships — they\'re less competitive and can cover housing"',
  '  • "Your music talent qualifies you for scholarships that refund excess to you"',
  '- When showing funding results, highlight ones with usable_for_housing = true and explain the housing angle.',
  '',
  'Link Verification Awareness:',
  '- Opportunities have a link_status field: "ok", "broken", "redirect", "unverified", or "skipped".',
  '- When presenting an opportunity with link_status "broken", warn the user: "Note: our last check found the application link may be broken. Try the URL, and if it doesn\'t work, contact the funder directly."',
  '- When link_status is "redirect", mention that the URL may have moved but should still work.',
  '- Do NOT warn about "ok", "unverified", or "skipped" links — only flag broken or redirect.',
  '',
].join('\n')

const _STATIC_PROMPT_ADMIN_SECTION = [
  'Admin Access:',
  '- The current user is a system administrator',
  '- The admin operations below exist in the GrantFlow Admin Tools panel. From THIS chat you can explain them, interpret their output, and guide the admin — but the ONLY tools you can directly call here are the chat tools listed above. Never claim you ran an admin operation (crawler, geo-crawl, diagnostics, code, db) that you did not actually call.',
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
  '- code.search: Search the GrantFlow codebase by keyword or regex pattern (available to all users)',
  '- code.suggestPatch: Generate a diff/patch for a suggested fix (available to all users)',
  '- admin.code.crawl: Crawl a directory tree to understand project structure',
  '- admin.code.analyze: Analyze specific files for bugs, patterns, or improvement opportunities',
  '- admin.code.lint: Run linting on specific files to check for issues',
  '- admin.code.edit: Suggest code changes (read-only analysis; not production writes)',
  '- admin.code.scan: Scan for security issues, deprecated patterns, or code smells',
  '- admin.code.missionAudit: Audit code against mission goals',
  '- admin.code.autoRepair: Auto-repair common anti-patterns (admin only)',
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
  if ((value === null || value === undefined) || value === '') return null
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
  let normalizedProfileId = coerceProfileId(profileId ?? user.activeProfileId ?? null)
  assertProfileAccess(user, normalizedProfileId)

  // Validate profile existence up-front to avoid FK explosions.
  // A stale `activeProfileId` (deleted profile, fresh login, admin tools)
  // is common; hard-404'ing here forces every UI to implement a retry and
  // pollutes the browser console. Instead, gracefully degrade to a
  // profile-less session so the copilot still opens on the first attempt.
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
      console.warn(
        '[anya] createSession: supplied profile_id not found; creating profile-less session',
        { supplied: normalizedProfileId, userId: user?.userId ?? null },
      )
      normalizedProfileId = null
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
  const userIdForFk = await resolveExistingUserId(db, user)
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

export async function deleteSession(db, user, sessionId) {
  assertAuthenticated(user)
  const session = await db
    .prepare('SELECT * FROM anya_sessions WHERE id = ?')
    .get(sessionId)
  assertSessionAccess(user, session)

  // Hard delete — FK cascades handle anya_messages, anya_tasks, anya_context.
  // anya_runs and anya_tool_usage use ON DELETE SET NULL, preserving the audit trail.
  await db.prepare('DELETE FROM anya_sessions WHERE id = ?').run(sessionId)
  return { deleted: true, id: sessionId }
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
  // 'latest' fetches rows DESC (newest first); reverse so callers see chronological order.
  return direction === 'latest' ? mapped.reverse() : mapped
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

export async function generateAssistantResponse(db, user, sessionId, { content, currentPage, pageContext } = {}) {
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

  // TRUTH GATE: Detect system health queries and handle them directly
  // Only for admin users to prevent false positives in normal conversation
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
  ]

  const isHealthQuery = isAdmin && healthKeywords.some(keyword => lowerContent.includes(keyword))

 if (isHealthQuery) {
  try {
    const { invokeTool: invokeRegisteredTool } = await import('./anyaToolRegistry.js')
    log.info('[Anya] Health query detected, invoking system.health tool')
    // The tool authorizes via context.ctx.isAdmin -- if we forget to forward the
    // ctx the registered handler treats us as a non-admin user and Anya
    // returns the redacted "safe" health summary even for real admins,
    // breaking Goal #6 (truthful, grounded answers).
    const healthData = await invokeRegisteredTool(
      'system.health',
      {},
      { db, user, ctx: user, profileId: user?.activeProfileId ?? user?.profile_id ?? null },
    )

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
      lines.push(`• Crawler runs (24h): ${crawlerStats.totalRuns ?? 0}`)
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

  // v4: Pre-load active profile summary so Anya has context for the FIRST response
  // without requiring a tool invocation. This eliminates generic advice on initial messages.
  let profileContextSection = ''
  try {
    const activeProfileId = user?.activeProfileId || user?.profile_id
    if (activeProfileId && db) {
      const profile = db.prepare(
        'SELECT id, display_name, primary_type, state, organization_type, categories FROM profiles WHERE id = ?'
      ).get(activeProfileId)
      if (profile) {
        const sections = db.prepare(
          'SELECT section_key, data FROM profile_sections WHERE profile_id = ?'
        ).all(activeProfileId)
        const filledSections = []
        const emptySections = []
        for (const s of sections) {
          try {
            const d = JSON.parse(s.data || '{}')
            const hasValue = Object.values(d).some(v =>
              v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
            )
            ;(hasValue ? filledSections : emptySections).push(s.section_key)
          } catch { emptySections.push(s.section_key) }
        }
        const matchCount = (() => {
          try {
            const row = db.prepare('SELECT total_matches FROM crawl_metadata WHERE profile_id = ?').get(activeProfileId)
            return row?.total_matches ?? 0
          } catch { return 0 }
        })()
        profileContextSection = [
          '',
          '## Active Profile Summary',
          `Profile: ${profile.display_name || 'Unnamed'} (${profile.primary_type || 'individual'})`,
          profile.state ? `State: ${profile.state}` : 'State: Not set (important for matching!)',
          profile.organization_type ? `Organization: ${profile.organization_type}` : '',
          `Filled sections: ${filledSections.join(', ') || 'none'}`,
          emptySections.length > 0 ? `Empty sections needing data: ${emptySections.slice(0, 5).join(', ')}` : '',
          `Current matches: ${matchCount} opportunities`,
          matchCount === 0 ? 'NOTE: No matches yet — suggest running Discovery or filling more profile sections.' : '',
          '',
        ].filter(Boolean).join('\n')
      }
    }
  } catch (profileLoadErr) {
    console.warn('[anya] Could not pre-load profile context:', profileLoadErr?.message)
  }

  // Build personalized system prompt — only the user-specific header is dynamic;
  // the large role/capability sections are pre-built static strings.
  const firstName = (!userName || userName === 'there')
    ? 'the user'
    : (typeof userName === 'string' ? userName.split(' ')[0] : userName)

  const dynamicHeader = [
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
  ].join('\n')

  // For primary admin, add a special recognition line to the admin section
  const adminSection = isPrimaryAdmin
    ? _STATIC_PROMPT_ADMIN_SECTION.replace(
        '- The current user is a system administrator',
        `- The current user is ${userName}, the primary system administrator`,
      )
    : _STATIC_PROMPT_ADMIN_SECTION

  const pageGuidanceMap = {
    Dashboard: 'User sees recent grants, pipeline stats, and activity. Help them understand their match scores, navigate to discovery, or explain what the pipeline is.',
    Discovery: 'User is searching for grants. Help them refine their profile, understand search results, or explain what each grant means.',
    Pipeline: 'User sees their saved grants. Help them understand status stages, deadlines, and next steps for applying.',
    Proposals: 'User is working on grant proposals. Help them draft, refine, or review proposal content and explain what makes a strong proposal.',
    Applications: 'User is tracking their grant applications. Help them understand the status lifecycle and what to do next.',
    Profile: 'User is filling out their profile. Encourage completeness — more profile data = better matches.',
    Settings: 'User is managing preferences. Help with notification settings or data management.',
  }
  const resolvedPage = currentPage || 'Unknown'
  const pageGuidance = pageGuidanceMap[resolvedPage] || 'Give general GrantFlow guidance.'
  // Live page context arrives from the client when the user clicks "Use current
  // screen" or sends a message from a route adapter. Earlier this argument was
  // accepted by the route but never injected into the system prompt, so Anya
  // could not "see" what the user was looking at -- a Goal #6 (grounded answers)
  // and Goal #4 (next-action) regression. Truncate to keep the prompt bounded.
  let liveContextSection = ''
  if (pageContext && typeof pageContext === 'object') {
    try {
      const serialized = JSON.stringify(pageContext)
      const MAX = 4000
      const trimmedCtx = serialized.length > MAX
        ? `${serialized.slice(0, MAX)}…[truncated for size]`
        : serialized
      liveContextSection = [
        '## Live Page Context (what the user can see right now)',
        'Use this JSON snapshot to ground your reply in concrete data the user is currently looking at. Prefer specific names, ids, deadlines, statuses, and counts from this snapshot over generic advice.',
        '```json',
        trimmedCtx,
        '```',
        '',
      ].join('\n')
    } catch {
      liveContextSection = ''
    }
  }
  const pageContextSection = [
    '## Current Page Context',
    `The user is currently on: ${resolvedPage}`,
    '',
    `Page-specific guidance: ${pageGuidance}`,
    '',
    liveContextSection,
  ].join('\n')

  const systemPrompt = dynamicHeader + profileContextSection + pageContextSection + _STATIC_PROMPT_BASE + (isAdmin ? adminSection : _STATIC_PROMPT_USER_SECTION)

  // Build the OpenAI tool schema for the chat-time whitelist. Without
  // this, the LLM had no way to actually run profile.updateSection /
  // student.commitToUniversity / etc., so it would hallucinate
  // "[Updating the profile…]" placeholders and never write anything —
  // the exact bug the user reported. With tools wired in, the LLM either
  // calls the tool (and we surface the real result) or it answers in
  // text without claiming to have done anything.
  const activeProfileId = user?.activeProfileId || user?.profile_id || null
  let openaiTools
  try {
    const toolMetadata = listToolMetadata(user)
    const allowed = toolMetadata.filter((t) => CHAT_TOOL_WHITELIST.includes(t.name))
    if (allowed.length > 0) {
      openaiTools = allowed.map((t) => ({
        type: 'function',
        function: {
          name: _toOpenAIToolName(t.name),
          description: typeof t.description === 'string' ? t.description.slice(0, 1024) : '',
          parameters: t.schema && typeof t.schema === 'object'
            ? t.schema
            : { type: 'object', properties: {} },
        },
      }))
    }
  } catch (toolListErr) {
    console.warn('[Anya] Could not assemble chat-time tool list:', toolListErr?.message)
    openaiTools = undefined
  }

  // 1) Try OpenAI first (if configured)
  if (openai) {
    try {
      log.info('[Anya] Calling OpenAI API with model:', DEFAULT_ASSISTANT_MODEL, openaiTools ? `(tools=${openaiTools.length})` : '(tools=disabled)')

      // Tool-calling loop. We cap iterations so a misbehaving model
      // cannot pin the chat thread in a forever-loop of tool calls.
      // 4 iterations is enough for: ask → tool (confirmation) → user
      // can't speak inside a single request, so the second invocation
      // (with confirmed:true) typically arrives in a *separate* user
      // turn. Most chats finish in 1–2 iterations.
      const MAX_TOOL_ITERATIONS = 4
      let workingMessages = [
        { role: 'system', content: systemPrompt },
        ...conversationMessages,
      ]
      let finalReply = null

      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter += 1) {
        const response = await openAIBreaker.exec(
          async () =>
            await openai.chat.completions.create({
              model: DEFAULT_ASSISTANT_MODEL,
              messages: workingMessages,
              ...(openaiTools ? { tools: openaiTools, tool_choice: 'auto' } : {}),
              temperature: 0.3,
              max_tokens: 1000,
            }),
          {
            shouldTrip: (err) => {
              const summary = summarizeOpenAIError(err)
              if (summary.isAuth || summary.isRateLimit) return true
              const status = summary.status
              return (status === null || status === undefined) || status >= 500
            },
          },
        )

        const choice = response.choices?.[0]?.message
        if (!choice) break

        const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : []
        if (toolCalls.length === 0) {
          finalReply = (choice.content || '').trim() || null
          break
        }

        // Capture the assistant turn that requested tool calls so the
        // next round has the full conversation history.
        workingMessages.push({
          role: 'assistant',
          content: choice.content ?? '',
          tool_calls: toolCalls,
        })

        for (const call of toolCalls) {
          const openaiName = call?.function?.name || ''
          const registryName = _fromOpenAIToolName(openaiName)
          let toolPayload
          try {
            const rawArgs = call?.function?.arguments
            let parsedArgs = {}
            if (typeof rawArgs === 'string' && rawArgs.trim()) {
              try {
                parsedArgs = JSON.parse(rawArgs)
              } catch (parseErr) {
                throw new Error(`Could not parse tool arguments JSON: ${parseErr.message}`)
              }
            } else if (rawArgs && typeof rawArgs === 'object') {
              parsedArgs = rawArgs
            }
            // Inject the active profileId when the model forgot it —
            // every chat-whitelisted tool is profile-scoped, and forcing
            // the active profile prevents the LLM from accidentally
            // crossing profiles.
            if (parsedArgs && typeof parsedArgs === 'object') {
              if (!parsedArgs.profileId && activeProfileId) {
                parsedArgs.profileId = activeProfileId
              }
              if (!parsedArgs.profile_id && activeProfileId) {
                parsedArgs.profile_id = activeProfileId
              }
            }
            const invoked = await invokeRegisteredTool(registryName, parsedArgs, {
              ctx: user,
              user,
              db,
              sessionId,
              profileId: activeProfileId,
              pageContext: pageContext ?? null,
              currentPage: currentPage ?? null,
            })
            toolPayload = invoked?.output ?? invoked ?? null
          } catch (toolErr) {
            const status = toolErr?.status ?? null
            toolPayload = {
              error: true,
              status,
              message: toolErr?.message ? String(toolErr.message).slice(0, 800) : 'tool_error',
              tool: registryName,
            }
            console.warn('[Anya] chat tool call failed:', { tool: registryName, status, message: toolPayload.message })
          }
          let serializedPayload = ''
          try {
            serializedPayload = JSON.stringify(toolPayload)
          } catch {
            serializedPayload = String(toolPayload ?? '')
          }
          if (serializedPayload.length > 8000) {
            serializedPayload = `${serializedPayload.slice(0, 8000)}…[truncated]`
          }
          workingMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: openaiName,
            content: serializedPayload,
          })
        }
        // Loop continues — the next iteration lets the model react to
        // the tool results (e.g. summarise the commit, ask for
        // confirmation, retry with adjusted args).
      }

      if (finalReply) {
        log.info('[Anya] OpenAI API response received successfully')
        return finalReply
      }
      log.warn('[Anya] OpenAI tool-calling loop exhausted without a textual reply')
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
            model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
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
        model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
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

export async function invokeTool(db, user, toolName, params, { sessionId, internalBaseUrl, pageContext, currentPage } = {}) {
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

  // Phase 8 mission rule: Anya tools must be page-aware. Forward the live
  // page snapshot + current page name so anya.nextBestAction and any future
  // tool can ground its response in what the user is actually looking at.
  const result = await invokeRegisteredTool(toolName, params, {
    ctx: user,
    user,
    db,
    sessionId,
    internalBaseUrl,
    profileId: user?.activeProfileId ?? user?.profile_id ?? null,
    uploadDir,
    getOpenAI,
    pageContext: pageContext ?? null,
    currentPage: currentPage ?? null,
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
