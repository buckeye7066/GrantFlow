import path from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import {
  generateMedicalNecessityDocument,
  extractMedicalProfile,
  scanPipelineForMedNec,
  DOCUMENT_TYPES,
} from './medicalNecessity.js'
import {
  adminCodeCrawl,
  adminCodeLint,
  adminCodeAnalyze,
  adminCodeEdit,
  adminCodeScan,
  adminCrawlerList,
  adminCrawlerRun,
  adminCrawlerCheck,
  adminCrawlerRetry,
  adminCrawlerCancel,
  adminFunctionsTest,
  adminFunctionsDiagnose,
  adminDbQuery,
  adminDbStats,
  adminHealthCheck,
  adminHealthLogs,
} from './anyaAdminTools.js'
import {
  storeMemory,
  getMemory,
  getMemories,
  deleteMemory,
  getBrainSummary,
  trackToolUsage,
  getToolUsageStats,
  cleanupBrain,
  SCOPES,
  MEMORY_TYPES,
} from './anyaBrainService.js'
import { getSystemDiagnostics, analyzeSystemHealth } from './diagnosticsService.js'
import {
  runAutonomousCodeCrawl,
  getAutonomousStatus,
} from './anyaAutonomousCrawler.js'
import {
  runAutonomousCrawlers,
  saveCrawlerResultsToGlobal,
  getAutonomousCrawlersStatus,
} from './anyaAutonomousFunctionRunner.js'
import { discoverNewCatalogItems } from './itemCatalogService.js'
import {
  runAutonomousFunctionTests,
  testButtonFunctionality,
  getAutonomousFunctionTestsStatus,
} from './anyaAutonomousFunctionTesting.js'
import { getBackgroundCodeCrawlState } from './anyaAutonomousScheduler.js'
import { runMissionAudit } from './missionAuditService.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { normalizeState, statesMatch } from '../utils/stateNormalization.js'
import { scoreOpportunity } from './matchEngine.js'
import { syncProfileFieldsFromSection } from '../utils/profileSectionSync.js'

const tools = new Map()

const REPO_ROOT = path.resolve(process.cwd())
const SEARCH_ROOTS = [
  path.resolve(REPO_ROOT, 'backend'),
  path.resolve(REPO_ROOT, 'src'),
  path.resolve(REPO_ROOT, 'scripts'),
]
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.cursor',
  '.idea',
  '.vscode',
  'tmp-seed',
  'terminal_files_information',
])
const ALLOWED_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.json',
  '.md',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.sql',
])
const MAX_FILE_BYTES = 350_000
const DEFAULT_GRANT_LIMIT = 5
// Match scoring - no base score, must earn points through actual matches
function safeParseJSON(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function cleanList(list, max = 3) {
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, max)
}

function findMatchingCategories(oppCategories, profileCategories) {
  if (!oppCategories || oppCategories.length === 0 || !profileCategories || profileCategories.length === 0) {
    return []
  }

  // v4: Use word-boundary-aware matching to prevent false positives.
  // Previously "care" would match "healthcare" and "cat" would match "education".
  // Now we require either exact match or that the substring is a complete word boundary.
  return oppCategories.filter(c => {
    const cLower = c.toLowerCase().trim()
    return profileCategories.some(pc => {
      const pcLower = pc.toLowerCase().trim()
      if (cLower === pcLower) return true
      // Only allow substring match if the shorter string is at least 4 chars
      // and appears as a word boundary in the longer string
      if (pcLower.length >= 4 && cLower.length >= 4) {
        const shorter = cLower.length <= pcLower.length ? cLower : pcLower
        const longer = cLower.length <= pcLower.length ? pcLower : cLower
        const rx = new RegExp(`\\b${shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
        return rx.test(longer)
      }
      return false
    })
  })
}

function generateMatchReasons(opp, profile) {
  const reasons = []

  // Location match — v4: use normalizeState for robust comparison
  if (opp.state && profile?.state) {
    if (statesMatch(opp.state, profile.state)) {
      reasons.push(`Location match: Both in ${normalizeState(opp.state) || opp.state}`)
    }
  } else if (opp.is_national || opp.state === 'nationwide') {
    reasons.push('Available nationwide')
  }
  
  // Category alignment
  const oppCategories = cleanList(safeParseJSON(opp.categories, []), 10)
  const profileCategories = cleanList(safeParseJSON(profile?.categories, []), 10)
  const matchingCategories = findMatchingCategories(oppCategories, profileCategories)
  if (matchingCategories.length > 0) {
    reasons.push(`Category alignment: ${matchingCategories.slice(0, 2).join(', ')}`)
  }
  
  // Organization type / eligibility
  if (profile?.organization_type) {
    const eligibility = cleanList(safeParseJSON(opp.eligibility_bullets, []), 10)
    const hasMatch = eligibility.some(e => 
      e.toLowerCase().includes(profile.organization_type.toLowerCase())
    )
    if (hasMatch) {
      reasons.push(`Eligibility fit: Accepts ${profile.organization_type} organizations`)
    }
  }
  
  // Check for special profile attributes
  if (profile?.serves_veterans && opp.keywords) {
    const keywords = cleanList(safeParseJSON(opp.keywords, []), 20)
    if (keywords.some(k => k.toLowerCase().includes('veteran'))) {
      reasons.push('Serves veterans - matching funder priority')
    }
  }
  
  if (profile?.serves_disabled && opp.keywords) {
    const keywords = cleanList(safeParseJSON(opp.keywords, []), 20)
    if (keywords.some(k => k.toLowerCase().includes('disabilit'))) {
      reasons.push('Serves individuals with disabilities - matching funder focus')
    }
  }
  
  return reasons
}

function generateFitExplanation(opp, profile, matchReasons) {
  if (matchReasons.length === 0) {
    return 'This opportunity may be relevant based on general criteria.'
  }
  
  const primaryReason = matchReasons[0]
  const oppType = opp.opportunity_type || 'grant'
  const sponsor = opp.sponsor || 'this funder'
  
  let explanation = `This ${oppType} is a strong match because `
  
  if (primaryReason.includes('Location match')) {
    explanation += `your organization operates in the same geographic area that ${sponsor} serves. `
  } else if (primaryReason.includes('Category alignment')) {
    explanation += `your organization's focus areas align with ${sponsor}'s funding priorities. `
  } else {
    explanation += `it aligns with your organization's profile. `
  }
  
  if (matchReasons.length > 1) {
    explanation += `Additionally, ${matchReasons.slice(1).join(', ').toLowerCase()}.`
  }
  
  return explanation
}

function formatAmountRange(min, max, description) {
  if (description && description.trim()) return description.trim()
  const hasMin = typeof min === 'number' && Number.isFinite(min)
  const hasMax = typeof max === 'number' && Number.isFinite(max)
  if (hasMin && hasMax) {
    if (min === max) return `$${min.toLocaleString('en-US')}`
    return `$${min.toLocaleString('en-US')} - $${max.toLocaleString('en-US')}`
  }
  if (hasMin) return `From $${min.toLocaleString('en-US')}`
  if (hasMax) return `Up to $${max.toLocaleString('en-US')}`
  return null
}

function daysUntil(deadline) {
  if (!deadline) return null
  const deadlineDate = new Date(deadline)
  if (Number.isNaN(deadlineDate.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const normalizedDeadline = new Date(deadlineDate)
  normalizedDeadline.setHours(0, 0, 0, 0)
  const diffMs = normalizedDeadline.getTime() - today.getTime()
  return Math.round(diffMs / (1000 * 60 * 60 * 24))
}

function ensureProfileAccess(ctx, profileId) {
  if (!profileId) return false
  if (!ctx || !ctx.userId) return false
  if (ctx.isAdmin) return true
  if (ctx.accessibleProfileIds instanceof Set) {
    return ctx.accessibleProfileIds.has(String(profileId))
  }
  return ctx.activeProfileId && String(ctx.activeProfileId) === String(profileId)
}

async function safeStat(targetPath) {
  try {
    return await fs.stat(targetPath)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return null
    }
    throw error
  }
}

function isUnderAllowedRoots(targetPath) {
  const normalized = path.resolve(targetPath)
  if (!normalized.startsWith(REPO_ROOT)) return false
  return SEARCH_ROOTS.some((root) => normalized.startsWith(root))
}

async function searchFile(filePath, queryRegex) {
  const relativePath = path.relative(REPO_ROOT, filePath)
  const stats = await safeStat(filePath)
  if (!stats || !stats.isFile()) return []
  if (stats.size > MAX_FILE_BYTES) return []

  const ext = path.extname(filePath).toLowerCase()
  if (ALLOWED_EXTENSIONS.size > 0 && !ALLOWED_EXTENSIONS.has(ext)) {
    return []
  }

  const buffer = await fs.readFile(filePath, 'utf8')
  const lines = buffer.split(/\r?\n/)
  const results = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (queryRegex.test(line)) {
      results.push({
        file: relativePath,
        line: index + 1,
        preview: line.trim().slice(0, 200),
      })
    }
  }

  return results
}

async function searchDirectory(dirPath, queryRegex, results, limit) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (results.length >= limit) break
    if (entry.name.startsWith('.')) continue
    if (IGNORED_DIRS.has(entry.name)) continue

    const entryPath = path.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      await searchDirectory(entryPath, queryRegex, results, limit)
    } else if (entry.isFile()) {
      const matches = await searchFile(entryPath, queryRegex)
      for (const match of matches) {
        results.push(match)
        if (results.length >= limit) break
      }
    }
  }
}

async function performCodeSearch({ query, scopePath, maxResults = 20 }) {
  const trimmedQuery = (query ?? '').trim()
  if (!trimmedQuery) {
    throw new Error('Search query is required')
  }

  const safeLimit = Math.max(1, Math.min(Number(maxResults) || 20, 100))
  const queryRegex = new RegExp(trimmedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  const results = []

  if (scopePath) {
    const resolvedScope = path.resolve(REPO_ROOT, scopePath)
    if (!isUnderAllowedRoots(resolvedScope)) {
      throw new Error('Scope path is outside of permitted directories')
    }
    const scopeStats = await safeStat(resolvedScope)
    if (!scopeStats) {
      throw new Error('Scope path not found')
    }
    if (scopeStats.isFile()) {
      const matches = await searchFile(resolvedScope, queryRegex)
      results.push(...matches.slice(0, safeLimit))
    } else if (scopeStats.isDirectory()) {
      await searchDirectory(resolvedScope, queryRegex, results, safeLimit)
    }
  } else {
    for (const root of SEARCH_ROOTS) {
      if (results.length >= safeLimit) break
      const rootStats = await safeStat(root)
      if (!rootStats || !rootStats.isDirectory()) continue
      await searchDirectory(root, queryRegex, results, safeLimit)
    }
  }

  return {
    query: trimmedQuery,
    scope: scopePath ? path.relative(REPO_ROOT, path.resolve(REPO_ROOT, scopePath)) : null,
    matches: results.slice(0, safeLimit),
  }
}

function collectGrantMatches(db, profileId, limit) {
  const activePredicate = db?.dialect === 'postgres' ? 'is_active = TRUE' : 'is_active = 1'
  const primary = db
    .prepare(
      `
        SELECT id, title, sponsor, deadline, amount_min, amount_max, amount_description,
               application_url, state, opportunity_type, requires_match, match_percentage,
               eligibility_bullets, categories, source, source_url, updated_at, match_reasons,
               description, regions, keywords, link_status
        FROM funding_opportunities
        WHERE ${activePredicate} AND profile_id = ?
          AND ${trustedOriginClause()}
          AND ${trustedSourceClause()}
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(profileId, limit)

  if (primary.length >= limit) {
    return primary
  }

  const seen = new Set(primary.map((opp) => opp.id))
  const remaining = limit - primary.length

  // v4 FIX: Fallback query now filters by profile state or national opportunities.
  // Previously this query had NO profile_id filter, causing "profile bleed" where
  // unrelated global opportunities would be shown to users.
  let profileState = null
  try {
    const profileRow = db.prepare('SELECT state FROM profiles WHERE id = ?').get(profileId)
    profileState = normalizeState(profileRow?.state)
  } catch { /* profiles table may not have state column */ }

  let fallback
  if (profileState) {
    fallback = db
      .prepare(
        `
          SELECT id, title, sponsor, deadline, amount_min, amount_max, amount_description,
                 application_url, state, opportunity_type, requires_match, match_percentage,
                 eligibility_bullets, categories, source, source_url, updated_at, match_reasons,
                 description, regions, keywords, link_status
          FROM funding_opportunities
          WHERE ${activePredicate}
            AND (state = ? OR state = 'nationwide' OR is_national = ${db?.dialect === 'postgres' ? 'TRUE' : '1'})
            AND ${trustedOriginClause()}
            AND ${trustedSourceClause()}
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(profileState, (remaining * 3) || remaining)
  } else {
    // No state known — only return national opportunities as fallback
    fallback = db
      .prepare(
        `
          SELECT id, title, sponsor, deadline, amount_min, amount_max, amount_description,
                 application_url, state, opportunity_type, requires_match, match_percentage,
                 eligibility_bullets, categories, source, source_url, updated_at, match_reasons,
                 description, regions, keywords, link_status
          FROM funding_opportunities
          WHERE ${activePredicate}
            AND (state = 'nationwide' OR is_national = ${db?.dialect === 'postgres' ? 'TRUE' : '1'})
            AND ${trustedOriginClause()}
            AND ${trustedSourceClause()}
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all((remaining * 3) || remaining)
  }

  const merged = [...primary]
  fallback.forEach((opp) => {
    if (merged.length >= limit) return
    if (seen.has(opp.id)) return
    seen.add(opp.id)
    merged.push(opp)
  })

  return merged
}

function formatGrantSummaries(opportunities, profile = null) {
  return opportunities.map((opp) => {
    const eligibility = cleanList(safeParseJSON(opp.eligibility_bullets, []))
    const categories = cleanList(safeParseJSON(opp.categories, []))
    const amountRange = formatAmountRange(opp.amount_min, opp.amount_max, opp.amount_description)
    const daysRemaining = daysUntil(opp.deadline)
    
    // Get or generate match reasons
    let matchReasons = cleanList(safeParseJSON(opp.match_reasons, []), 10)
    if (matchReasons.length === 0 && profile) {
      matchReasons = generateMatchReasons(opp, profile)
    }
    
    // Calculate match score
    let matchScore = null
    if (profile) {
      matchScore = scoreOpportunity(profile, opp).score
    }
    
    // Generate fit explanation
    let fitExplanation = null
    if (profile) {
      fitExplanation = generateFitExplanation(opp, profile, matchReasons)
    }

    return {
      id: opp.id,
      title: opp.title,
      sponsor: opp.sponsor,
      opportunity_type: opp.opportunity_type ?? 'grant',
      state: opp.state ?? null,
      deadline: opp.deadline ?? null,
      days_until_deadline: daysRemaining,
      amount_range: amountRange,
      requires_match: Boolean(opp.requires_match),
      match_percentage: typeof opp.match_percentage === 'number' ? opp.match_percentage : null,
      application_url: opp.application_url ?? opp.source_url ?? null,
      categories,
      eligibility_highlights: eligibility,
      source: opp.source ?? null,
      updated_at: opp.updated_at ?? null,
      match_score: matchScore,
      match_reasons: matchReasons,
      fit_explanation: fitExplanation,
      link_status: opp.link_status ?? 'unverified',
    }
  })
}

function summarizeGrants(db, params, context) {
  const ctx = context?.ctx
  const profileId =
    (params?.profile_id && String(params.profile_id).trim()) ||
    (ctx?.activeProfileId ? String(ctx.activeProfileId).trim() : '')

  if (!profileId) {
    throw new Error('profile_id is required to summarize grants')
  }
  if (!ensureProfileAccess(ctx, profileId)) {
    const error = new Error('Not authorized to view grants for this profile')
    error.status = 403
    throw error
  }

  const profile = db
    .prepare(
      `
        SELECT id, display_name, status, state, organization_type, 
               categories, serves_veterans, serves_disabled
        FROM profiles
        WHERE id = ?
      `,
    )
    .get(profileId)

  if (!profile) {
    throw new Error('Profile not found')
  }

  const limit = Math.max(1, Math.min(Number(params?.limit) || DEFAULT_GRANT_LIMIT, 10))
  const opportunities = collectGrantMatches(db, profileId, limit)
  const formatted = formatGrantSummaries(opportunities, profile)

  return {
    profile: {
      id: profile.id,
      display_name: profile.display_name,
      status: profile.status,
    },
    count: formatted.length,
    limit,
    opportunities: formatted,
  }
}

export function registerTool({ name, description, schema, handler, requiresAdmin = false }) {
  if (!name || typeof name !== 'string') {
    throw new Error('Tool name required')
  }
  if (typeof handler !== 'function') {
    throw new Error('Tool handler must be a function')
  }

  // Duplicate ids silently overwrote each other before, which the mission
  // audit flagged as a tool-registry overlap root problem. Make the
  // collision loud so bootstraps fail fast instead of shipping a registry
  // where the "last registration wins" outcome depends on module load
  // order.
  if (tools.has(name)) {
    const err = new Error(
      `Duplicate Anya tool id "${name}" — each tool id must register exactly once.`
    )
    err.status = 500
    throw err
  }

  tools.set(name, {
    name,
    description: description ?? '',
    schema: schema ?? null,
    handler,
    requiresAdmin: Boolean(requiresAdmin),
  })
}

/**
 * Startup assertion — throws if any tool id was registered more than once
 * at import time. Safe to call from server boot / health checks.
 */
export function assertNoDuplicateToolIds() {
  const seen = new Map()
  for (const name of tools.keys()) {
    const n = String(name).toLowerCase()
    if (seen.has(n)) {
      const err = new Error(
        `Anya tool registry contains duplicate id: "${name}" (also seen as "${seen.get(n)}")`
      )
      err.status = 500
      throw err
    }
    seen.set(n, name)
  }
  return tools.size
}

export function listToolMetadata(ctx = null) {
  const isAdmin = Boolean(ctx?.isAdmin)
  return Array.from(tools.values())
    .filter((tool) => !tool.requiresAdmin || isAdmin)
    .map(({ name, description, schema, requiresAdmin }) => ({
      name,
      description,
      schema,
      requiresAdmin,
    }))
}

export async function invokeTool(name, params, context) {
  if (!tools.has(name)) {
    const error = new Error(`Unknown tool "${name}"`)
    error.status = 404
    throw error
  }

  const tool = tools.get(name)

  // Check admin access: prefer the already-resolved ctx.isAdmin (DB-backed,
  // canonical from requestContext middleware) before falling back to a fresh DB lookup.
  if (tool.requiresAdmin) {
    const ctx = context?.ctx
    const user = context?.user
    const db = context?.db

    if (!user && !ctx) {
      const error = new Error(`Tool "${name}" requires admin privileges`)
      error.status = 403
      throw error
    }

    let isAdmin = ctx?.isAdmin === true
    if (!isAdmin && db && user) {
      const { isAdminUserWithDb } = await import('../utils/accessControl.js')
      try {
        isAdmin = await isAdminUserWithDb(db, user)
      } catch (error) {
        console.warn('[anyaToolRegistry] DB admin check failed, falling back to token:', error?.message)
        isAdmin = user.role === 'admin' || user.is_admin === true
      }
    }
    if (!isAdmin && user) {
      isAdmin = user.role === 'admin' || user.is_admin === true
    }

    if (!isAdmin) {
      const error = new Error(`Tool "${name}" requires admin privileges`)
      error.status = 403
      throw error
    }

    // Log admin tool invocation for audit
    try {
      const userId = user?.userId ?? user?.id ?? null
      const profileId = context?.profile_id ?? context?.profileId ?? null
      logAuditEvent(db, {
        category: AUDIT_CATEGORIES.ANYA,
        action: 'tool.invoke',
        severity: SEVERITY.INFO,
        userId,
        profileId,
        resourceType: 'anya_tool',
        resourceId: String(name),
        details: {
          tool: String(name),
          requires_admin: true,
          params: params ?? {},
        },
        ipAddress: context?.ip ?? context?.headers?.['x-forwarded-for'] ?? null,
        userAgent: context?.headers?.['user-agent'] ?? null,
      })
    } catch (error) {
      // Never block tool execution on audit failures.
      console.warn('[anyaToolRegistry] failed to write audit log:', error?.message || error)
    }
  }

  // Record the invocation in anya_tool_usage regardless of outcome.
  // The admin.brain.stats / admin.diagnostics checks read from this table to
  // verify Anya is actually being exercised; before this hook the table stayed
  // empty, which triggered mission goal 15 (Anya grounding) to FAIL.
  const startedAt = Date.now()
  let ok = true
  let errorMessage = null
  let result
  try {
    result = await tool.handler(params ?? {}, context ?? {})
    return {
      id: randomUUID(),
      tool: tool.name,
      output: result,
    }
  } catch (err) {
    ok = false
    errorMessage = err?.message ? String(err.message).slice(0, 500) : String(err).slice(0, 500)
    throw err
  } finally {
    try {
      const db = context?.db
      if (db && typeof db.prepare === 'function') {
        const user = context?.user || {}
        await db
          .prepare(
            `INSERT INTO anya_tool_usage
               (id, tool_name, session_id, user_id, profile_id, parameters, success, error_message, execution_time_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomUUID(),
            String(name),
            context?.sessionId ?? context?.session_id ?? null,
            user.userId ?? user.id ?? null,
            context?.profile_id ?? context?.profileId ?? null,
            JSON.stringify(params ?? {}).slice(0, 4000),
            ok ? 1 : 0,
            errorMessage,
            Date.now() - startedAt,
          )
      }
    } catch (persistErr) {
      // Never block tool execution on usage-log failures; warn once.
      // eslint-disable-next-line no-console
      console.warn('[anyaToolRegistry] failed to log anya_tool_usage:', persistErr?.message || persistErr)
    }
  }
}

registerTool({
  name: 'noop.echo',
  description: 'Echoes the provided input back to the caller. Useful for smoke testing tool pipelines.',
  schema: {
    type: 'object',
    properties: {
      message: { type: 'string' },
    },
    required: ['message'],
  },
  handler: async ({ message }) => ({
    echoed: String(message ?? ''),
    timestamp: new Date().toISOString(),
  }),
})

registerTool({
  name: 'code.search',
  description:
    'Search the repository for a case-insensitive text match across backend/, src/, and scripts/. Limited to safe file types.',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      scope: { type: 'string', description: 'Optional relative path to narrow the search.' },
      max_results: { type: 'integer', minimum: 1, maximum: 100 },
    },
    required: ['query'],
  },
  handler: async ({ query, scope, max_results }) =>
    performCodeSearch({
      query,
      scopePath: scope,
      maxResults: max_results,
    }),
})

registerTool({
  name: 'code.suggestPatch',
  description:
    'Generate a unified diff patch suggestion for a file. This tool does NOT apply changes; it only returns patch text.',
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Relative path under backend/, src/, or scripts/.' },
      instructions: { type: 'string', description: 'What you want changed and why.' },
      max_input_chars: { type: 'integer', minimum: 500, maximum: 50000 },
    },
    required: ['file', 'instructions'],
  },
  handler: async ({ file, instructions, max_input_chars }, context) => {
    const filePath = String(file || '').trim()
    if (!filePath) throw new Error('file is required')
    const resolved = path.resolve(REPO_ROOT, filePath)
    if (!isUnderAllowedRoots(resolved)) {
      const error = new Error('File path is outside of permitted directories')
      error.status = 400
      throw error
    }
    const stats = await safeStat(resolved)
    if (!stats || !stats.isFile()) {
      const error = new Error('File not found')
      error.status = 404
      throw error
    }

    const maxChars = Math.max(500, Math.min(Number(max_input_chars) || 12000, 50000))
    const original = await fs.readFile(resolved, 'utf8')
    const truncated = original.length > maxChars ? `${original.slice(0, maxChars)}\n/* ... truncated ... */\n` : original

    const getOpenAI = context?.getOpenAI
    const openai = typeof getOpenAI === 'function' ? getOpenAI() : null
    if (!openai) {
      const error = new Error('OpenAI client not configured for code.suggestPatch')
      error.status = 503
      throw error
    }

    const system = [
      'You are a code advisor.',
      'Return ONLY a unified diff patch (no markdown, no explanations).',
      'The diff must apply cleanly to the provided file and include correct file paths.',
      `Target file: ${filePath}`,
    ].join('\n')

    const userPrompt = [
      `Instructions:\n${String(instructions || '').trim()}`,
      '',
      'Current file contents:',
      truncated,
    ].join('\n')

    const response = await openai.chat.completions.create({
      model: process.env.ANYA_OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    })

    const patch = response?.choices?.[0]?.message?.content ?? ''
    return {
      file: filePath,
      patch: String(patch || '').trim(),
      truncated: original.length > maxChars,
    }
  },
})

registerTool({
  name: 'grants.summarizeMatches',
  description: 'Summarises and explains the most recently matched funding opportunities for a specific profile, including why each one matched.',
  schema: {
    type: 'object',
    properties: {
      profile_id: { type: 'string', description: 'Profile identifier to summarise.' },
      limit: { type: 'integer', minimum: 1, maximum: 10 },
    },
  },
  handler: async (params, context) => {
    if (!context?.db) {
      throw new Error('Database connection unavailable')
    }
    return summarizeGrants(context.db, params, context)
  },
})

registerTool({
  name: 'grants.explainMatch',
  description: "Explains why a specific funding opportunity matched (or didn't fully match) the user's profile. Returns a breakdown of matching signals like applicant type, location, keywords, and financial need.",
  schema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', description: 'The ID of the funding opportunity to explain.' },
      profileId: { type: 'string', description: 'The profile ID to explain the match for.' },
    },
    required: ['opportunityId', 'profileId'],
  },
  handler: async (params, context) => {
    if (!context?.db) {
      throw new Error('Database connection unavailable')
    }
    const db = context.db
    const ctx = context?.ctx

    const opportunityId = String(params?.opportunityId || '').trim()
    const profileId = String(params?.profileId || '').trim()

    if (!opportunityId) throw new Error('opportunityId is required')
    if (!profileId) throw new Error('profileId is required')

    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }

    const opp = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(opportunityId)
    if (!opp) {
      const error = new Error('Opportunity not found')
      error.status = 404
      throw error
    }

    const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) {
      const error = new Error('Profile not found')
      error.status = 404
      throw error
    }

    let sectionRows = []
    try {
      sectionRows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
    } catch (_e) { /* sections may not exist */ }
    const sections = sectionRows.reduce((acc, row) => {
      try { acc[row.section_key] = row.data ? JSON.parse(row.data) : {} } catch { acc[row.section_key] = {} }
      return acc
    }, {})

    // Helper to safely parse arrays
    const parseArr = (v) => {
      if (!v) return []
      if (Array.isArray(v)) return v
      try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
    }

    const matches = []
    const misses = []
    const neutral = []
    const basic = sections.basic_information ?? {}

    // Applicant type
    const profileType = profile.primary_type || basic.profile_category || null
    const oppTypes = parseArr(opp.applicant_types || opp.eligible_applicants)
    if (profileType && oppTypes.length > 0) {
      const typeMatch = oppTypes.some(t =>
        t?.toLowerCase().includes(profileType?.toLowerCase()) ||
        profileType?.toLowerCase().includes(t?.toLowerCase())
      )
      if (typeMatch) {
        matches.push({ signal: 'Applicant Type', detail: `Your profile type "${profileType}" matches eligible applicants: ${oppTypes.join(', ')}` })
      } else {
        misses.push({ signal: 'Applicant Type', detail: `Your profile type "${profileType}" may not match eligible applicants: ${oppTypes.join(', ')}. Check the opportunity details.` })
      }
    } else if (oppTypes.length === 0) {
      neutral.push({ signal: 'Applicant Type', detail: 'This opportunity does not specify applicant type restrictions.' })
    }

    // Location
    const profileState = basic.state || profile.state || null
    const oppState = opp.state || opp.location || null
    const oppScope = opp.geographic_scope || opp.scope || 'national'
    if (oppScope === 'national' || oppScope === 'federal') {
      matches.push({ signal: 'Location', detail: 'This is a national program available in all states.' })
    } else if (profileState && oppState) {
      if (oppState.toLowerCase().includes(profileState.toLowerCase()) || profileState.toLowerCase().includes(oppState.toLowerCase())) {
        matches.push({ signal: 'Location', detail: `Your state (${profileState}) matches this opportunity's location (${oppState}).` })
      } else {
        misses.push({ signal: 'Location', detail: `Your state (${profileState}) may not match this opportunity's location (${oppState}).` })
      }
    } else if (!profileState) {
      misses.push({ signal: 'Location', detail: 'Your profile does not have a state set. Adding your state may improve match accuracy.' })
    }

    // Keywords / categories
    const oppCategories = parseArr(opp.categories || opp.focus_areas)
    const profileKeywords = parseArr(profile.keywords || profile.interests)
    const profileFocusAreas = parseArr(sections.programs_services?.focus_areas)
    const allProfileTerms = [...profileKeywords, ...profileFocusAreas].map(t => t?.toLowerCase()).filter(Boolean)
    const oppTerms = oppCategories.map(t => t?.toLowerCase()).filter(Boolean)
    const matchedTerms = allProfileTerms.filter(pt => oppTerms.some(ot => ot.includes(pt) || pt.includes(ot)))
    if (matchedTerms.length > 0) {
      matches.push({ signal: 'Focus Areas / Keywords', detail: `Matched on: ${matchedTerms.join(', ')}` })
    } else if (oppCategories.length > 0 && allProfileTerms.length > 0) {
      neutral.push({ signal: 'Focus Areas / Keywords', detail: `Opportunity covers: ${oppCategories.join(', ')}. Your profile covers: ${allProfileTerms.slice(0, 5).join(', ')}. No direct keyword overlap.` })
    }

    // Financial need
    const belowPoverty = profile.below_poverty_line || sections.financial?.below_poverty_line
    if (opp.needs_based || oppCategories.some(c => ['financial_assistance', 'low_income'].includes(c))) {
      if (belowPoverty) {
        matches.push({ signal: 'Financial Need', detail: 'Your profile indicates financial need, which this needs-based program prioritizes.' })
      } else {
        neutral.push({ signal: 'Financial Need', detail: 'This program may prioritize financial need. Adding income information could improve match accuracy.' })
      }
    }

    const matchScore = opp.match_score ?? opp.score ?? null
    const scoreContext = matchScore !== null
      ? matchScore >= 70 ? 'Strong match' : matchScore >= 40 ? 'Moderate match' : 'Weak match'
      : null

    return {
      opportunityId: opp.id,
      opportunityName: opp.name || opp.title,
      matchScore,
      scoreContext,
      matches,
      misses,
      neutral,
      summary: matches.length > 0
        ? `This opportunity matched your profile on ${matches.length} signal(s): ${matches.map(m => m.signal).join(', ')}.`
        : 'No strong match signals found. Review the opportunity details to determine eligibility manually.',
    }
  },
})

registerTool({
  name: 'grants.profileSectionImpact',
  description: 'Explains which profile sections are filled in, which are empty, and what kinds of funding opportunities completing each empty section would unlock.',
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile ID to analyze.' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    if (!context?.db) {
      throw new Error('Database connection unavailable')
    }
    const db = context.db
    const ctx = context?.ctx

    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')

    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }

    const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
    if (!profile) {
      const error = new Error('Profile not found')
      error.status = 404
      throw error
    }

    let sectionRows = []
    try {
      sectionRows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
    } catch (_e) { /* sections may not exist */ }
    const sections = sectionRows.reduce((acc, row) => {
      try { acc[row.section_key] = row.data ? JSON.parse(row.data) : {} } catch { acc[row.section_key] = {} }
      return acc
    }, {})

    const filled = []
    const missing = []

    // Applicant type
    const profileType = profile.primary_type || sections.basic_information?.profile_category || null
    if (profileType) {
      filled.push({ section: 'Applicant Type', value: profileType })
    } else {
      missing.push({
        section: 'Applicant Type',
        field: 'primary_type / basic_information.profile_category',
        impact: 'Setting your profile type is required for most matching. Without it, many eligibility filters cannot apply.',
      })
    }

    // Location / state
    const profileState = sections.basic_information?.state || profile.state || null
    const profileZip = sections.basic_information?.zip_code || profile.postal_code || profile.zip_code || null
    if (profileState || profileZip) {
      filled.push({ section: 'Location', value: [profileState, profileZip].filter(Boolean).join(', ') })
    } else {
      missing.push({
        section: 'Location',
        field: 'basic_information.state / basic_information.zip_code',
        impact: 'Adding your state or ZIP code unlocks state-specific and regional programs that may not appear in your results.',
      })
    }

    // Focus areas / programs
    const focusAreas = sections.programs_services?.focus_areas
    const hasFocusAreas = Array.isArray(focusAreas) ? focusAreas.length > 0 : Boolean(focusAreas)
    if (hasFocusAreas) {
      filled.push({ section: 'Programs & Focus Areas', value: Array.isArray(focusAreas) ? focusAreas.slice(0, 3).join(', ') : String(focusAreas) })
    } else {
      missing.push({
        section: 'Programs & Focus Areas',
        field: 'programs_services.focus_areas',
        impact: 'Adding focus areas helps match you to thematic grants (e.g., education, housing, health) and improves keyword overlap scoring.',
      })
    }

    // Narrative / primary goal
    const primaryGoal = sections.narrative?.primary_goal || null
    if (primaryGoal) {
      filled.push({ section: 'Primary Goal / Mission', value: String(primaryGoal).slice(0, 80) })
    } else {
      missing.push({
        section: 'Primary Goal / Mission',
        field: 'narrative.primary_goal',
        impact: "Adding your goals helps Anya recommend more targeted opportunities and generate stronger proposal drafts.",
      })
    }

    // Financial information
    const hasFinancial = sections.financial && Object.keys(sections.financial).length > 0
    if (hasFinancial) {
      filled.push({ section: 'Financial Information', value: 'Provided' })
    } else {
      missing.push({
        section: 'Financial Information',
        field: 'financial (income, below_poverty_line, etc.)',
        impact: 'Adding income information unlocks needs-based programs and financial assistance grants that filter by income eligibility.',
      })
    }

    const completionPct = Math.round((filled.length / (filled.length + missing.length)) * 100)

    return {
      profileId,
      profileName: profile.display_name || profile.name || null,
      completionPercent: completionPct,
      filledSections: filled,
      missingSections: missing,
      summary: missing.length === 0
        ? 'Your profile is fully filled out. All matching signals are active.'
        : `Your profile is ${completionPct}% complete. Completing ${missing.length} section(s) would improve match accuracy: ${missing.map(m => m.section).join(', ')}.`,
    }
  },
})

// ============================================================================
// Profile guided completion tool
// ============================================================================

registerTool({
  name: 'profile.updateSection',
  description: 'Update a specific profile section with data gathered from conversation. Use this when the user provides information about themselves (location, finances, health, employment, etc.) and you want to save it to their profile. Merge-safe: only provided fields are updated; existing data is preserved.',
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile ID to update.' },
      sectionKey: {
        type: 'string',
        description: 'The section to update. Valid keys: basic_information, organization_details, financial_information, government_assistance, health_medical, demographics, family_life, military_service, occupation, location_focus, education, employment, housing, family, programs_services, narrative, small_business_details, nonprofit_compliance.',
      },
      fields: {
        type: 'object',
        description: 'Key-value pairs to save into the section. Only provided fields are updated; existing fields are preserved.',
      },
    },
    required: ['profileId', 'sectionKey', 'fields'],
  },
  handler: async (params, context) => {
    if (!context?.db) throw new Error('Database connection unavailable')
    const db = context.db
    const ctx = context?.ctx

    const profileId = String(params?.profileId || '').trim()
    const sectionKey = String(params?.sectionKey || '').trim()
    const fields = params?.fields

    if (!profileId) throw new Error('profileId is required')
    if (!sectionKey) throw new Error('sectionKey is required')
    if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
      throw new Error('fields must be a non-empty object')
    }

    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to update this profile')
      error.status = 403
      throw error
    }

    const profile = await db.prepare('SELECT id FROM profiles WHERE id = ?').get(profileId)
    if (!profile) {
      const error = new Error('Profile not found')
      error.status = 404
      throw error
    }

    // Read existing section data and merge
    let existingData = {}
    try {
      const row = await db.prepare('SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?').get(profileId, sectionKey)
      if (row?.data) existingData = JSON.parse(row.data)
    } catch { /* section may not exist yet */ }

    const merged = { ...existingData, ...fields }

    const updatedBy = ctx?.email || ctx?.userId || 'anya-guided'
    await db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(profileId, sectionKey, JSON.stringify(merged), updatedBy)

    // v4: Sync key fields (state, veteran, disability) to profiles table
    try {
      syncProfileFieldsFromSection(db, profileId, sectionKey, merged)
    } catch (syncErr) {
      console.warn(`[anya] Section sync failed for ${profileId}/${sectionKey}:`, syncErr?.message)
    }

    // Count total filled sections for progress
    const allSections = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
    let filledCount = 0
    for (const s of allSections) {
      try {
        const d = JSON.parse(s.data || '{}')
        const hasValue = Object.values(d).some((v) =>
          v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
        )
        if (hasValue) filledCount++
      } catch { /* skip */ }
    }

    return {
      saved: true,
      sectionKey,
      fieldsUpdated: Object.keys(fields),
      profileCompletion: `${filledCount} of ${allSections.length} sections have data`,
      hint: filledCount < 8
        ? 'Ask the user about their next most impactful section to keep improving matches.'
        : 'Profile is well-filled. Suggest running Discovery to see updated matches.',
    }
  },
})

registerTool({
  name: 'profile.getCompletionStatus',
  description: 'Check which profile sections are filled and which are empty. Use this to decide what to ask the user about next.',
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile ID to check.' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    if (!context?.db) throw new Error('Database connection unavailable')
    const db = context.db
    const ctx = context?.ctx

    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')

    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }

    const profile = await db.prepare('SELECT primary_type FROM profiles WHERE id = ?').get(profileId)
    if (!profile) throw new Error('Profile not found')

    const rows = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
    const filled = []
    const empty = []

    for (const row of rows) {
      let d = {}
      try { d = JSON.parse(row.data || '{}') } catch { /* skip */ }
      const hasValue = Object.values(d).some((v) =>
        v !== null && v !== undefined && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0)
      )
      if (hasValue) {
        filled.push(row.section_key)
      } else {
        empty.push(row.section_key)
      }
    }

    // Priority order for what to fill next based on matching impact
    const impactOrder = [
      'basic_information', 'financial_information', 'health_medical',
      'government_assistance', 'demographics', 'employment', 'housing',
      'education', 'family_life', 'military_service', 'narrative',
    ]
    const suggestedNext = impactOrder.filter((k) => empty.includes(k)).slice(0, 3)

    return {
      profileType: profile.primary_type,
      filledSections: filled,
      emptySections: empty,
      completionPct: rows.length > 0 ? Math.round((filled.length / rows.length) * 100) : 0,
      suggestedNext,
      guidance: suggestedNext.length > 0
        ? `Ask the user about: ${suggestedNext.join(', ')}. These have the most impact on matching.`
        : 'Profile is well-filled. Suggest running Discovery.',
    }
  },
})

// ============================================================================
// Admin-only tools
// ============================================================================

// Code Analysis & Auto-Fix Tools
registerTool({
  name: 'admin.code.crawl',
  description: 'Deep scan the codebase for patterns, potential errors, and anti-patterns. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Optional regex pattern to search for' },
      directory: { type: 'string', description: 'Optional directory to scan (relative to repo root)' },
      includeTests: { type: 'boolean', description: 'Include test files in scan' },
    },
  },
  handler: adminCodeCrawl,
})

registerTool({
  name: 'admin.code.lint',
  description: 'Run ESLint-style checks and report issues. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to file or directory to lint' },
      fix: { type: 'boolean', description: 'Attempt to fix issues automatically' },
    },
  },
  handler: async (params, context) => {
    return adminCodeLint({ targetPath: params.path, fix: params.fix }, context)
  },
})

registerTool({
  name: 'admin.code.analyze',
  description: 'Analyze a specific file for issues and suggest fixes. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to file to analyze' },
    },
    required: ['filePath'],
  },
  handler: adminCodeAnalyze,
})

registerTool({
  name: 'admin.code.edit',
  description: 'Propose or apply edits to a specific file. Set save=true to apply changes with automatic backup. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Path to file to edit' },
      changes: {
        type: 'array',
        description: 'Array of change objects',
        items: {
          type: 'object',
          properties: {
            line: { type: 'integer', description: 'Line number' },
            oldText: { type: 'string', description: 'Text to replace' },
            newText: { type: 'string', description: 'Replacement text' },
          },
          required: ['line', 'oldText', 'newText'],
        },
      },
      save: { type: 'boolean', description: 'If true, apply changes and save file (creates backup first). Default: false' },
    },
    required: ['filePath', 'changes'],
  },
  handler: adminCodeEdit,
})

registerTool({
  name: 'admin.code.scan',
  description: 'Scan the codebase for TODOs, console.logs, debugger statements, and other issues. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Directory to scan (default: entire repo)' },
      filePattern: { type: 'string', description: 'File pattern to match (default: "*.js")' },
      issueTypes: {
        type: 'array',
        items: { type: 'string', enum: ['todo', 'console', 'debugger', 'fixme', 'hack', 'all'] },
        description: 'Types of issues to find',
      },
    },
  },
  handler: (params, context) => adminCodeScan({ directory: params.directory, filePattern: params.filePattern, issueTypes: params.issueTypes }, context),
})
registerTool({
  name: 'admin.crawler.list',
  description: 'Explains crawler job status to the user — lists all crawler jobs and their current state. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      type: { type: 'string', description: 'Filter by crawler type' },
    },
  },
  handler: adminCrawlerList,
})

registerTool({
  name: 'admin.crawler.run',
  description: 'Explains to the user what a crawler run does, then triggers the requested crawler type. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [
          'local',
          'scholarship',
          'curated_benefits',
          'comprehensive',
          'item_search',
          'avatar_lookup',
          'document_ingest',
          'pipeline_automation',
          'profile_enrichment',
        ],
      },
      profileId: { type: 'string', description: 'Profile ID to run crawler for' },
      parameters: { type: 'object', description: 'Additional crawler parameters' },
    },
    required: ['type'],
  },
  handler: adminCrawlerRun,
})

registerTool({
  name: 'admin.crawler.check',
  description: 'Explains crawler output quality to the user — validates crawler outputs and surfaces any errors from recent jobs. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Specific job ID to check' },
      lastN: { type: 'integer', minimum: 1, maximum: 50, description: 'Check last N jobs' },
    },
  },
  handler: adminCrawlerCheck,
})

registerTool({
  name: 'admin.crawler.retry',
  description: 'Retry a failed crawler job. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job ID to retry' },
    },
    required: ['jobId'],
  },
  handler: adminCrawlerRetry,
})

registerTool({
  name: 'admin.crawler.cancel',
  description: 'Cancel a running crawler job. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Job ID to cancel' },
      reason: { type: 'string', description: 'Reason for cancellation' },
    },
    required: ['jobId'],
  },
  handler: adminCrawlerCancel,
})

// App Function Execution & Diagnostics
registerTool({
  name: 'admin.functions.test',
  description: 'Execute a backend endpoint/function and capture results. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'API route to test' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      body: { type: 'object', description: 'Request body' },
    },
    required: ['route'],
  },
  handler: adminFunctionsTest,
})

registerTool({
  name: 'admin.functions.diagnose',
  description: 'Run a function with detailed error tracing. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      route: { type: 'string', description: 'API route to diagnose' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      body: { type: 'object', description: 'Request body' },
    },
    required: ['route'],
  },
  handler: adminFunctionsDiagnose,
})

// Database & System Tools
registerTool({
  name: 'admin.db.query',
  description: 'Run read-only SQL queries for diagnostics (SELECT only). Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'SELECT query to execute' },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['sql'],
  },
  handler: adminDbQuery,
})

registerTool({
  name: 'admin.db.stats',
  description: 'Get database health statistics. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {},
  },
  handler: adminDbStats,
})

// Health & Monitoring Tools
registerTool({
  name: 'admin.health.check',
  description: 'Full system health report. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {},
  },
  handler: adminHealthCheck,
})

registerTool({
  name: 'admin.health.logs',
  description: 'Get recent error/warning logs. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['error', 'warning', 'info', 'debug'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
      source: { type: 'string', description: 'Filter logs by source' },
    },
  },
  handler: adminHealthLogs,
})

// System Diagnostics Tool
registerTool({
  name: 'admin.diagnostics',
  description: 'Get comprehensive system diagnostics including database status, environment configuration, last activity, and recent errors. Use this to check system health before claiming everything is working. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, context) => {
    const { db } = context
    if (!db) {
      throw new Error('Database connection unavailable')
    }
    const diagnostics = await getSystemDiagnostics(db)
    const health = analyzeSystemHealth(diagnostics)
    return {
      ...diagnostics,
      health_analysis: health,
    }
  },
})

// System Health Tool - Compact version for Anya truth gate
registerTool({
  name: 'system.health',
  description: 'Get compact system health status with crawler stats, DB counts, and recent errors. Use this when user asks about system status, crawler health, or "is everything working". Returns truth-based status assessment.',
  requiresAdmin: false, // Available to all users but provides limited info for non-admins
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, context) => {
    const { db } = context
    if (!db) {
      return {
        status: 'ERROR',
        error: 'Database connection unavailable',
        issues: ['Database connection failed'],
      }
    }

    // For non-admin users, return safe summary only
    const isAdmin = Boolean(context?.ctx?.isAdmin)
    
    if (!isAdmin) {
      try {
        const { getSafeHealthSummary } = await import('./diagnosticsService.js')
        const safeSummary = await getSafeHealthSummary(db)
        return {
          status: safeSummary.status.toUpperCase(),
          counts: safeSummary.counts,
          summary: safeSummary.summary,
          is_admin: false,
        }
      } catch (error) {
        return {
          status: 'ERROR',
          error: error.message,
          issues: ['Failed to retrieve health information'],
        }
      }
    }

    // For admin users, return detailed diagnostics
    try {
      const diagnostics = await getSystemDiagnostics(db)
      const health = analyzeSystemHealth(diagnostics)

      // Get crawler stats from last 24 hours
      let crawlerStats = { totalRuns: 0, recentFailures: 0, lastRuns: [] }
      try {
        const since24hPredicate =
          db?.dialect === 'postgres'
            ? `created_at >= (NOW() - INTERVAL '24 hours')`
            : `created_at >= datetime('now', '-24 hours')`

        const last24h = await db
          .prepare(
            `
              SELECT type, status, created_at, error
              FROM crawler_jobs
              WHERE ${since24hPredicate}
              ORDER BY created_at DESC
              LIMIT 20
            `,
          )
          .all()

        crawlerStats.totalRuns = last24h.length
        crawlerStats.recentFailures = last24h.filter(j => j.status === 'failed').length
        crawlerStats.lastRuns = last24h.slice(0, 5).map(j => ({
          type: j.type,
          status: j.status,
          time: j.created_at,
          error: j.error || null
        }))
      } catch (err) {
        // Ignore crawler stats errors
      }

      // Get last error
      let lastError = null
      if (diagnostics.errors && diagnostics.errors.length > 0) {
        const err = diagnostics.errors[0]
        lastError = {
          crawler: err.crawler_type || err.source || 'unknown',
          message: err.message,
          time: err.time
        }
      }

      // Determine status
      let status = 'HEALTHY'
      if (health.status === 'unhealthy' || !diagnostics.db.ok) {
        status = 'ERROR'
      } else if (health.status === 'degraded' || diagnostics.db.tables.funding_opportunities === 0 || crawlerStats.recentFailures > 0) {
        status = health.warnings.length > 0 ? 'WARNING' : 'DEGRADED'
      }

      return {
        status,
        counts: {
          opportunities: diagnostics.db.tables?.funding_opportunities || 0,
          profiles: diagnostics.db.tables?.profiles || 0,
          crawl_logs: diagnostics.db.tables?.crawl_logs || 0,
        },
        crawler_stats: crawlerStats,
        env_flags: {
          OPENAI_API_KEY_present: diagnostics.env_flags?.OPENAI_API_KEY_present || false,
          ANTHROPIC_API_KEY_present: diagnostics.env_flags?.ANTHROPIC_API_KEY_present || false,
          SAM_GOV_API_KEY_present: diagnostics.env_flags?.SAM_GOV_API_KEY_present || false,
        },
        last_error: lastError,
        issues: health.issues,
        warnings: health.warnings,
        is_admin: true,
      }
    } catch (error) {
      return {
        status: 'ERROR',
        error: error.message,
        issues: ['Failed to retrieve system health'],
      }
    }
  },
})

// Enhanced Admin Crawler Tools
registerTool({
  name: 'admin.crawler.triggerAll',
  description: 'Trigger all crawler types for a given profile. Creates multiple crawler jobs at once. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile ID to run crawlers for' },
      crawlerTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['local', 'scholarship', 'curated_benefits', 'comprehensive', 'item_search', 'profile_enrichment', 'avatar_lookup', 'portal_check']
        },
        description: 'Array of crawler types to trigger (default: all)'
      },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    const { profileId, crawlerTypes } = params
    const { db } = context
    
    const types = crawlerTypes || ['local', 'scholarship', 'curated_benefits', 'comprehensive', 'profile_enrichment']
    
    const jobIds = []
    for (const crawlerType of types) {
      const jobId = randomUUID()
      
      const stmt = db.prepare(`
        INSERT INTO crawler_jobs (id, type, profile_id, status, parameters)
        VALUES (?, ?, ?, ?, ?)
      `)
      
      const defaultParams = {
        local: { radius_miles: 25, max_results: 100 },
        scholarship: { max_results: 50 },
        curated_benefits: { maxResults: 100 },
        comprehensive: { max_results: 200 },
        profile_enrichment: {},
        avatar_lookup: {},
        item_search: { max_results: 50 },
      }
      
      stmt.run(
        jobId,
        crawlerType,
        profileId,
        'queued',
        JSON.stringify(defaultParams[crawlerType] || {})
      )
      
      jobIds.push({ type: crawlerType, jobId })
    }
    
    return {
      success: true,
      profileId,
      jobsCreated: jobIds.length,
      jobs: jobIds,
    }
  },
})

registerTool({
  name: 'admin.crawler.schedule',
  description: 'Schedule recurring crawler jobs using cron format. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile ID to schedule crawlers for' },
      crawlerType: {
        type: 'string',
        enum: ['local', 'scholarship', 'curated_benefits', 'comprehensive', 'item_search', 'profile_enrichment', 'avatar_lookup', 'portal_check'],
        description: 'Type of crawler to schedule. curated_benefits runs the new profile-matched system. Use comprehensive with parameters.mode=geo for Geo Crawl.'
      },
      schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * 1" for every Monday at 9am)' },
      enabled: { type: 'boolean', description: 'Whether schedule is enabled (default: true)' },
    },
    required: ['profileId', 'crawlerType', 'schedule'],
  },
  handler: async (params, context) => {
    const { profileId, crawlerType, schedule, enabled = true } = params
    const { db } = context
    
    const scheduleId = randomUUID()
    
    const stmt = db.prepare(`
      INSERT INTO crawler_schedules (id, profile_id, crawler_type, schedule_cron, enabled)
      VALUES (?, ?, ?, ?, ?)
    `)
    
    stmt.run(scheduleId, profileId, crawlerType, schedule, enabled ? 1 : 0)
    
    return {
      success: true,
      scheduleId,
      profileId,
      crawlerType,
      schedule,
      enabled,
      message: `Scheduled ${crawlerType} crawler for profile ${profileId} with cron: ${schedule}`,
    }
  },
})

registerTool({
  name: 'admin.system.monitor',
  description: 'Monitor system health continuously. Checks crawler job success/failure rates and alerts on issues. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      checkInterval: { type: 'integer', description: 'Check interval in minutes (default: 60)', minimum: 5, maximum: 1440 },
      alertThreshold: { type: 'number', description: 'Failure rate threshold to trigger alert (0-1, default: 0.3)', minimum: 0, maximum: 1 },
    },
  },
  handler: async (params, context) => {
    const { checkInterval = 60, alertThreshold = 0.3 } = params
    const { db } = context
    
    // Get job statistics from the last 24 hours
    const since24hPredicate =
      db?.dialect === 'postgres'
        ? `created_at >= (NOW() - INTERVAL '24 hours')`
        : `created_at >= datetime('now', '-24 hours')`

    const stats = await db.prepare(`
      SELECT 
        type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
      FROM crawler_jobs
      WHERE ${since24hPredicate}
      GROUP BY type
    `).all()
    
    const alerts = []
    const summary = {}
    
    for (const stat of stats) {
      const failureRate = stat.total > 0 ? stat.failed / stat.total : 0
      summary[stat.type] = {
        total: stat.total,
        completed: stat.completed,
        failed: stat.failed,
        in_progress: stat.in_progress,
        failure_rate: failureRate.toFixed(2),
      }
      
      if (failureRate > alertThreshold && stat.total >= 3) {
        alerts.push({
          type: 'high_failure_rate',
          crawler_type: stat.type,
          failure_rate: failureRate.toFixed(2),
          failed_count: stat.failed,
          total_count: stat.total,
        })
      }
    }
    
    // Check for stuck jobs (in_progress for more than 2 hours)
    const stuckPredicate =
      db?.dialect === 'postgres'
        ? `created_at < (NOW() - INTERVAL '2 hours')`
        : `created_at < datetime('now', '-2 hours')`

    const stuckJobs = await db.prepare(`
      SELECT id, type, created_at
      FROM crawler_jobs
      WHERE status = 'in_progress'
        AND ${stuckPredicate}
    `).all()
    
    if (stuckJobs.length > 0) {
      alerts.push({
        type: 'stuck_jobs',
        count: stuckJobs.length,
        jobs: stuckJobs.map(j => ({ id: j.id, type: j.type })),
      })
    }
    
    return {
      success: true,
      checkInterval,
      alertThreshold,
      summary,
      alerts,
      healthy: alerts.length === 0,
      timestamp: new Date().toISOString(),
    }
  },
})

// Note: a second admin.code.scan registration previously lived here. It has
// been removed to prevent silent override of the canonical registration
// above (which delegates to adminCodeScan in anyaAdminTools.js). See
// admin.code.missionAudit for the mission-aware replacement that surfaces
// profile isolation, SQL safety, placeholder logic, and tool drift.

registerTool({
  name: 'admin.code.missionAudit',
  description:
    'Run a GrantFlow mission-aware audit that prioritizes funding integrity, profile isolation, SQL identifier safety, placeholder detection, and tool-registry drift. Admin only.',
  requiresAdmin: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, _context) => {
    return runMissionAudit()
  },
})

// ============================================================================
// Autonomous Operations Tools
// ============================================================================

registerTool({
  name: 'admin.anya.runAutonomous',
  description: 'Start autonomous code crawl and fix loop. Scans codebase, analyzes issues, and applies fixes with backups. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Directory to scan (relative to repo root, default: entire repo)' },
      pattern: { type: 'string', description: 'Optional regex pattern to search for' },
      maxIterations: { type: 'integer', description: 'Maximum number of files to process (default: 50)', minimum: 1, maximum: 200 },
      maxFileChanges: { type: 'integer', description: 'Maximum number of files to modify (default: 20)', minimum: 1, maximum: 100 },
      dryRun: { type: 'boolean', description: 'If true, dont save changes (default: false)' },
      fixConsoleLog: { type: 'boolean', description: 'Fix debug console.log statements (default: true)' },
      fixEmptyCatch: { type: 'boolean', description: 'Fix empty catch blocks (default: false)' },
      fixTodos: { type: 'boolean', description: 'Convert TODO comments to tracked issues (default: false)' },
    },
  },
  handler: runAutonomousCodeCrawl,
})

registerTool({
  name: 'admin.anya.runCrawlers',
  description: 'Run crawlers for all profiles or specific profiles. Saves results to profile opportunities AND global opportunities page. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      profileIds: { 
        type: 'array', 
        items: { type: 'string' },
        description: 'Specific profile IDs to run crawlers for (default: all active profiles)' 
      },
      crawlerTypes: {
        type: 'array',
        items: { 
          type: 'string',
          enum: [
            'local',
            'scholarship',
            'curated_benefits',
            'health_resources',
            'comprehensive',
            'profile_enrichment',
            'avatar_lookup',
            'item_search',
            'item_gift_search',
          ]
        },
        description: 'Types of crawlers to run (default: [local, scholarship, curated_benefits, comprehensive, profile_enrichment]). curated_benefits runs the new profile-matched benefits/scholarships system.'
      },
      maxRetries: { type: 'integer', description: 'Maximum retries for failed jobs (default: 3)', minimum: 0, maximum: 10 },
      waitForCompletion: { type: 'boolean', description: 'Wait for jobs to complete (default: false)' },
      timeoutMinutes: { type: 'integer', description: 'Timeout in minutes (default: 30)', minimum: 5, maximum: 120 },
    },
  },
  handler: runAutonomousCrawlers,
})

registerTool({
  name: 'admin.items.discover',
  description:
    'Discover new requestable items by scanning existing opportunity keywords/categories. Deterministic and reversible; does not scrape the web. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      min_count: { type: 'integer', minimum: 1, maximum: 50, description: 'Minimum occurrences to consider (default: 3)' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max items to insert (default: 50)' },
    },
  },
  handler: async (params, context) => {
    if (!context?.db) throw new Error('Database connection unavailable')
    const minCount = Number(params?.min_count ?? 3)
    const limit = Number(params?.limit ?? 50)
    return discoverNewCatalogItems(context.db, { minCount, limit })
  },
})

registerTool({
  name: 'admin.anya.testFunctions',
  description: 'Test all API endpoints and functions systematically. Find and fix errors. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      testSuites: {
        type: 'array',
        items: { type: 'string', enum: ['health', 'profiles', 'opportunities', 'anya'] },
        description: 'Test suites to run (default: all)'
      },
      fixErrors: { type: 'boolean', description: 'Attempt to fix errors found (default: false)' },
      dryRun: { type: 'boolean', description: 'Dont save fixes (default: true)' },
    },
  },
  handler: runAutonomousFunctionTests,
})

registerTool({
  name: 'admin.anya.testButtons',
  description: 'Test all button functionality in the UI by analyzing component handlers. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      componentPath: { type: 'string', description: 'Path to components directory (default: src/components)' },
      fixErrors: { type: 'boolean', description: 'Attempt to fix errors found (default: false)' },
      dryRun: { type: 'boolean', description: 'Dont save fixes (default: true)' },
    },
  },
  handler: testButtonFunctionality,
})

registerTool({
  name: 'admin.anya.saveCrawlerToGlobal',
  description: 'Save crawler results to global opportunities (without profile info bleed). Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Crawler job ID to process' },
    },
    required: ['jobId'],
  },
  handler: saveCrawlerResultsToGlobal,
})

registerTool({
  name: 'admin.anya.getStatus',
  description: 'Get status of all autonomous operations (code crawl, crawlers, function tests). Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      operationType: {
        type: 'string',
        enum: ['code', 'crawlers', 'functions', 'all'],
        description: 'Type of operation to get status for (default: all)'
      },
    },
  },
  handler: async (params, context) => {
    const { operationType = 'all' } = params
    
    const status = {}
    
    if (operationType === 'code' || operationType === 'all') {
      status.code_crawl = await getAutonomousStatus()
    }
    
    if (operationType === 'crawlers' || operationType === 'all') {
      status.crawlers = await getAutonomousCrawlersStatus(context?.db ?? null)
    }
    
    if (operationType === 'functions' || operationType === 'all') {
      status.function_tests = await getAutonomousFunctionTestsStatus(context?.db ?? null)
    }
    
    status.background_code_crawl_repair = getBackgroundCodeCrawlState()
    
    return status
  },
})

// ============================================================================
// Anya Brain Tools (Persistent State Management)
// ============================================================================

registerTool({
  name: 'brain.remember',
  description: 'Store a memory in Anya\'s persistent brain. Use for facts, preferences, and learned patterns.',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Unique key for this memory (e.g., "user_preferred_grant_types")' },
      content: { type: 'object', description: 'Memory content to store' },
      scope: { type: 'string', enum: ['global', 'profile', 'user'], description: 'Memory scope (default: based on context)' },
      memoryType: { type: 'string', enum: ['fact', 'preference', 'context', 'learned_pattern'], description: 'Type of memory (default: fact)' },
      expiresInDays: { type: 'integer', description: 'Days until memory expires (null = permanent)' },
    },
    required: ['key', 'content'],
  },
  handler: async (params, context) => {
    const { db, user } = context
    if (!db) throw new Error('Database connection unavailable')
    
    const { key, content, scope, memoryType = 'fact', expiresInDays } = params
    
    // Determine scope and scopeId based on context
    let finalScope = scope || 'global'
    let scopeId = null
    
    if (finalScope === 'user' && user?.userId) {
      scopeId = user.userId
    } else if (finalScope === 'profile' && user?.profileId) {
      scopeId = user.profileId
    }
    
    const expiresAt = expiresInDays 
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null
    
    return storeMemory(db, {
      scope: finalScope,
      scopeId,
      memoryType,
      memoryKey: key,
      content,
      expiresAt,
      source: 'anya',
    })
  },
})

registerTool({
  name: 'brain.recall',
  description: 'Retrieve a specific memory from Anya\'s brain by key.',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory key to retrieve' },
      scope: { type: 'string', enum: ['global', 'profile', 'user'], description: 'Memory scope to search' },
    },
    required: ['key'],
  },
  handler: async (params, context) => {
    const { db, user } = context
    if (!db) throw new Error('Database connection unavailable')
    
    const { key, scope = 'global' } = params
    
    let scopeId = null
    if (scope === 'user' && user?.userId) {
      scopeId = user.userId
    } else if (scope === 'profile' && user?.profileId) {
      scopeId = user.profileId
    }
    
    const memory = getMemory(db, { scope, scopeId, memoryKey: key })
    
    if (!memory) {
      return { found: false, key, scope }
    }
    
    return {
      found: true,
      key: memory.memory_key,
      content: memory.content,
      type: memory.memory_type,
      confidence: memory.confidence,
      accessCount: memory.access_count,
      lastAccessed: memory.last_accessed_at,
      updatedAt: memory.updated_at,
    }
  },
})

registerTool({
  name: 'brain.search',
  description: 'Search Anya\'s memories by scope and type.',
  schema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['global', 'profile', 'user'], description: 'Memory scope to search' },
      memoryType: { type: 'string', enum: ['fact', 'preference', 'context', 'learned_pattern'], description: 'Filter by memory type' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max memories to return (default: 20)' },
    },
  },
  handler: async (params, context) => {
    const { db, user } = context
    if (!db) throw new Error('Database connection unavailable')
    
    const { scope = 'global', memoryType, limit = 20 } = params
    
    let scopeId = null
    if (scope === 'user' && user?.userId) {
      scopeId = user.userId
    } else if (scope === 'profile' && user?.profileId) {
      scopeId = user.profileId
    }
    
    const memories = await getMemories(db, { scope, scopeId, memoryType, limit })
    
    return {
      count: memories.length,
      scope,
      memories: memories.map(m => ({
        key: m.memory_key,
        type: m.memory_type,
        content: m.content,
        confidence: m.confidence,
        accessCount: m.access_count,
        updatedAt: m.updated_at,
      })),
    }
  },
})

registerTool({
  name: 'brain.forget',
  description: 'Delete a memory from Anya\'s brain.',
  schema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Memory key to delete' },
      scope: { type: 'string', enum: ['global', 'profile', 'user'], description: 'Memory scope' },
    },
    required: ['key'],
  },
  handler: async (params, context) => {
    const { db, user } = context
    if (!db) throw new Error('Database connection unavailable')
    
    const { key, scope = 'global' } = params
    
    let scopeId = null
    if (scope === 'user' && user?.userId) {
      scopeId = user.userId
    } else if (scope === 'profile' && user?.profileId) {
      scopeId = user.profileId
    }
    
    return deleteMemory(db, { scope, scopeId, memoryKey: key })
  },
})

registerTool({
  name: 'brain.summary',
  description: 'Get a summary of Anya\'s brain state including memory counts and recent activity.',
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, context) => {
    const { db, user } = context
    if (!db) throw new Error('Database connection unavailable')
    
    return getBrainSummary(db, {
      userId: user?.userId,
      profileId: user?.profileId,
    })
  },
})

registerTool({
  name: 'admin.brain.cleanup',
  description: 'Clean up expired memories and old data from Anya\'s brain. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')
    
    return cleanupBrain(db)
  },
})

registerTool({
  name: 'admin.brain.stats',
  description: 'Get tool usage statistics for learning optimization. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      toolName: { type: 'string', description: 'Filter by specific tool name' },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max results (default: 50)' },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')
    
    const { toolName, limit = 50 } = params
    return getToolUsageStats(db, { toolName, limit })
  },
})

// ── Geo Crawl: Run through all states sequentially ──
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
]

registerTool({
  name: 'admin.geoCrawl.runAllStates',
  description:
    'Start a geo crawl that runs through all 50 US states sequentially. ' +
    'Creates a single comprehensive crawler job with run_all_states=true. ' +
    'Use admin.geoCrawl.status to monitor progress. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      startState: {
        type: 'string',
        description: 'Optional 2-letter state code to start from (default: AL). Useful for resuming.',
        enum: US_STATES,
      },
      maxZipsPerState: {
        type: 'integer',
        description: 'Max ZIP codes to sample per state (default: 5)',
        minimum: 1,
        maximum: 25,
      },
      discoverLocalResources: {
        type: 'boolean',
        description: 'Also discover local community resources per ZIP (default: true)',
      },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')

    const maxZips = params.maxZipsPerState ?? 5
    const jobId = randomUUID()
    const geoRunId = randomUUID()

    const parameters = JSON.stringify({
      mode: 'geo',
      geo_run_id: geoRunId,
      run_all_states: true,
      start_state: params.startState ?? null,
      max_zips: maxZips,
      discover_local_resources: params.discoverLocalResources ?? true,
      offline_only: false,
    })

    await db
      .prepare(
        `INSERT INTO crawler_jobs (id, type, status, profile_id, organization_id, parameters, requested_by)
         VALUES (?, 'comprehensive', 'queued', NULL, NULL, ?, 'anya_admin')`,
      )
      .run(jobId, parameters)

    try {
      const { dispatchCrawlerJob } = await import('./crawlerDispatcher.js')
      dispatchCrawlerJob({ db, jobId }).catch(e => console.warn('[background]', e?.message || e))
    } catch { /* ignore */ }

    return {
      ok: true,
      message: `Geo crawl started — all 50 states, ${maxZips} ZIPs each.`,
      crawler_job_id: jobId,
      geo_run_id: geoRunId,
      states_count: US_STATES.length,
      max_zips_per_state: maxZips,
      tip: 'Use admin.geoCrawl.status to monitor progress.',
    }
  },
})

registerTool({
  name: 'admin.geoCrawl.status',
  description: 'Check the status of a running or recent geo crawl. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: 'Crawler job ID to check (omit for most recent geo crawl)' },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')

    const jobId = params.jobId
    let job
    if (jobId) {
      job = await db.prepare('SELECT * FROM crawler_jobs WHERE id = ? LIMIT 1').get(jobId)
    } else {
      job = await db.prepare(
        `SELECT * FROM crawler_jobs
         WHERE type = 'comprehensive'
           AND parameters LIKE '%"mode":"geo"%'
         ORDER BY created_at DESC LIMIT 1`,
      ).get()
    }
    if (!job) return { ok: false, message: 'No geo crawl job found.' }

    let parsedParams = {}
    try { parsedParams = JSON.parse(job.parameters || '{}') } catch { /* ok */ }

    return {
      ok: true,
      job_id: job.id,
      status: job.status,
      started_at: job.started_at,
      completed_at: job.completed_at,
      result_count: job.result_count,
      error: job.error ?? null,
      geo_run_id: parsedParams.geo_run_id ?? null,
      run_all_states: parsedParams.run_all_states ?? false,
      max_zips: parsedParams.max_zips ?? null,
    }
  },
})

// ============================================================================
// Grant Writing Tools (End-User — LOI, Proposals, Needs Statements)
// ============================================================================

registerTool({
  name: 'grants.writeLOI',
  description: 'Generate a full Letter of Intent (LOI) draft for a specific grant opportunity, using the profile data to write at MBA-level grant writer quality.',
  schema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', description: 'The funding opportunity ID to write the LOI for' },
      customInstructions: { type: 'string', description: 'Additional instructions or focus areas for the LOI' },
    },
    required: ['opportunityId'],
  },
  handler: async (params, context) => {
    const { db, profileId } = context
    if (!db) throw new Error('Database connection unavailable')

    const opp = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(params.opportunityId)
    if (!opp) throw new Error(`Opportunity ${params.opportunityId} not found`)

    const profileData = await gatherProfileData(db, profileId)

    return {
      type: 'loi_draft',
      opportunity: { id: opp.id, title: opp.title, sponsor: opp.sponsor, deadline: opp.deadline, description: opp.description, url: opp.url, application_url: opp.application_url, contact_info: opp.contact_info },
      profile: profileData,
      instructions: params.customInstructions || null,
      writingDirective: LOI_WRITING_DIRECTIVE,
      submissionInfo: extractSubmissionInfo(opp),
    }
  },
})

registerTool({
  name: 'grants.writeNeedsStatement',
  description: 'Generate a compelling needs statement section for a grant proposal, grounded in real profile data, at MBA-level grant writer quality.',
  schema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', description: 'The funding opportunity ID' },
      focusArea: { type: 'string', description: 'Specific area of need to emphasize (e.g., "healthcare access", "housing stability")' },
    },
    required: ['opportunityId'],
  },
  handler: async (params, context) => {
    const { db, profileId } = context
    if (!db) throw new Error('Database connection unavailable')

    const opp = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(params.opportunityId)
    if (!opp) throw new Error(`Opportunity ${params.opportunityId} not found`)

    const profileData = await gatherProfileData(db, profileId)

    return {
      type: 'needs_statement',
      opportunity: { id: opp.id, title: opp.title, sponsor: opp.sponsor, description: opp.description },
      profile: profileData,
      focusArea: params.focusArea || null,
      writingDirective: NEEDS_STATEMENT_WRITING_DIRECTIVE,
    }
  },
})

registerTool({
  name: 'grants.writeFullApplication',
  description: 'Generate a complete grant/benefit application with all required sections, using profile data, at MBA-level grant writer quality. Includes submission instructions.',
  schema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', description: 'The funding opportunity ID' },
      grantId: { type: 'string', description: 'The pipeline grant ID (if already in pipeline)' },
      sections: { type: 'array', items: { type: 'string' }, description: 'Specific sections to write (e.g., ["narrative", "budget", "timeline"]). Omit for all sections.' },
    },
    required: ['opportunityId'],
  },
  handler: async (params, context) => {
    const { db, profileId } = context
    if (!db) throw new Error('Database connection unavailable')

    const opp = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(params.opportunityId)
    if (!opp) throw new Error(`Opportunity ${params.opportunityId} not found`)

    let grant = null
    if (params.grantId) {
      grant = await db.prepare('SELECT * FROM grants WHERE id = ?').get(params.grantId)
    }

    const profileData = await gatherProfileData(db, profileId)
    const submission = extractSubmissionInfo(opp)

    return {
      type: 'full_application',
      opportunity: { id: opp.id, title: opp.title, sponsor: opp.sponsor, deadline: opp.deadline, description: opp.description, url: opp.url, application_url: opp.application_url, contact_info: opp.contact_info },
      grant: grant ? { id: grant.id, status: grant.status, notes: grant.notes, application_method: grant.application_method } : null,
      profile: profileData,
      requestedSections: params.sections || null,
      writingDirective: FULL_APPLICATION_WRITING_DIRECTIVE,
      submissionInfo: submission,
    }
  },
})

registerTool({
  name: 'grants.getSubmissionInfo',
  description: 'Get complete submission details for a grant/opportunity: portal URL, mailing address, fax number, email, phone, and step-by-step instructions.',
  schema: {
    type: 'object',
    properties: {
      opportunityId: { type: 'string', description: 'The funding opportunity ID' },
      grantId: { type: 'string', description: 'The pipeline grant ID' },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')

    let opp = null, grant = null
    if (params.opportunityId) {
      opp = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(params.opportunityId)
    }
    if (params.grantId) {
      grant = await db.prepare('SELECT * FROM grants WHERE id = ?').get(params.grantId)
      if (!opp && grant?.funding_opportunity_id) {
        opp = await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(grant.funding_opportunity_id)
      }
    }
    if (!opp && !grant) throw new Error('Provide opportunityId or grantId')

    return {
      type: 'submission_info',
      submission: extractSubmissionInfo(opp || {}),
      grant: grant ? { application_url: grant.application_url, application_method: grant.application_method, contact_name: grant.contact_name, contact_email: grant.contact_email, contact_phone: grant.contact_phone, funder_fax: grant.funder_fax, funder_address: grant.funder_address } : null,
    }
  },
})

async function gatherProfileData(db, profileId) {
  if (!profileId) return null
  const profile = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId)
  if (!profile) return null
  const sections = await db.prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?').all(profileId)
  const parsed = {}
  for (const s of (sections || [])) {
    try { parsed[s.section_key] = typeof s.data === 'string' ? JSON.parse(s.data) : s.data } catch { /* skip */ }
  }
  const demo = parsed.demographics || parsed.personal_info || {}
  return { id: profile.id, name: profile.display_name, type: profile.primary_type, state: demo.state || null, city: demo.city || null, zip: demo.zip_code || null, sections: parsed }
}

function extractSubmissionInfo(opp) {
  let contact = {}
  try { contact = typeof opp.contact_info === 'string' ? JSON.parse(opp.contact_info) : (opp.contact_info || {}) } catch { /* ignore */ }
  const desc = `${opp.description || ''} ${opp.applicationNote || ''}`.toLowerCase()
  let method = 'portal'
  if (desc.includes('fax')) method = 'fax'
  else if (desc.includes('mail') && !desc.includes('email')) method = 'print_and_mail'
  else if (desc.includes('call') || desc.includes('phone')) method = 'phone'
  return {
    method,
    portalUrl: opp.application_url || opp.url || null,
    mailingAddress: contact.address || null,
    faxNumber: contact.fax || null,
    email: contact.email || null,
    phone: contact.phone || null,
    contactName: contact.name || null,
    website: contact.website || opp.url || null,
    applicationNote: opp.applicationNote || null,
    linkStatus: opp.link_status ?? 'unverified',
    linkWarning: opp.link_status === 'broken'
      ? 'Warning: The application link may be broken. Our last check received an error. Try the URL, and if it fails, contact the funder directly.'
      : null,
  }
}

const LOI_WRITING_DIRECTIVE = `You are a seasoned grant writer with an MBA and 15+ years of experience securing funding for individuals and organizations. Write a compelling, professional Letter of Intent that:
- Opens with a clear statement of purpose and funding amount requested
- Demonstrates alignment between the applicant's needs and the funder's mission
- Uses specific data from the profile (demographics, health, financial, family, education)
- Articulates measurable outcomes and impact
- Maintains a confident, professional tone
- Follows standard LOI format: Introduction, Statement of Need, Project Description, Budget Summary, Conclusion
- Is ready to print, sign, and submit`

const NEEDS_STATEMENT_WRITING_DIRECTIVE = `You are a seasoned grant writer with an MBA and 15+ years of experience. Write a compelling needs statement that:
- Grounds every claim in the applicant's actual profile data
- Cites relevant statistics for the geographic area and population
- Connects individual/community need to the funder's priorities
- Uses authoritative, data-driven language without being clinical
- Builds an emotional narrative anchored in facts
- Is 300-500 words unless otherwise specified`

const FULL_APPLICATION_WRITING_DIRECTIVE = `You are a seasoned grant writer with an MBA and 15+ years of experience securing federal, state, and foundation funding. Write a complete grant application that:
- Addresses every required section with professional, compelling content
- Uses the applicant's real profile data throughout (no placeholders)
- Writes needs statements grounded in demographics, health conditions, financial data, and geographic factors
- Creates realistic budgets based on actual amounts and needs
- Includes a clear project description with measurable objectives
- Writes at the highest professional standard — this must compete with applications from funded organizations
- Provides all submission instructions: where to send, how to submit, deadlines, and required attachments
- If the application must be printed and mailed, provide the complete mailing address
- If it requires fax, provide the fax number
- If it's a portal submission, provide the portal URL and step-by-step instructions for the portal`

// ─── Medical Necessity Tools ─────────────────────────────────────────────────

registerTool({
  name: 'medical.generateLOMN',
  description: 'Generate a Letter of Medical Necessity (LOMN) for the current profile. Uses real health data from the profile to create a professional document ready for physician review and signature.',
  schema: {
    type: 'object',
    properties: {
      documentType: {
        type: 'string',
        enum: Object.values(DOCUMENT_TYPES),
        description: 'Type of medical document to generate. Defaults to letter_of_medical_necessity.',
      },
      opportunityId: { type: 'string', description: 'Optional funding opportunity ID this document supports' },
      grantId: { type: 'string', description: 'Optional pipeline grant ID this document supports' },
      specificEquipment: { type: 'string', description: 'Specific equipment being requested (e.g., "power wheelchair", "CPAP machine")' },
      specificCondition: { type: 'string', description: 'Specific condition to focus on if multiple exist' },
      additionalContext: { type: 'string', description: 'Any additional instructions or context' },
    },
  },
  handler: async (params, context) => {
    const { db, profileId } = context
    if (!db) throw new Error('Database connection unavailable')
    if (!profileId) throw new Error('No profile selected. Please select a profile first.')

    const result = await generateMedicalNecessityDocument(db, profileId, {
      documentType: params.documentType || DOCUMENT_TYPES.LOMN,
      opportunityId: params.opportunityId || null,
      grantId: params.grantId || null,
      specificEquipment: params.specificEquipment || null,
      specificCondition: params.specificCondition || null,
      additionalContext: params.additionalContext || null,
    })

    return result
  },
})

registerTool({
  name: 'medical.reviewProfile',
  description: 'Review the current profile\'s medical data to summarize conditions, disabilities, DME needs, functional limitations, and insurance. Useful before generating medical documents.',
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const { db, profileId } = context
    if (!db) throw new Error('Database connection unavailable')
    if (!profileId) throw new Error('No profile selected.')

    const medProfile = await extractMedicalProfile(db, profileId)
    if (!medProfile) throw new Error('Profile not found')

    return {
      type: 'medical_profile_review',
      name: medProfile.name,
      conditions: medProfile.conditions,
      disabilities: medProfile.disabilities,
      dmeNeeds: medProfile.dmeNeeds,
      functionalLimitations: medProfile.functionalLimitations,
      insurance: medProfile.insurance,
      supportNeeds: medProfile.supportNeeds,
      supportNeedsLevel: medProfile.supportNeedsLevel,
      physician: medProfile.physician,
      letterSupportNeeded: medProfile.letterSupportNeeded,
      medicaid: medProfile.medicaid,
      medicare: medProfile.medicare,
      waiverProgram: medProfile.waiverProgram,
      financialContext: medProfile.financialContext,
      familyContext: medProfile.familyContext,
      readiness: {
        hasConditions: medProfile.conditions.length > 0,
        hasDisabilities: medProfile.disabilities.length > 0,
        hasDMENeeds: medProfile.dmeNeeds.length > 0,
        hasPhysician: Boolean(medProfile.physician?.name),
        hasInsurance: Boolean(medProfile.insurance?.provider),
        canGenerateLOMN: medProfile.conditions.length > 0 || medProfile.disabilities.length > 0,
      },
    }
  },
})

registerTool({
  name: 'medical.scanPipeline',
  description: 'Scan the profile\'s pipeline grants to identify which ones require medical necessity documentation (LOMN, disability verification, DME justification, etc.).',
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const { db, profileId } = context
    if (!db) throw new Error('Database connection unavailable')
    if (!profileId) throw new Error('No profile selected.')

    const flagged = await scanPipelineForMedNec(db, profileId)
    return {
      type: 'pipeline_med_nec_scan',
      totalFlagged: flagged.length,
      items: flagged,
      recommendation: flagged.length > 0
        ? `Found ${flagged.length} pipeline item(s) that may require medical necessity documentation. Use medical.generateLOMN with the grantId to generate documents.`
        : 'No pipeline items currently require medical necessity documentation.',
    }
  },
})

import { runAutoRepair } from './anyaAutoRepairService.js'

registerTool({
  name: 'admin.code.autoRepair',
  description: 'Scan the codebase for common anti-patterns (empty catches, console.log in routes, missing profile_id isolation in SQL) and optionally repair them. profile_bleed findings are always report-only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      dryRun: {
        type: 'boolean',
        default: true,
        description: 'When true (default), return a report without modifying any files.',
      },
      repairTypes: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['empty_catch', 'console_log', 'profile_bleed'],
        },
        description: 'Subset of repair types to run. Defaults to all three.',
      },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')
    const dryRun = params?.dryRun !== false
    const repairTypes = params?.repairTypes
    const report = await runAutoRepair(db, { dryRun, repairTypes })
    const totalFindings =
      report.findings.empty_catch.length +
      report.findings.console_log.length +
      report.findings.profile_bleed.length
    const recommendation = dryRun
      ? totalFindings > 0
        ? `Found ${totalFindings} issue(s) across ${report.scannedFiles} files. Run with dryRun=false to apply repairs (profile_bleed issues require manual SQL fixes).`
        : `No issues found across ${report.scannedFiles} files.`
      : `Applied repairs: ${report.repaired.empty_catch} empty_catch fix(es), ${report.repaired.console_log} console_log fix(es). profile_bleed issues (${report.findings.profile_bleed.length}) require manual SQL fixes.`
    return { ...report, recommendation }
  },
})

import { getHelpForRoute, getHelpForField, searchHelp } from './anyaHelpKnowledge.js'

registerTool({
  name: 'app.explainFeature',
  description: 'Explain what a GrantFlow page or feature does, who can use it, its main actions, and how it relates to other features. Provide the routeName (e.g. SmartMatcher, Pipeline, MyProfiles).',
  schema: {
    type: 'object',
    properties: {
      routeName: {
        type: 'string',
        description: 'The GrantFlow page routeName to explain (e.g. SmartMatcher, Pipeline, Dashboard, MyProfiles).',
      },
    },
    required: ['routeName'],
  },
  handler: async (params, _context) => {
    const { routeName } = params ?? {}
    if (!routeName) throw new Error('routeName is required')
    const entry = getHelpForRoute(routeName)
    if (!entry) {
      const results = searchHelp(routeName)
      if (results.length > 0) {
        return {
          found: false,
          suggestion: `No exact match for "${routeName}". Did you mean one of: ${results.slice(0, 3).map((r) => r.key).join(', ')}?`,
          results: results.slice(0, 3),
        }
      }
      return { found: false, message: `No help entry found for "${routeName}".` }
    }
    return { found: true, ...entry }
  },
})

registerTool({
  name: 'app.explainField',
  description: 'Explain what a specific profile field does, why it matters for grant matching, and whether it affects crawlers. Provide the field key (e.g. zip, state, entity_type, health_conditions).',
  schema: {
    type: 'object',
    properties: {
      fieldKey: {
        type: 'string',
        description: 'The profile field key to explain (e.g. zip, state, entity_type, naics_codes, revenue, health_conditions, military_status).',
      },
    },
    required: ['fieldKey'],
  },
  handler: async (params, _context) => {
    const { fieldKey } = params ?? {}
    if (!fieldKey) throw new Error('fieldKey is required')
    const result = getHelpForField(fieldKey)
    if (!result) {
      return { found: false, message: `No field definition found for key "${fieldKey}". Known fields include: zip, state, entity_type, naics_codes, revenue, health_conditions, financial_details, education, military_status, government_assistance, family_composition.` }
    }
    return {
      found: true,
      field: result.field,
      foundOnPage: result.page.key,
      pageTitle: result.page.title,
    }
  },
})

// ---------------------------------------------------------------------------
// CodeGuard audit tools — Anya's system health brain
// ---------------------------------------------------------------------------

import {
  testEndpoints as cgTestEndpoints,
  auditMatchQuality as cgAuditMatchQuality,
  verifyMissionGoals as cgVerifyMissionGoals,
  getAuditSummary as cgGetAuditSummary,
} from './codeGuardService.js'

registerTool({
  name: 'admin.codeGuard.endpointHealth',
  description: 'Run live health checks against all GrantFlow API endpoints. Returns pass/fail/skip counts and response times. Use when asked about system health, API status, or endpoint reliability.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      port: { type: 'number', description: 'Server port (defaults to process.env.PORT or 3001)' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const port = params?.port || process.env.PORT || 3001
    const baseUrl = `http://localhost:${port}`
    const token = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null
    return cgTestEndpoints(db, baseUrl, token)
  },
})

registerTool({
  name: 'admin.codeGuard.matchAudit',
  description: 'Audit match quality across all profiles. Grades each profile A-F based on pipeline completeness (decision metadata, explanations, URLs, matched needs). Use when asked about match quality, pipeline health, or profile-level performance.',
  requiresAdmin: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    return cgAuditMatchQuality(db)
  },
})

registerTool({
  name: 'admin.codeGuard.missionVerify',
  description: 'Run the 15-goal GrantFlow mission verification. Tests real funding URLs, need matching, junk rejection, decision engine usage, profile depth, applicant types, recall balance, explainability, fingerprints, crawling, Anya health, and more. Returns a scorecard with PASS/WARN/FAIL per goal.',
  requiresAdmin: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    return cgVerifyMissionGoals(db)
  },
})

registerTool({
  name: 'admin.codeGuard.status',
  description: 'Get the latest CodeGuard audit summary (endpoint health, match quality grades, mission score). This data is collected automatically on admin startup and refreshed every 6 hours. Use when asked "how is the system?" or "what does CodeGuard say?"',
  requiresAdmin: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    return { summary: cgGetAuditSummary(db) }
  },
})

registerTool({
  name: 'admin.codeGuard.deepSweep',
  description: 'Run a full deep sweep: endpoint health + match quality audit + mission verification, all at once. Equivalent to CodeGuard\'s Deep Sweep mode. Use when asked to do a full system check or comprehensive audit.',
  requiresAdmin: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const port = process.env.PORT || 3001
    const baseUrl = `http://localhost:${port}`
    const token = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null

    const [endpoints, matchQuality, mission] = await Promise.allSettled([
      cgTestEndpoints(db, baseUrl, token),
      cgAuditMatchQuality(db),
      cgVerifyMissionGoals(db),
    ])

    return {
      endpoints: endpoints.status === 'fulfilled' ? endpoints.value : { error: endpoints.reason?.message },
      matchQuality: matchQuality.status === 'fulfilled' ? matchQuality.value : { error: matchQuality.reason?.message },
      mission: mission.status === 'fulfilled' ? mission.value : { error: mission.reason?.message },
      summary: cgGetAuditSummary(db),
    }
  },
})
