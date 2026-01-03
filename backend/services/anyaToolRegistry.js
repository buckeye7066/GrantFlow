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
               eligibility_bullets, categories, source, source_url, updated_at
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
               eligibility_bullets, categories, source, source_url, updated_at
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

function formatGrantSummaries(opportunities) {
  return opportunities.map((opp) => {
    const eligibility = cleanList(safeParseJSON(opp.eligibility_bullets, []))
    const categories = cleanList(safeParseJSON(opp.categories, []))
    const amountRange = formatAmountRange(opp.amount_min, opp.amount_max, opp.amount_description)
    const daysRemaining = daysUntil(opp.deadline)

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
        SELECT id, display_name, status
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
  const formatted = formatGrantSummaries(opportunities)

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
  description: 'Propose edits to a specific file (shows diff, does not auto-save). Admin only.',
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
