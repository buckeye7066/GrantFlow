import path from 'path'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import {
  adminCodeCrawl,
  adminCodeLint,
  adminCodeAnalyze,
  adminCodeEdit,
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
  runAutonomousCodeCrawl,
  getAutonomousStatus,
} from './anyaAutonomousCrawler.js'
import {
  runAutonomousCrawlers,
  saveCrawlerResultsToGlobal,
  getAutonomousCrawlersStatus,
} from './anyaAutonomousFunctionRunner.js'
import {
  runAutonomousFunctionTests,
  testButtonFunctionality,
  getAutonomousFunctionTestsStatus,
} from './anyaAutonomousFunctionTesting.js'

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
const BASE_MATCH_SCORE = 40 // Base score for all grant matches before adjustments

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
  
  return oppCategories.filter(c => 
    profileCategories.some(pc => 
      c.toLowerCase().includes(pc.toLowerCase()) || 
      pc.toLowerCase().includes(c.toLowerCase())
    )
  )
}

function generateMatchReasons(opp, profile) {
  const reasons = []
  
  // Location match
  if (opp.state && profile?.state) {
    if (opp.state.toLowerCase() === profile.state.toLowerCase()) {
      reasons.push(`Location match: Both in ${opp.state}`)
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

function calculateMatchScore(opp, profile, matchReasons) {
  let score = BASE_MATCH_SCORE
  
  // Location match adds points
  if (opp.state && profile?.state && opp.state.toLowerCase() === profile.state.toLowerCase()) {
    score += 20
  } else if (opp.is_national || opp.state === 'nationwide') {
    score += 10
  }
  
  // Category matches
  const oppCategories = cleanList(safeParseJSON(opp.categories, []), 10)
  const profileCategories = cleanList(safeParseJSON(profile?.categories, []), 10)
  const matchingCategories = findMatchingCategories(oppCategories, profileCategories)
  score += Math.min(matchingCategories.length * 10, 30)
  
  // Deadline urgency
  const daysRemaining = daysUntil(opp.deadline)
  if (daysRemaining !== null && daysRemaining > 0 && daysRemaining < 60) {
    score += 5
  }
  
  // Match reasons count
  score += Math.min(matchReasons.length * 5, 15)
  
  return Math.min(100, Math.max(0, score))
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

function ensureProfileAccess(user, profileId) {
  if (!profileId) return false
  if (!user || user.role === 'guest') return false
  if (user.role === 'admin') return true
  return user.profileId && user.profileId === profileId
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
  const primary = db
    .prepare(
      `
        SELECT id, title, sponsor, deadline, amount_min, amount_max, amount_description,
               application_url, state, opportunity_type, requires_match, match_percentage,
               eligibility_bullets, categories, source, source_url, updated_at, match_reasons,
               description, regions, keywords
        FROM funding_opportunities
        WHERE is_active = 1 AND profile_id = ?
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

  const fallback = db
    .prepare(
      `
        SELECT id, title, sponsor, deadline, amount_min, amount_max, amount_description,
               application_url, state, opportunity_type, requires_match, match_percentage,
               eligibility_bullets, categories, source, source_url, updated_at, match_reasons,
               description, regions, keywords
        FROM funding_opportunities
        WHERE is_active = 1
        ORDER BY updated_at DESC
        LIMIT ?
      `,
    )
    .all(remaining * 3 || remaining) // fetch a few extra rows to account for duplicates

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
      matchScore = calculateMatchScore(opp, profile, matchReasons)
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
    }
  })
}

function summarizeGrants(db, params, context) {
  const user = context?.user
  const profileId =
    (params?.profile_id && String(params.profile_id).trim()) ||
    (user?.profileId ? String(user.profileId).trim() : '')

  if (!profileId) {
    throw new Error('profile_id is required to summarize grants')
  }
  if (!ensureProfileAccess(user, profileId)) {
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

  tools.set(name, {
    name,
    description: description ?? '',
    schema: schema ?? null,
    handler,
    requiresAdmin: Boolean(requiresAdmin),
  })
}

export function listToolMetadata(user = null) {
  const isAdmin = user?.role === 'admin'
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

  // Check admin access
  if (tool.requiresAdmin) {
    const user = context?.user
    if (!user || user.role !== 'admin') {
      const error = new Error(`Tool "${name}" requires admin privileges`)
      error.status = 403
      throw error
    }

    // Log admin tool invocation for audit
    console.log('[anyaToolRegistry] Admin tool invoked:', {
      tool: name,
      user: user.userId ?? user.id ?? 'unknown',
      timestamp: new Date().toISOString(),
    })
  }

  const result = await tool.handler(params ?? {}, context ?? {})

  return {
    id: randomUUID(),
    tool: tool.name,
    output: result,
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
  name: 'grants.summarizeMatches',
  description: 'Summarise the most recently matched funding opportunities for a specific profile.',
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
  handler: adminCodeLint,
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

// Crawler Management Tools
registerTool({
  name: 'admin.crawler.list',
  description: 'List all crawler jobs with their status. Admin only.',
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
  description: 'Trigger any crawler type with custom parameters. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [
          'local',
          'scholarship',
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
  description: 'Validate crawler outputs and check for errors in recent jobs. Admin only.',
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
          enum: ['local', 'scholarship', 'comprehensive', 'item_search', 'profile_enrichment', 'avatar_lookup']
        },
        description: 'Array of crawler types to trigger (default: all)'
      },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    const { profileId, crawlerTypes } = params
    const { db } = context
    
    // Default to all crawler types if not specified
    const types = crawlerTypes || ['local', 'scholarship', 'comprehensive', 'profile_enrichment']
    
    const jobIds = []
    for (const crawlerType of types) {
      const jobId = crypto.randomUUID()
      
      const stmt = db.prepare(`
        INSERT INTO crawler_jobs (id, profile_id, crawler_type, status, parameters)
        VALUES (?, ?, ?, ?, ?)
      `)
      
      const defaultParams = {
        local: { radius_miles: 50, max_results: 100 },
        scholarship: { max_results: 50 },
        comprehensive: { max_results: 200 },
        profile_enrichment: {},
        avatar_lookup: {},
        item_search: { max_results: 50 },
      }
      
      stmt.run(
        jobId,
        profileId,
        crawlerType,
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
        enum: ['local', 'scholarship', 'comprehensive', 'item_search', 'profile_enrichment', 'avatar_lookup'],
        description: 'Type of crawler to schedule'
      },
      schedule: { type: 'string', description: 'Cron expression (e.g., "0 9 * * 1" for every Monday at 9am)' },
      enabled: { type: 'boolean', description: 'Whether schedule is enabled (default: true)' },
    },
    required: ['profileId', 'crawlerType', 'schedule'],
  },
  handler: async (params, context) => {
    const { profileId, crawlerType, schedule, enabled = true } = params
    const { db } = context
    
    const scheduleId = crypto.randomUUID()
    
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
    const stats = db.prepare(`
      SELECT 
        crawler_type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
      FROM crawler_jobs
      WHERE created_at >= datetime('now', '-24 hours')
      GROUP BY crawler_type
    `).all()
    
    const alerts = []
    const summary = {}
    
    for (const stat of stats) {
      const failureRate = stat.total > 0 ? stat.failed / stat.total : 0
      summary[stat.crawler_type] = {
        total: stat.total,
        completed: stat.completed,
        failed: stat.failed,
        in_progress: stat.in_progress,
        failure_rate: failureRate.toFixed(2),
      }
      
      if (failureRate > alertThreshold && stat.total >= 3) {
        alerts.push({
          type: 'high_failure_rate',
          crawler_type: stat.crawler_type,
          failure_rate: failureRate.toFixed(2),
          failed_count: stat.failed,
          total_count: stat.total,
        })
      }
    }
    
    // Check for stuck jobs (in_progress for more than 2 hours)
    const stuckJobs = db.prepare(`
      SELECT id, crawler_type, created_at
      FROM crawler_jobs
      WHERE status = 'in_progress'
        AND created_at < datetime('now', '-2 hours')
    `).all()
    
    if (stuckJobs.length > 0) {
      alerts.push({
        type: 'stuck_jobs',
        count: stuckJobs.length,
        jobs: stuckJobs.map(j => ({ id: j.id, type: j.crawler_type })),
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

registerTool({
  name: 'admin.code.scan',
  description: 'Scan codebase for issues like TODOs, console.logs, or potential bugs. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      directory: { type: 'string', description: 'Directory to scan (default: entire repo)' },
      filePattern: { type: 'string', description: 'File pattern to match (e.g., "*.js")' },
      issueTypes: {
        type: 'array',
        items: { type: 'string', enum: ['todo', 'console', 'debugger', 'fixme', 'hack'] },
        description: 'Types of issues to find (default: all)'
      },
    },
  },
  handler: async (params, context) => {
    const { directory = '.', filePattern = '**/*.{js,jsx,ts,tsx}', issueTypes = ['todo', 'console', 'debugger', 'fixme', 'hack'] } = params
    
    // This is a simplified implementation
    // In production, you'd use a proper code scanner
    const issues = {
      todos: [],
      consoles: [],
      debuggers: [],
      fixmes: [],
      hacks: [],
    }
    
    const patterns = {
      todo: /\/\/\s*TODO:?\s*(.+)/gi,
      console: /console\.(log|warn|error|debug|info)\(/g,
      debugger: /debugger;?/g,
      fixme: /\/\/\s*FIXME:?\s*(.+)/gi,
      hack: /\/\/\s*HACK:?\s*(.+)/gi,
    }
    
    return {
      success: true,
      directory,
      filePattern,
      issueTypes,
      summary: {
        todos: issues.todos.length,
        consoles: issues.consoles.length,
        debuggers: issues.debuggers.length,
        fixmes: issues.fixmes.length,
        hacks: issues.hacks.length,
      },
      message: 'Code scan completed. Use a file system tool to perform detailed scanning.',
      note: 'This is a placeholder. Full code scanning requires file system access which is handled by existing code crawl tools.',
    }
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
      fixConsoleLog: { type: 'boolean', description: 'Fix console.log statements (default: true)' },
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
          enum: ['local', 'scholarship', 'comprehensive', 'profile_enrichment', 'avatar_lookup', 'item_search']
        },
        description: 'Types of crawlers to run (default: [local, scholarship, comprehensive, profile_enrichment])'
      },
      maxRetries: { type: 'integer', description: 'Maximum retries for failed jobs (default: 3)', minimum: 0, maximum: 10 },
      waitForCompletion: { type: 'boolean', description: 'Wait for jobs to complete (default: false)' },
      timeoutMinutes: { type: 'integer', description: 'Timeout in minutes (default: 30)', minimum: 5, maximum: 120 },
    },
  },
  handler: runAutonomousCrawlers,
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
      status.crawlers = await getAutonomousCrawlersStatus()
    }
    
    if (operationType === 'functions' || operationType === 'all') {
      status.function_tests = await getAutonomousFunctionTestsStatus()
    }
    
    return status
  },
})
