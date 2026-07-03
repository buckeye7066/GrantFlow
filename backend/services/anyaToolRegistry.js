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
import { ADMIN_EMAIL } from '../config/constants.js'

/**
 * HARD owner gate for Anya's most powerful tools (running other agents, editing
 * data, crawling). Stricter than requiresAdmin: ONLY the owner account
 * (ADMIN_EMAIL = buckeye7066@gmail.com) passes — no other admin, tier, or seat.
 */
function callerEmail(context) {
  const c = context?.ctx || {}
  const u = context?.user || {}
  return String(c.email || u.email || u.primary_email || '').trim().toLowerCase()
}
export function isOwnerCaller(context) {
  const owner = String(ADMIN_EMAIL || '').trim().toLowerCase()
  return Boolean(owner) && callerEmail(context) === owner
}
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
import { getBackgroundCodeCrawlState, startBackgroundCodeCrawlAndRepair } from './anyaAutonomousScheduler.js'
import { runMissionAudit } from './missionAuditService.js'
import { AUDIT_CATEGORIES, SEVERITY, logAuditEvent } from './auditService.js'
import { trustedOriginClause, trustedSourceClause } from '../utils/recordOrigins.js'
import { normalizeState, statesMatch } from '../utils/stateNormalization.js'
import { scoreOpportunity, computeMatchDecision } from './matchEngine.js'
import { loadProfileContext } from './profileHelpers.js'
import { searchWeb } from './shared/webSearchEngine.js'
import { searchLocalWebByProfile } from './shared/liveWebSearch.js'
import { syncProfileFieldsFromSection } from '../utils/profileSectionSync.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'
import {
  getFieldUsage,
  listFieldUsages,
  buildFieldUsageReport,
  forSection,
} from './profileFieldUsageRegistry.js'
import {
  generateActionPlan,
  createApplicationFromOpportunity,
  completeApplicationStep,
  APPLICATION_STATES,
} from './applicationWorkflow.js'

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

// Writing directives used by the LOI / needs statement / full application
// tools. Hoisted to the top of the module so registerTool() handlers can
// safely close over them regardless of declaration order. Keeping them
// here (not in handler bodies) avoids the temporal-dead-zone footgun.
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

async function summarizeGrants(db, params, context) {
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

  // Mission rule (Phase 3): Anya tools must use the FULL profile context, not
  // a thin DB row, so explanations are grounded in the same view the canonical
  // matcher sees. loadProfileContext returns { profile, sections, signals,
  // organization, documents } so the per-result explanations match what the
  // canonical decision engine produced.
  let context_profile
  try {
    context_profile = await loadProfileContext(db, profileId)
  } catch (err) {
    if (/not found/i.test(err?.message || '')) {
      throw new Error('Profile not found')
    }
    throw new Error(`Profile not found or unreadable: ${err?.message ?? err}`)
  }
  const profile = context_profile.profile
  const enrichedProfile = {
    ...profile,
    sections: context_profile.sections,
    organization: context_profile.organization,
    signals: context_profile.signals,
  }

  const limit = Math.max(1, Math.min(Number(params?.limit) || DEFAULT_GRANT_LIMIT, 10))
  const opportunities = collectGrantMatches(db, profileId, limit)
  const formatted = formatGrantSummaries(opportunities, enrichedProfile)

  // Re-run the canonical decision engine for each opportunity so the returned
  // explanation lines up with what matching/discovery would show. We attach
  // the matched_profile_facts payload so the UI/Anya can display "what facts
  // from your profile caused this" without re-deriving anything.
  for (let i = 0; i < formatted.length; i++) {
    try {
      const opp = opportunities[i]
      if (!opp) continue
      const decision = computeMatchDecision(
        context_profile.profile,
        opp,
        { profileSections: context_profile.sections, signals: context_profile.signals },
      )
      formatted[i].canonical_match = {
        score: decision.score,
        decision: decision.decision,
        confidence: decision.confidence,
        matched_profile_facts: decision.matched_profile_facts ?? [],
        ineligibility_reasons: decision.ineligibilityReasons ?? [],
        matcher_version: decision.matcherVersion,
      }
    } catch (decisionErr) {
      // Never fail the whole summary on a single bad row.
      formatted[i].canonical_match = { error: decisionErr?.message ?? String(decisionErr) }
    }
  }

  // profile_signal_audit lets the UI / Anya / tests answer "what did the
  // matcher actually use about this profile?". Mission rule (Phase 3).
  const signals = context_profile.signals ?? {}
  const profile_signal_audit = {
    profile_type: profile?.primary_type ?? profile?.applicant_type ?? null,
    location_used: [
      profile?.zip ? 'zip' : null,
      profile?.county ? 'county' : null,
      profile?.state ? 'state' : null,
    ].filter(Boolean),
    needs_used: Array.isArray(signals?.needs)
      ? signals.needs.slice(0, 12)
      : Array.from(signals?.needs ?? []).slice(0, 12),
    organization_used: profile?.organization_type
      ? [profile.organization_type]
      : [],
    documents_used: Array.isArray(context_profile?.documents)
      ? context_profile.documents.map((d) => d?.title || d?.filename).filter(Boolean).slice(0, 5)
      : [],
    sections_seen: Object.keys(context_profile?.sections ?? {}),
  }

  return {
    profile: {
      id: profile.id,
      display_name: profile.display_name,
      status: profile.status,
    },
    profile_facts_used: summarizeProfileFactsUsed(enrichedProfile),
    count: formatted.length,
    limit,
    opportunities: formatted,
    profile_signal_audit,
  }
}

/**
 * Surface the specific profile fields Anya actually saw when explaining matches.
 * Lets users (and admins) audit whether Anya is grounded in the real profile.
 */
function summarizeProfileFactsUsed(p) {
  const basic = p?.sections?.basic_information ?? {}
  const org = p?.organization ?? {}
  const sigLoc = p?.signals?.location ?? {}
  const needCategories = p?.signals?.needs ? Array.from(p.signals.needs) : []
  return {
    profile_type: p?.primary_type || p?.applicant_type || basic.profile_category || null,
    state: sigLoc.state || basic.state || p?.state || org.state || null,
    zip: sigLoc.zip || basic.zip || p?.postal_code || org.postal_code || null,
    city: sigLoc.city || basic.city || p?.city || org.city || null,
    organization_type: p?.organization_type || org.organization_type || null,
    serves_veterans: p?.serves_veterans ?? null,
    serves_disabled: p?.serves_disabled ?? null,
    section_count: p?.sections ? Object.keys(p.sections).length : 0,
    need_categories_detected: needCategories,
  }
}

export function registerTool({ name, description, schema, handler, requiresAdmin = false, requiresOwner = false }) {
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
    // Owner-gated tools are also admin-gated (defense in depth).
    requiresAdmin: Boolean(requiresAdmin) || Boolean(requiresOwner),
    requiresOwner: Boolean(requiresOwner),
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
  // Owner-gated tools are only even ADVERTISED to the owner account.
  const isOwner = isOwnerCaller({ ctx, user: ctx })
  return Array.from(tools.values())
    .filter((tool) => (!tool.requiresAdmin || isAdmin) && (!tool.requiresOwner || isOwner))
    .map(({ name, description, schema, requiresAdmin, requiresOwner }) => ({
      name,
      description,
      schema,
      requiresAdmin,
      requiresOwner,
    }))
}

function validateToolParams(tool, params) {
  const schema = tool?.schema
  const required = Array.isArray(schema?.required) ? schema.required : []
  for (const key of required) {
    const value = params?.[key]
    const missing =
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    if (missing) {
      const error = new Error(`Missing required parameter: ${key}`)
      error.status = 400
      throw error
    }
  }
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

    // HARD owner gate (stricter than admin): these powers run other agents /
    // edit data / crawl, so only the owner account may invoke them — enforced
    // server-side here, not just hidden from the tool list.
    if (tool.requiresOwner && !isOwnerCaller(context)) {
      const error = new Error(`Tool "${name}" is restricted to the owner account`)
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

  // Validate params AFTER the admin/owner gate so an unauthorized caller gets a
  // 403 — not a 400 that discloses an owner-only tool's required parameters
  // (the schema itself is already owner-only via listToolMetadata).
  validateToolParams(tool, params ?? {})

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
        // user_id FKs to users(id). Autonomous callers (Sam's diagnostics run
        // Anya tools as a synthetic actor like 'agent:sam'/'system_admin_token')
        // have no users row, so inserting their id FK-violated on EVERY call —
        // the usage row was lost (Anya undercounted for mission-goal grounding)
        // and the log was spammed. Persist the id only when it's a real user.
        const rawUserId = user.userId ?? user.id ?? null
        let usageUserId = null
        if (rawUserId !== null && rawUserId !== undefined) {
          try {
            const u = await db.prepare('SELECT 1 AS x FROM users WHERE id = ? LIMIT 1').get(String(rawUserId))
            if (u) usageUserId = String(rawUserId)
          } catch { usageUserId = null }
        }
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
            usageUserId,
            context?.profile_id ?? context?.profileId ?? null,
            JSON.stringify(params ?? {}).slice(0, 4000),
            ok ? 1 : 0,
            errorMessage,
            Date.now() - startedAt,
          )
      }
    } catch (persistErr) {
      // Never block tool execution on usage-log failures; warn once.
       
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
  name: 'crawlers.planForProfile',
  description:
    'Decides and EXPLAINS which discovery crawlers/sources will fire for a profile and WHY — from the profile type, derived applicant types, needs, location, AND high-precision keyword/phrase triggers in the profile text. Example: a profile whose mission says "volunteer fire department" or mentions "FEMA AFG" pulls in the FEMA AFG source even when its type field is generic, so a VFD never silently misses a FEMA grant. Returns selected sources, excluded sources with plain-language reasons, the keyword triggers that fired, real-funder vs directory breakdown, and coverage flags an operator should act on.',
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile ID to plan crawlers for.' },
      profile_id: { type: 'string', description: 'Alias for profileId.' },
    },
  },
  handler: async (params, context) => {
    if (!context?.db) {
      throw new Error('Database connection unavailable')
    }
    const profileId = String(params?.profileId || params?.profile_id || '').trim()
    if (!profileId) throw new Error('profileId is required')
    if (!ensureProfileAccess(context?.ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }
    const { explainCrawlerPlanForProfile } = await import('./crawlerPlanService.js')
    const plan = await explainCrawlerPlanForProfile(context.db, profileId)
    return { success: true, ...plan }
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

    // Use the CANONICAL decision engine (Mission System 2/8, RC-10) so Anya's
    // "why did this match?" explanation can never contradict the matcher /
    // discovery. Previously this handler hand-rolled applicant/location/keyword/
    // financial scoring with its own 70/40 buckets — a second, drifting match
    // authority. There is no bespoke scoring here anymore.
    let context_profile
    try {
      context_profile = await loadProfileContext(db, profileId)
    } catch (err) {
      if (/not found/i.test(err?.message || '')) {
        const error = new Error('Profile not found')
        error.status = 404
        throw error
      }
      throw new Error(`Profile not found or unreadable: ${err?.message ?? err}`)
    }

    const decision = computeMatchDecision(
      context_profile.profile,
      opp,
      { profileSections: context_profile.sections, signals: context_profile.signals },
    )

    const matches = (decision.matched_profile_facts ?? [])
      .filter(Boolean)
      .map((fact) => ({ signal: 'Profile match', detail: String(fact) }))
    const misses = [
      ...(decision.ineligibilityReasons ?? [])
        .filter(Boolean)
        .map((r) => ({ signal: 'Eligibility concern', detail: String(r) })),
      ...(decision.missingEligibilityFields ?? [])
        .filter(Boolean)
        .map((f) => ({ signal: 'Missing profile info', detail: `Add "${f}" to your profile to strengthen this match.` })),
    ]
    const neutral = []
    if (matches.length === 0 && misses.length === 0) {
      neutral.push({ signal: 'Match', detail: 'No specific match signals were recorded for this opportunity.' })
    }

    const scoreContext = decision.decision === 'ACCEPT'
      ? 'Strong match'
      : decision.decision === 'REVIEW'
        ? 'Worth reviewing'
        : 'Likely not a fit'

    return {
      opportunityId: opp.id,
      opportunityName: opp.title || opp.name,
      matchScore: decision.score ?? null,
      decision: decision.decision,
      scoreContext,
      matches,
      misses,
      neutral,
      matcher_version: decision.matcherVersion,
      summary: matches.length > 0
        ? `This is a ${scoreContext.toLowerCase()} (engine decision: ${decision.decision}). It matched on: ${matches.map((m) => m.detail).slice(0, 5).join('; ')}.`
        : `Engine decision: ${decision.decision}. ${misses.length ? 'Concerns: ' + misses.map((m) => m.detail).slice(0, 3).join('; ') : 'No strong match signals found — review the opportunity details.'}`,
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
  description: 'Update a specific profile section with data gathered from conversation. Use this when the user provides information about themselves (location, finances, health, employment, etc.) and you want to save it to their profile. Merge-safe: only provided fields are updated; existing data is preserved. Pass confirmed:true ONLY after the user has explicitly approved the change; otherwise the call returns a confirmation request.',
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
      confirmed: {
        type: 'boolean',
        description: 'Set to true ONLY after the user has explicitly approved the update. Default: false (returns confirmation_required:true and does not write).',
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
    const confirmed = params?.confirmed === true

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

    // Phase 8 mission rule: require user confirmation before Anya writes
    // sensitive profile changes. When the caller has not set confirmed:true,
    // return a structured confirmation_required payload instead of writing.
    if (!confirmed) {
      return {
        confirmation_required: true,
        profileId,
        sectionKey,
        fields,
        message: `I'm about to save these changes to your "${sectionKey}" section. Confirm to proceed.`,
        next_call: {
          tool: 'profile.updateSection',
          params: { profileId, sectionKey, fields, confirmed: true },
        },
      }
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
    const guarded = await guardProfileSectionForWrite(db, profileId, sectionKey, merged)

    const updatedBy = ctx?.email || ctx?.userId || 'anya-guided'
    await db.prepare(`
      INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, section_key) DO UPDATE SET
        data = excluded.data,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(profileId, sectionKey, JSON.stringify(guarded.data), updatedBy)

    // v4: Sync key fields (state, veteran, disability) to profiles table
    try {
      syncProfileFieldsFromSection(db, profileId, sectionKey, guarded.data)
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

// ----------------------------------------------------------------------------
// Student-only: commit to (or uncommit from) a single university.
//
// This is the action behind the user-facing "I'm attending MTSU" button —
// only here it is exposed as an Anya tool so the assistant can do the
// thing instead of describing it. When a student tells Anya "I want only
// MTSU" / "I picked MTSU" / "I committed to Tennessee Tech", Anya calls
// this tool with the school name; the handler resolves the matching
// application in `university_applications.applications`, marks it as
// `committed`, and downgrades every still-active sibling application to
// `deferred` so the funding feed narrows the way the UI does. The
// vocabulary mirrors COMMITTED_SCHOOL_STATUSES in
// backend/services/crawlers/crawlerManager.js and isCommittedStatus in
// src/components/profiles/UniversityApplicationsSection.jsx — keep the
// three in lockstep.
registerTool({
  name: 'student.commitToUniversity',
  description: 'Mark a single university application as the school the student is attending (status="committed"). Other still-active applications are moved to "deferred" so school-specific funding cards (financial aid, housing, scholarships) narrow to the chosen school. This is the same action as clicking "I\'m attending" on a school card. Pass `name` (or `applicationId`) for the school to commit to. Pass `confirmed:true` ONLY after the user has explicitly approved the change. If the user just wants to undo a previous commit, pass `unset:true` to move the school back to "planning" and restore the funding feed.',
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The student profile to update.' },
      name: { type: 'string', description: 'The school name (or fragment, e.g., "MTSU", "Middle Tennessee", "Trevecca"). Case-insensitive partial match is allowed.' },
      applicationId: { type: 'string', description: 'Optional explicit university_applications.applications[].id if the assistant already has it.' },
      unset: { type: 'boolean', description: 'When true, uncommit (set back to "planning") instead of committing. Defaults to false.' },
      confirmed: { type: 'boolean', description: 'Set to true ONLY after the user has explicitly approved the change. Default false → returns confirmation_required:true.' },
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
      const error = new Error('Not authorized to update this profile')
      error.status = 403
      throw error
    }

    const COMMITTED_STATUSES = new Set(['committed', 'enrolled', 'attending'])
    const STILL_ACTIVE = new Set([
      'planning',
      'interested',
      'in_progress',
      'submitted',
      'accepted',
      'waitlisted',
    ])

    // Load the existing university_applications section. If it doesn't
    // exist yet, that's a hard "nothing to commit to" — be explicit so
    // Anya tells the user instead of silently inventing a school. (Mission
    // rule: never claim to do something we didn't actually do.)
    let existing = { applications: [] }
    try {
      const row = await db
        .prepare(`SELECT data FROM profile_sections WHERE profile_id = ? AND section_key = ?`)
        .get(profileId, 'university_applications')
      if (row?.data) {
        const parsed = JSON.parse(row.data)
        existing = parsed && typeof parsed === 'object' ? parsed : { applications: [] }
      }
    } catch (e) {
      console.warn('[student.commitToUniversity] failed to load section:', e?.message)
    }
    const apps = Array.isArray(existing?.applications) ? existing.applications : []

    if (apps.length === 0) {
      return {
        committed: false,
        reason: 'no_applications',
        message:
          'There are no universities tracked on this profile yet, so I cannot mark a school as the one you are attending. Add the school to the Universities tab first, then I can commit it for you.',
      }
    }

    const rawName = typeof params?.name === 'string' ? params.name.trim() : ''
    const explicitId = params?.applicationId ? String(params.applicationId).trim() : ''
    const unset = params?.unset === true

    // Resolve the target application by id first, then by case-insensitive
    // contains-match on `name`. The contains-match handles "MTSU" /
    // "Middle Tennessee" / "Tennessee State" the way a student would
    // actually type it.
    let target = null
    if (explicitId) {
      target = apps.find((a) => String(a?.id || '') === explicitId) ?? null
    }
    if (!target && rawName) {
      const q = rawName.toLowerCase()
      const exact = apps.find((a) => String(a?.name || '').toLowerCase() === q)
      target = exact ?? apps.find((a) => String(a?.name || '').toLowerCase().includes(q)) ?? null
      // MTSU is an extremely common abbreviation — if the user typed
      // "mtsu" and we still couldn't find it, try the canonical full name
      // before giving up.
      if (!target && q === 'mtsu') {
        target = apps.find((a) => String(a?.name || '').toLowerCase().includes('middle tennessee')) ?? null
      }
    }
    if (!target) {
      return {
        committed: false,
        reason: 'school_not_found',
        message: rawName
          ? `I could not find "${rawName}" in the universities tracked on this profile. The schools on file are: ${apps
              .map((a) => a?.name || '(unnamed)')
              .filter(Boolean)
              .join(', ')}. Tell me which one you mean and I will commit to it.`
          : 'Tell me which school you want to mark as the one you are attending — I need a name or id to commit to.',
        availableSchools: apps.map((a) => ({ id: a?.id ?? null, name: a?.name ?? null, status: a?.status ?? null })),
      }
    }

    // Confirmation gate (mission rule: do not write profile changes
    // without explicit user approval). When unset:true the same gate
    // applies — uncommitting is also a profile mutation.
    const confirmed = params?.confirmed === true
    if (!confirmed) {
      return {
        confirmation_required: true,
        action: unset ? 'uncommit' : 'commit',
        target: { id: target.id, name: target.name, status: target.status ?? null },
        message: unset
          ? `Want me to move ${target.name} back to "planning"? That will bring all schools' funding cards back into your feed.`
          : `Want me to mark ${target.name} as the school you are attending? Other still-active applications will move to "deferred" so the funding feed narrows to ${target.name}.`,
        next_call: {
          tool: 'student.commitToUniversity',
          params: {
            profileId,
            applicationId: target.id,
            unset,
            confirmed: true,
          },
        },
      }
    }

    // Apply the change — narrow / widen the funding feed to match the
    // student's real decision. (Mirrors handleCommitToSchool /
    // handleUncommitSchool in UniversityApplicationsSection.jsx so the UI
    // and the chat path always produce the same result.)
    const nextApps = apps.map((app) => {
      if (String(app?.id || '') !== String(target.id)) {
        if (!unset && STILL_ACTIVE.has(String(app?.status || '').toLowerCase())) {
          return { ...app, status: 'deferred' }
        }
        return app
      }
      return { ...app, status: unset ? 'planning' : 'committed' }
    })
    const nextSection = { ...existing, applications: nextApps }

    const guarded = await guardProfileSectionForWrite(
      db,
      profileId,
      'university_applications',
      nextSection,
    )

    const updatedBy = ctx?.email || ctx?.userId || 'anya-commit-school'
    await db
      .prepare(
        `INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, section_key) DO UPDATE SET
           data = excluded.data,
           updated_by = excluded.updated_by,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(profileId, 'university_applications', JSON.stringify(guarded.data), updatedBy)

    const committedNames = nextApps
      .filter((a) => COMMITTED_STATUSES.has(String(a?.status || '').toLowerCase()))
      .map((a) => a?.name || '(unnamed)')

    return {
      committed: !unset,
      action: unset ? 'uncommit' : 'commit',
      target: { id: target.id, name: target.name, status: unset ? 'planning' : 'committed' },
      committedSchools: committedNames,
      message: unset
        ? `Done — ${target.name} is back to "planning" and all schools' funding cards are visible in the feed again.`
        : `Done — ${target.name} is marked as the school you are attending. Other still-active applications were moved to "deferred", and the funding feed is now scoped to ${target.name}.`,
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

registerTool({
  name: 'profile.thresholdReport',
  description: "Show what this profile QUALIFIES for and what it ALMOST qualifies for: every pipeline source with an explicit numeric requirement (ACT, SAT, GPA, income cap, age) compared against the profile's own facts, with the exact gap (e.g. 'needs ACT 29 — has 28') and the application link. Use when the user asks what they're eligible for, why they don't qualify for something, or what would open more funding.",
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile ID to analyze.' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    if (!context?.db) throw new Error('Database connection unavailable')
    const ctx = context?.ctx
    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')
    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }
    const { buildThresholdReport } = await import('./eligibility/thresholdAnalyzer.js')
    const report = await buildThresholdReport(context.db, profileId)
    return {
      ...report,
      guidance: report.near.length > 0
        ? 'Explain each near-miss in plain language: what number the source wants, what the profile shows, and the concrete move that crosses it (retake, better semester, corrected fact). Point to the application link when one exists.'
        : 'No near-misses with explicit numeric thresholds right now. Qualified items clear their stated bars; sources without explicit thresholds are not analyzed (never guess).',
    }
  },
})

// ============================================================================
// Phase 8: Anya as in-app guide — page-aware "what should I do next?" tool
// ============================================================================

registerTool({
  name: 'anya.nextBestAction',
  description: "Returns the recommended next action for the active profile, grounded in the current page, the active opportunity (if any), profile gaps, and the application workflow state. Use this when the user asks 'what should I do next?', 'where do I start?', or after they save an opportunity. Returns: actions[] (each with title, why, and optional tool_call), reasons[], confidence.",
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: "Profile ID. Defaults to the user's active profile." },
      pageContext: {
        type: 'object',
        description: 'Optional page snapshot (currentPage, selectedOpportunityId, selectedApplicationId, selectedStepId). When omitted, the orchestrator-supplied pageContext is used.',
      },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection unavailable')
    const ctx = context?.ctx
    const profileId =
      (params?.profileId && String(params.profileId).trim()) ||
      (ctx?.activeProfileId ? String(ctx.activeProfileId).trim() : null)

    if (!profileId) {
      return {
        actions: [
          {
            title: 'Pick or create a profile',
            why: 'GrantFlow needs a profile to ground all matching, document checklists, and Anya guidance.',
          },
        ],
        reasons: ['no_active_profile'],
        confidence: 100,
      }
    }
    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }

    let profileContext
    try {
      profileContext = await loadProfileContext(db, profileId)
    } catch (err) {
      throw new Error(`Profile not found or unreadable: ${err?.message ?? err}`)
    }
    const profile = profileContext.profile

    // Page context can come from the orchestrator (forwarded from the
    // frontend "current screen") or from the explicit param. The param wins.
    const liveCtx = params?.pageContext ?? context?.pageContext ?? null
    const currentPage = String(liveCtx?.currentPage ?? context?.currentPage ?? '').trim() || null
    const selectedOpportunityId = liveCtx?.selectedOpportunityId
      ? String(liveCtx.selectedOpportunityId)
      : null
    const selectedApplicationId = liveCtx?.selectedApplicationId
      ? String(liveCtx.selectedApplicationId)
      : null

    const actions = []
    const reasons = []

    // 1) Profile-completeness gap (mission rule: every result must answer
    //    "what facts caused this?", which means filling in the basics first).
    const missingHighValue = []
    if (!profile?.state) missingHighValue.push('state')
    if (!profile?.zip && !profile?.zip_code && !profile?.postal_code) missingHighValue.push('zip')
    if (!profile?.organization_type && !profile?.applicant_type && !profile?.primary_type) {
      missingHighValue.push('applicant_type')
    }
    if (missingHighValue.length > 0) {
      actions.push({
        title: `Fill in your profile: ${missingHighValue.join(', ')}`,
        why: 'These fields directly drive geographic and category matching. Without them GrantFlow falls back to broad coverage.',
        tool_call: {
          tool: 'profile.updateSection',
          params: { profileId, sectionKey: 'basic_information', fields: {}, confirmed: false },
        },
      })
      reasons.push('missing_high_value_profile_fields')
    }

    // 2) Active application — surface next pending step if we know one.
    if (selectedApplicationId) {
      try {
        const step = await db
          .prepare(
            `SELECT id, title, status FROM application_steps
             WHERE application_id = ? AND status = 'pending'
             ORDER BY step_order ASC LIMIT 1`,
          )
          .get(selectedApplicationId)
        if (step) {
          actions.push({
            title: `Next step in this application: "${step.title}"`,
            why: 'This is the first remaining checklist item for the application you have open.',
            tool_call: {
              tool: 'application.completeStep',
              params: { stepId: step.id, applicationId: selectedApplicationId },
            },
          })
          reasons.push('pending_application_step')
        }
      } catch { /* table may not exist in some envs */ }
    }

    // 3) Selected opportunity — offer to save it as an application.
    if (selectedOpportunityId && !selectedApplicationId) {
      actions.push({
        title: 'Save this opportunity to your pipeline and start an application plan',
        why: 'Saving turns this opportunity into an application with a document checklist and deadline reminders.',
        tool_call: {
          tool: 'application.createFromOpportunity',
          params: { profileId, opportunityId: selectedOpportunityId },
        },
      })
      reasons.push('selected_opportunity_unsaved')
    }

    // 4) Page-specific defaults.
    if (currentPage === 'DiscoverGrants' && actions.length === 0) {
      actions.push({
        title: 'Run a search and review the top matches',
        why: 'You are on the discovery page — the highest-leverage next move is to scan the current results and save the ones that look like a fit.',
      })
      reasons.push('on_discover_page')
    }

    if (actions.length === 0) {
      actions.push({
        title: 'Open Discover Grants and review your latest matches',
        why: 'This is the default starting point when nothing else is currently in progress.',
      })
      reasons.push('default_action')
    }

    return {
      profileId,
      currentPage,
      selectedOpportunityId,
      selectedApplicationId,
      actions,
      reasons,
      confidence: actions.length > 0 ? 80 : 40,
    }
  },
})

// ============================================================================
// Application workflow — Anya-callable wrappers around applicationWorkflow.js
// ============================================================================
//
// Mission rule (Phase H): Anya must be able to *act* on the next-best-action
// recommendations she surfaces. nextBestAction returns tool_call payloads
// referencing `application.createFromOpportunity` and `application.completeStep`;
// these registrations make those calls real, grounded, DB-persistent
// operations rather than dangling references.

registerTool({
  name: 'application.createFromOpportunity',
  description: "Creates (or returns the existing) application for the active profile + opportunity. Persists the application record, generates the initial action plan (steps + documents + deadlines), and returns the application id plus the freshly generated plan. Idempotent on (profile_id, opportunity_id). Use this after the user confirms 'save this opportunity' so Anya can actually start the workflow.",
  schema: {
    type: 'object',
    required: ['opportunityId'],
    properties: {
      profileId: { type: 'string', description: "Profile ID. Defaults to the user's active profile." },
      opportunityId: { type: 'string', description: 'Opportunity ID returned by discovery / saved grants.' },
      opportunity: {
        type: 'object',
        description: 'Optional inline opportunity payload (used when the row is not yet persisted server-side, e.g. from a fresh real-time crawl). Must include id + title at minimum.',
      },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection unavailable')
    const ctx = context?.ctx
    const profileId =
      (params?.profileId && String(params.profileId).trim()) ||
      (ctx?.activeProfileId ? String(ctx.activeProfileId).trim() : null)
    if (!profileId) throw new Error('Profile id required')
    if (!ensureProfileAccess(ctx, profileId)) {
      const error = new Error('Not authorized to act on this profile')
      error.status = 403
      throw error
    }
    const opportunityId = params?.opportunityId ? String(params.opportunityId) : null
    if (!opportunityId) throw new Error('opportunityId required')

    // Prefer the inline payload when provided (avoids a redundant DB lookup);
    // otherwise fetch the canonical row.
    let opp = params?.opportunity ?? null
    if (!opp) {
      try {
        opp = await db
          .prepare('SELECT * FROM funding_opportunities WHERE id = ?')
          .get(opportunityId)
      } catch {
        opp = null
      }
    }
    if (!opp || !opp.id) {
      throw new Error(`Opportunity ${opportunityId} not found`)
    }

    let profileContext = null
    try {
      profileContext = await loadProfileContext(db, profileId)
    } catch {
      profileContext = { profile: { id: profileId } }
    }

    const result = await createApplicationFromOpportunity(db, {
      profileId,
      userId: ctx?.userId ?? 'anya',
      opportunity: opp,
      profileContext,
    })

    const plan = generateActionPlan(opp, profileContext)
    return {
      application_id: result.id,
      created: result.created,
      profile_id: profileId,
      opportunity_id: opportunityId,
      plan,
      // Mission rule (Phase H): Anya must NOT promise funding. Surface the
      // reality of an application: this is a plan, not an award.
      disclaimer: 'GrantFlow does not guarantee that this opportunity will be awarded. The plan below is a checklist + deadline tracker so you know what to prepare and by when.',
      // Make the canonical opportunity kind explicit so downstream UI /
      // explanation paths can label direct vs benefit vs directory vs
      // referral vs school portal.
      opportunity_kind: opp.opportunity_kind ?? opp.kind ?? 'direct',
    }
  },
})

registerTool({
  name: 'application.completeStep',
  description: "Marks the given application step as completed. Use this when the user tells Anya they finished a checklist item (e.g. 'I uploaded the SAM.gov registration confirmation'). Returns the updated step + the next pending step in the same application so Anya can immediately surface 'what comes next'.",
  schema: {
    type: 'object',
    required: ['stepId'],
    properties: {
      applicationId: { type: 'string', description: 'Application ID. Used to look up the next pending step after completion.' },
      stepId: { type: 'string', description: 'application_steps.id of the step to mark complete.' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection unavailable')
    const stepId = params?.stepId ? String(params.stepId) : null
    if (!stepId) throw new Error('stepId required')
    await completeApplicationStep(db, stepId)

    let nextStep = null
    let applicationId = params?.applicationId ? String(params.applicationId) : null
    try {
      // Resolve applicationId from the step row if the caller didn't pass it.
      if (!applicationId) {
        const row = await db
          .prepare('SELECT application_id FROM application_steps WHERE id = ?')
          .get(stepId)
        applicationId = row?.application_id ?? null
      }
      if (applicationId) {
        nextStep = await db
          .prepare(
            `SELECT id, title, status, step_order
               FROM application_steps
              WHERE application_id = ? AND status = 'pending'
              ORDER BY step_order ASC LIMIT 1`,
          )
          .get(applicationId)
      }
    } catch {
      // Schema may be partial in tests — degrade gracefully.
    }

    return {
      step_id: stepId,
      application_id: applicationId,
      next_step: nextStep ?? null,
      application_states: APPLICATION_STATES,
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
  description: 'Propose or apply code-error edits to any repository file. Set save=true to apply changes with automatic backup and audit log. Admin only.',
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
      dryRun: { type: 'boolean', description: 'If true, validate without writing. Empty changes returns file metadata.' },
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
      crawlerType: {
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
      type: { type: 'string', description: 'Deprecated alias for crawlerType' },
      profileId: { type: 'string', description: 'Profile ID to run crawler for' },
      parameters: { type: 'object', description: 'Additional crawler parameters' },
    },
    required: ['crawlerType'],
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
      lastN: { type: 'integer', minimum: 1, maximum: 1000, description: 'Deprecated alias for limit' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max jobs to inspect' },
      since: { type: 'string', description: 'ISO-8601 timestamp lower bound for created_at, e.g. 2026-04-25T00:00:00Z' },
      status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed', 'cancelled'] },
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

/**
 * Live web search for funding — the same canonical engine the discovery
 * pipeline and Yana use (services/shared/webSearchEngine.js: Brave when
 * BRAVE_SEARCH_API_KEY is set, else keyless DuckDuckGo).
 *
 * Two modes, combinable:
 *   - `profileId`: profile-driven funding LEADS (geography + needs + type →
 *     funding queries), via searchLocalWebByProfile. Best for "find local
 *     funding for this person/org".
 *   - `query`: a direct free-text web search. Best for ad-hoc lookups.
 *
 * Owner-gated (requiresOwner): touches the live web, mirroring the cautious
 * live-web posture of the rest of the system. Results are raw web findings /
 * unverified leads — Anya should present them as "discovered on the web, verify
 * before relying on them", never as confirmed opportunities.
 */
async function anyaWebSearch({ query, profileId, limit = 8 } = {}, context) {
  const { db } = context || {}
  const out = { query: query ?? null, profile_id: profileId ?? null }

  if (profileId) {
    if (!db) throw new Error('Database connection unavailable')
    const profileContext = await loadProfileContext(db, profileId)
    const { opportunities, debug } = await searchLocalWebByProfile(profileContext, {})
    out.profile_queries = debug?.queries ?? []
    out.profile_leads = opportunities.map((o) => ({
      title: o.title,
      url: o.url,
      sponsor: o.sponsor,
      description: o.description,
      matched_terms: o.matched_terms,
    }))
  }

  const q = String(query ?? '').trim()
  if (q) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 15))
    out.results = await searchWeb(q, { count: safeLimit })
  }

  out.count = (out.results?.length || 0) + (out.profile_leads?.length || 0)
  if (out.count === 0) {
    out.note = 'No web results. The web search is best-effort (DuckDuckGo unless a Brave key is set) and may be rate-limited.'
  }
  return out
}

registerTool({
  name: 'web.search',
  description:
    'Search the live web for funding. Pass `profileId` to discover local/non-federal funding LEADS driven by that profile (geography + needs + type), and/or `query` for a direct web search. Results are unverified web findings — present them as "discovered on the web, verify before relying". Owner only.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text web search query (e.g. "Bradley County TN EMS scholarship").' },
      profileId: { type: 'string', description: 'Profile ID — runs profile-driven funding-lead discovery for this profile.' },
      limit: { type: 'integer', minimum: 1, maximum: 15, description: 'Max results for a direct `query` search (default 8).' },
    },
  },
  handler: anyaWebSearch,
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

// Makes the crawler-error benign-vs-real split observable to Anya (and via the
// Sam crawler.recentJobErrors check, to diagnostics). Anya can answer "are
// there any real crawler errors?" without the dashboard reading red on an
// expected missing_item_request-class skip.
registerTool({
  name: 'admin.crawler.errorBreakdown',
  description: 'Recent crawler job/log errors split into REAL failures vs. benign expected skips (e.g. missing_item_request). Admin only, read-only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {},
  },
  handler: async (_params, context) => {
    const { getSystemDiagnostics } = await import('./diagnosticsService.js')
    const diag = await getSystemDiagnostics(context.db)
    const counts = diag?.error_counts || { total: 0, real: 0, benign: 0 }
    // Surface as findings[] so Sam can mine the same shape if it delegates here.
    const findings = (diag?.real_errors || []).slice(0, 50).map((e) => ({
      severity: 'medium',
      title: `Real crawler error: ${e.crawler_type || e.source || e.scope}`,
      description: e.message || 'Unknown error',
      evidence: { scope: e.scope, time: e.time },
    }))
    return {
      ok: true,
      success: true,
      counts,
      real_errors: diag?.real_errors || [],
      benign_errors: diag?.benign_errors || [],
      findings,
      message: `${counts.real} real crawler error(s), ${counts.benign} benign skip(s) in the last 7 days.`,
    }
  },
})

import { scanHamiltonSessionReadiness } from './hamilton/hamiltonScheduleService.js'

// Makes the session-import + scheduling capability observable to the agents:
// Anya can answer "which portals need a login session" and Sam mines the
// findings[] into diagnostics (see samRegistry hamilton.sessionReadiness).
registerTool({
  name: 'admin.hamilton.sessionReadiness',
  description: 'Lists profiles with active Hamilton application work whose portals need a login session captured (runs that will stall on login/2FA). Read-only. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Max active profiles to scan (default 500).' },
    },
  },
  handler: async ({ limit } = {}, context) => scanHamiltonSessionReadiness(context?.db, { limit }),
})

import {
  scanPortalAutopilotReadiness,
  runAutopilotIdentityForProfile,
  runAutopilotIdentityForPortal,
} from './hamilton/hamiltonPortalAutopilotIdentity.js'
import {
  setMasterPassphrase as setPortalMasterPassphrase,
  setAutopilotIdentity as setPortalAutopilotIdentity,
} from './hamilton/hamiltonPortalMasterVault.js'

// Makes the Portal Autopilot Identity capability observable to the agents: Anya
// can answer "which portals need a master passphrase / unlock / human handoff"
// and Sam mines the findings[] (see samRegistry hamilton.portalAutopilotReadiness).
registerTool({
  name: 'admin.hamilton.portalAutopilotReadiness',
  description: 'Lists profiles/portals where Hamilton\'s Portal Autopilot Identity needs attention: vault locked, identity proofing required (human handoff), or no master passphrase set. Read-only. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 2000, description: 'Max active profiles to scan (default 500).' },
    },
  },
  handler: async ({ limit } = {}, context) => scanPortalAutopilotReadiness(context?.db, { limit }),
})

import {
  getProfilePreferredLanguageAsync,
  scanProfileLanguageReadiness,
} from './languagePreference.js'
import { languageEnglishName, normalizeLanguageCode } from '../../shared/languages.js'

// Makes the per-profile preferred-language setting observable + usable by the
// agents — the consume side of the i18n onboarding work. Anya reads it (and
// already injects a "respond ONLY in <language>" directive built from it into
// her system prompt); this tool lets her also answer "what language is this
// profile set to?" directly. Profile-scoped (non-admin) via ensureProfileAccess.
registerTool({
  name: 'profile.getPreferredLanguage',
  description: "Get a profile's preferred language (the choice made in onboarding). Returns the ISO code, its English name, and whether it is the English default. Use it to confirm which language to respond in.",
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'The profile ID to check.' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    if (!context?.db) throw new Error('Database connection unavailable')
    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')
    if (!ensureProfileAccess(context?.ctx, profileId)) {
      const error = new Error('Not authorized to view this profile')
      error.status = 403
      throw error
    }
    const code = normalizeLanguageCode(await getProfilePreferredLanguageAsync(context.db, profileId))
    return {
      profileId,
      preferred_language: code,
      language_name: languageEnglishName(code),
      is_default: code === 'en',
    }
  },
})

// Makes the language preference observable to Sam: scans profiles for their
// stored language and flags any unsupported codes that silently degrade to
// English. Sam mines findings[] into diagnostics (see samRegistry
// profile.languageReadiness). Read-only. Admin only.
registerTool({
  name: 'admin.profile.languageReadiness',
  description: 'Audits stored per-profile language preferences: reports how many profiles chose a non-English language (with the distribution) and flags any profile whose stored language code is unsupported (so it is being answered in English instead of the chosen language). Read-only. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Max profiles to scan (default 1000, newest first).' },
    },
  },
  handler: async ({ limit } = {}, context) => scanProfileLanguageReadiness(context?.db, { limit }),
})

// Makes Award Compliance & Restriction Tracking observable to the agents:
// Anya can answer "which awards are overdue / short on required spending" and
// Sam mines the findings[] into diagnostics (see samRegistry award.compliance).
// Read-only; never auto-marks anything compliant — "met" requires logged
// spend entries summing to the requirement.
registerTool({
  name: 'admin.compliance.overdue',
  description: 'Lists awarded funding restrictions that are OVERDUE, SHORT on required spending, or OVER an exact-category requirement (potential non-compliance). Read-only. Admin only.',
  requiresAdmin: true,
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Max rules to scan (default 1000).' },
    },
  },
  handler: async ({ limit } = {}, context) => {
    const { scanAwardComplianceFindings } = await import('./awardCompliance/awardComplianceStore.js')
    return scanAwardComplianceFindings(context?.db, { limit })
  },
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
    
    const types = crawlerTypes || ['local', 'scholarship', 'comprehensive', 'profile_enrichment']
    const profiles = [{ id: profileId }]
    
    const jobIds = []
    for (const profile of profiles) {
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
          profile.id,
          'queued',
          JSON.stringify(defaultParams[crawlerType] || {})
        )
      
        jobIds.push({ type: crawlerType, profileId: profile.id, jobId })
      }
    }
    
    return {
      success: true,
      profileId: profileId ?? null,
      profilesTriggered: profiles.length,
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
    required: ['profileId'],
  },
  handler: async (params, context) => {
    const { profileId, crawlerType = 'local', schedule = '0 9 * * 1', enabled = true } = params
    const { db } = context
    
    const profiles = [{ id: profileId }]
    const schedules = []
    
    const stmt = db.prepare(`
      INSERT INTO crawler_schedules (id, profile_id, crawler_type, schedule_cron, enabled)
      VALUES (?, ?, ?, ?, ?)
    `)
    
    for (const profile of profiles) {
      const scheduleId = randomUUID()
      stmt.run(scheduleId, profile.id, crawlerType, schedule, enabled ? 1 : 0)
      schedules.push({ scheduleId, profileId: profile.id })
    }
    
    return {
      success: true,
      scheduleId: schedules[0]?.scheduleId ?? null,
      profileId: profileId ?? null,
      profilesScheduled: profiles.length,
      schedules,
      crawlerType,
      schedule,
      enabled,
      message: `Scheduled ${crawlerType} crawler for ${profiles.length} profile(s) with cron: ${schedule}`,
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
      maxIterations: { type: 'integer', description: 'Maximum number of files to process (default: 2000)', minimum: 1, maximum: 5000 },
      maxFileChanges: { type: 'integer', description: 'Maximum number of files to modify (default: 20)', minimum: 1, maximum: 100 },
      dryRun: { type: 'boolean', description: 'If true, dont save changes (default: true when omitted)' },
      fixConsoleLog: { type: 'boolean', description: 'Fix debug console.log statements (default: true)' },
      fixEmptyCatch: { type: 'boolean', description: 'Fix empty catch blocks (default: false)' },
      fixTodos: { type: 'boolean', description: 'Convert TODO comments to tracked issues (default: false)' },
    },
  },
  // Code crawl + repair scans ~1100 files and runs for 1–2 minutes — far longer
  // than the gateway/HTTP timeout. Running it inline made the admin chat call
  // fail with "the server took too long to respond" even though the work
  // succeeded in the background. Dispatch it fire-and-forget and return
  // immediately; the caller polls admin.anya.getStatus →
  // background_code_crawl_repair for live progress + the final result.
  handler: async (_params, context) => {
    const existing = getBackgroundCodeCrawlState()
    if (existing?.running) {
      return {
        started: false,
        already_running: true,
        startedAt: existing.startedAt,
        message:
          'A code crawl & repair run is already in progress. Poll ' +
          'admin.anya.getStatus (operationType="code") → background_code_crawl_repair for progress.',
      }
    }
    const result = startBackgroundCodeCrawlAndRepair({ db: context?.db ?? null, user: context?.user ?? null })
    return {
      started: result?.queued !== false,
      async: true,
      ...result,
      message:
        'Code crawl & repair started in the background (scans ~1,100 files; ~1–2 min). ' +
        'It runs without blocking this chat. Poll admin.anya.getStatus ' +
        '(operationType="code") → background_code_crawl_repair for live progress and the final result.',
    }
  },
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
  description: 'Test all API endpoints and functions systematically and report which fail. Reports findings only — it does not auto-fix errors. Admin only.',
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
      componentPath: { type: 'string', description: 'Path or comma-separated paths to component directories (default: frontend/src/components,src/components)' },
      componentPaths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Component directories to scan',
      },
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

function resolveBrainScopeId(scope, context) {
  const user = context?.user ?? null
  if (scope === 'user') {
    return user?.userId ?? user?.id ?? null
  }
  if (scope === 'profile') {
    return user?.profileId ?? context?.profileId ?? null
  }
  return null
}

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
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')

    const { key, content, scope, memoryType = 'fact', expiresInDays } = params
    const finalScope = scope || 'global'
    const scopeId = resolveBrainScopeId(finalScope, context)

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null

    return await storeMemory(db, {
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
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')

    const { key, scope = 'global' } = params
    const scopeId = resolveBrainScopeId(scope, context)
    const memory = await getMemory(db, { scope, scopeId, memoryKey: key })
    
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
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')

    const { scope = 'global', memoryType, limit = 20 } = params
    const scopeId = resolveBrainScopeId(scope, context)
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
    
    return await deleteMemory(db, { scope, scopeId, memoryKey: key })
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
    
    return await getBrainSummary(db, {
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
    properties: {
      dryRun: { type: 'boolean', description: 'Return cleanup counts without deleting rows' },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')
    
    return await cleanupBrain(db, { dryRun: params?.dryRun === true })
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

    const brainTables = [
      'anya_brain_memory',
      'anya_context',
      'anya_messages',
      'anya_runs',
      'anya_run_logs',
      'anya_sessions',
      'anya_tasks',
      'anya_tool_usage',
    ]
    const tables = {}
    for (const tableName of brainTables) {
      try {
        const countRow = await db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get()
        let lastActivity = null
        for (const column of ['updated_at', 'created_at', 'ts']) {
          try {
            const row = await db.prepare(`SELECT MAX(${column}) AS last_activity FROM ${tableName}`).get()
            if (row?.last_activity) {
              lastActivity = row.last_activity
              break
            }
          } catch {
            // Try the next known timestamp column.
          }
        }
        tables[tableName] = {
          count: Number(countRow?.count || 0),
          last_activity: lastActivity,
        }
      } catch (error) {
        tables[tableName] = {
          count: 0,
          last_activity: null,
          error: error?.message || String(error),
        }
      }
    }

    const { toolName, limit = 50 } = params
    return {
      generated_at: new Date().toISOString(),
      tables,
      tool_usage: await getToolUsageStats(db, { toolName, limit }),
    }
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

// Shared generator for the grant-writing tools below. These tools previously
// returned only a writingDirective + raw data — so invoking them produced NO
// document, despite their descriptions promising a "full LOI draft" / "complete
// application". This helper actually generates the document via the injected
// OpenAI client (context.getOpenAI, the same path code.suggestPatch uses),
// grounded strictly in the real profile + opportunity facts. When the AI service
// is unavailable it says so honestly rather than implying a draft was written.
async function generateGrantWritingDocument(context, { systemDirective, opportunity, profileData, extra }) {
  const userPrompt = [
    `OPPORTUNITY:\n${JSON.stringify(opportunity, null, 2)}`,
    `APPLICANT PROFILE — use ONLY these real facts; do not invent details:\n${JSON.stringify(profileData, null, 2)}`,
    extra ? `ADDITIONAL INSTRUCTIONS:\n${extra}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')

  const getOpenAI = context?.getOpenAI
  const openai = typeof getOpenAI === 'function' ? getOpenAI() : null
  if (!openai) {
    return {
      content: null,
      generated: 'unavailable',
      note: 'The AI writing service is not configured, so a finished draft could not be generated here. The opportunity and profile facts are included so the draft can be written manually.',
    }
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.ANYA_OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.6,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: systemDirective },
        { role: 'user', content: userPrompt },
      ],
    })
    const content = response?.choices?.[0]?.message?.content?.trim() || ''
    return { content: content || null, generated: content ? 'ai' : 'empty', usage: response?.usage || null }
  } catch (err) {
    console.error('[grants.write] AI generation failed:', err.message)
    return { content: null, generated: 'error', error: err.message }
  }
}

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
    const opportunity = { id: opp.id, title: opp.title, sponsor: opp.sponsor, deadline: opp.deadline, description: opp.description, url: opp.url, application_url: opp.application_url, contact_info: opp.contact_info }

    const generation = await generateGrantWritingDocument(context, {
      systemDirective: LOI_WRITING_DIRECTIVE,
      opportunity,
      profileData,
      extra: params.customInstructions,
    })

    return {
      type: 'loi_draft',
      document: generation.content,
      generated: generation.generated,
      ...(generation.note ? { note: generation.note } : {}),
      ...(generation.error ? { error: generation.error } : {}),
      opportunity,
      profile: profileData,
      instructions: params.customInstructions || null,
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
    const opportunity = { id: opp.id, title: opp.title, sponsor: opp.sponsor, description: opp.description }

    const generation = await generateGrantWritingDocument(context, {
      systemDirective: NEEDS_STATEMENT_WRITING_DIRECTIVE,
      opportunity,
      profileData,
      extra: params.focusArea ? `Emphasize this area of need: ${params.focusArea}` : null,
    })

    return {
      type: 'needs_statement',
      document: generation.content,
      generated: generation.generated,
      ...(generation.note ? { note: generation.note } : {}),
      ...(generation.error ? { error: generation.error } : {}),
      opportunity,
      profile: profileData,
      focusArea: params.focusArea || null,
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
    const opportunity = { id: opp.id, title: opp.title, sponsor: opp.sponsor, deadline: opp.deadline, description: opp.description, url: opp.url, application_url: opp.application_url, contact_info: opp.contact_info }

    const generation = await generateGrantWritingDocument(context, {
      systemDirective: FULL_APPLICATION_WRITING_DIRECTIVE,
      opportunity,
      profileData,
      extra: Array.isArray(params.sections) && params.sections.length
        ? `Write only these sections: ${params.sections.join(', ')}.`
        : null,
    })

    return {
      type: 'full_application',
      document: generation.content,
      generated: generation.generated,
      ...(generation.note ? { note: generation.note } : {}),
      ...(generation.error ? { error: generation.error } : {}),
      opportunity,
      grant: grant ? { id: grant.id, status: grant.status, notes: grant.notes, application_method: grant.application_method } : null,
      profile: profileData,
      requestedSections: params.sections || null,
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

import { runAutoRepair, AUTO_REPAIR_TYPES } from './anyaAutoRepairService.js'

registerTool({
  name: 'admin.code.autoRepair',
  description:
    "Scan the codebase for known production-incident anti-patterns and optionally repair them. " +
    "Patterns covered: " +
    "empty_catch (silent .catch(() => {})), " +
    "console_log (route handlers), " +
    "profile_bleed (SQL on funding_opportunities missing profile_id; report-only), " +
    "missing_db_await (db.prepare(...).all/get/run not awaited; cause of multiple recent /api/profiles/:id/sections/:key/ai 500s), " +
    "column_typo (known-typo column names like requires_matching_funds; cause of GET /api/saved-grants 500), " +
    "unstructured_500 (route catch using console.error before res.status(500); auto-fixed when routeLogger is available), " +
    "react_object_render (JSX rendering match_reasons / trust_reasons / matched_needs items without coercion; cause of React error #31 route crashes; report-only), " +
    "dockerfile_drift (backend imports living outside the Dockerfile COPY whitelist; cause of Railway boot crashes; report-only), " +
    "profile_admin_sentinel (frontend file fetches /api/profiles/${id} without going through assertRealProfileId from @/api/profileIdGuards; cause of GET /api/profiles/__admin__ 404 after admin login; report-only).",
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
          enum: [...AUTO_REPAIR_TYPES],
        },
        description: `Subset of repair types to run. Defaults to all of: ${AUTO_REPAIR_TYPES.join(', ')}.`,
      },
    },
  },
  handler: async (params, context) => {
    const { db } = context
    if (!db) throw new Error('Database connection unavailable')
    const dryRun = params?.dryRun !== false
    const repairTypes = params?.repairTypes
    const report = await runAutoRepair(db, { dryRun, repairTypes })
    const totalFindings = Object.entries(report.findings)
      .filter(([k]) => k !== 'repairs')
      .reduce((sum, [, list]) => sum + (Array.isArray(list) ? list.length : 0), 0)
    const totalRepaired = Object.values(report.repaired || {}).reduce(
      (sum, n) => sum + (Number(n) || 0),
      0,
    )
    const reportOnlyTypes = [
      'profile_bleed',
      'react_object_render',
      'dockerfile_drift',
      'profile_admin_sentinel',
    ]
    const recommendation = dryRun
      ? totalFindings > 0
        ? `Found ${totalFindings} issue(s) across ${report.scannedFiles} files. Run with dryRun=false to apply repairs. The following issue types are always report-only and require human review: ${reportOnlyTypes.join(', ')}.`
        : `No issues found across ${report.scannedFiles} files.`
      : `Applied ${totalRepaired} repair(s) across ${report.scannedFiles} files. Report-only types still require human review: ${reportOnlyTypes.join(', ')}.`
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
  formatAuditSummary as cgFormatAuditSummary,
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
    const baseUrl = context?.internalBaseUrl || (process.env.PORT ? `http://localhost:${process.env.PORT}` : null)
    const token = process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null
    const [endpointResult, matchResult, missionResult] = await Promise.allSettled([
      baseUrl ? cgTestEndpoints(db, baseUrl, token) : Promise.resolve(null),
      cgAuditMatchQuality(db),
      cgVerifyMissionGoals(db),
    ])
    const inlineSummary = cgFormatAuditSummary({
      endpoints: endpointResult.status === 'fulfilled' ? endpointResult.value : null,
      matchQuality: matchResult.status === 'fulfilled' ? matchResult.value : null,
      mission: missionResult.status === 'fulfilled' ? missionResult.value : null,
    })
    const hasInlineData = !inlineSummary.includes('No audit data yet')
    return { summary: hasInlineData ? inlineSummary : cgGetAuditSummary(db) }
  },
})

// ──────────────────────────────────────────────────────────────────────
// Goal 11 — Field-to-Funding accountability tools
//
// Anya users frequently ask "why are you asking for this?" or "what does
// this field do for me?". Surfacing the canonical usage contract from
// profileFieldUsageRegistry as Anya tools means Anya never has to
// improvise an answer — she returns the same machine-readable contract
// the UI tooltip and the mission-health dashboard see.
// ──────────────────────────────────────────────────────────────────────

registerTool({
  name: 'fieldUsage.explain',
  description:
    'Explain why GrantFlow asks for a specific profile field. Returns the canonical why_we_ask copy, usage modes, source categories, PII status, and match-reason from the Goal 11 profileFieldUsageRegistry. Use whenever the user asks "why do you need X?" or wants to understand a profile field.',
  schema: {
    type: 'object',
    properties: {
      field_id: {
        type: 'string',
        description:
          'Canonical field id (e.g. "organization.uei", "pii.ssn", "narrative.story"). Must exist in profileFieldUsageRegistry.',
      },
    },
    required: ['field_id'],
  },
  handler: async ({ field_id }) => {
    const id = String(field_id || '').trim()
    if (!id) {
      const error = new Error('field_id is required')
      error.status = 400
      throw error
    }
    const entry = getFieldUsage(id)
    if (!entry) {
      const error = new Error(
        `Unknown field id "${id}". Field must be registered in profileFieldUsageRegistry (Goal 11).`,
      )
      error.status = 404
      throw error
    }
    return {
      field_id: id,
      label: entry.label,
      section: entry.section,
      pii: entry.pii,
      raw_external_use_allowed: entry.raw_external_use_allowed,
      usage_modes: entry.usage_modes,
      source_categories: entry.source_categories,
      query_use: entry.query_use,
      match_reason: entry.match_reason,
      why_we_ask: entry.why_we_ask,
      applies_to_profile_types: entry.applies_to_profile_types,
    }
  },
})

registerTool({
  name: 'fieldUsage.listForSection',
  description:
    'List all profile fields registered in the Goal 11 profileFieldUsageRegistry for a given section (e.g. "organization_details", "pii", "financial_information"). Useful when a user is on a specific profile page and asks "what does this whole section do?".',
  schema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description: 'Section slug from the registry.',
      },
    },
    required: ['section'],
  },
  handler: async ({ section }) => {
    const slug = String(section || '').trim()
    if (!slug) {
      const error = new Error('section is required')
      error.status = 400
      throw error
    }
    const entries = forSection(slug)
    return {
      section: slug,
      count: entries.length,
      entries: entries.map((entry) => ({
        field_id: entry.id,
        label: entry.label,
        pii: entry.pii,
        usage_modes: entry.usage_modes,
        why_we_ask: entry.why_we_ask,
      })),
    }
  },
})

registerTool({
  name: 'fieldUsage.coverageReport',
  description:
    'Return the Goal 11 field-usage coverage report — total fields, mapped fields, PII fields, PII-external-query violations, unmapped sections. Use when a user (or admin) asks "how complete is the field-usage registry?" or "are we leaking any PII?".',
  schema: { type: 'object', properties: {} },
  handler: async () => {
    const report = buildFieldUsageReport()
    const total = listFieldUsages().length
    return {
      // total_fields is preserved as an alias for older callers; the
      // canonical name from the registry is total_profile_fields.
      total_fields: total,
      ...report,
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// OWNER-ONLY super-tools — let Anya act with the owner's full reach: run any
// agent, edit/save profile data, and crawl. HARD-gated to the owner account
// (buckeye7066@gmail.com) via requiresOwner; no other admin/tier/seat can invoke
// them, enforced server-side in invokeTool().
// ─────────────────────────────────────────────────────────────────────────────

// Run any of the other agents on demand.
registerTool({
  name: 'owner.run_agent',
  description: 'OWNER ONLY. Run another agent: Yana (find leads/clients), John (draft outreach), Hamilton (work the application pipeline), Robert (funding discovery), Sam (diagnostics), or Amy (synthetic crawler-training: create→crawl→learn→delete). Use when the owner asks Anya to "have <agent> do X".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: ['yana', 'john', 'hamilton', 'robert', 'sam', 'amy'], description: 'Which agent to run' },
      profileId: { type: 'string', description: 'Profile to act on (Hamilton/Robert)' },
      mode: { type: 'string', description: 'Run mode where applicable (e.g. observe|execute)' },
    },
    required: ['agent'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const agent = String(params?.agent || '').toLowerCase()
    const userId = context?.ctx?.userId ?? context?.user?.id ?? null
    try {
      if (agent === 'yana') {
        const { runYanaDiscovery, getYanaConfig } = await import('./yana/yanaLeadDiscovery.js')
        const yanaCfg = getYanaConfig()
        // runYanaDiscovery takes allowLeads/allowLiveWeb, NOT a `mode` string —
        // passing `mode` did nothing (prospect discovery silently NOOP'd because
        // allowLiveWeb defaulted false). mode 'observe' => qualify but don't push
        // to John; anything else => push qualified leads when allowed.
        const observeOnly = String(params?.mode || '').toLowerCase() === 'observe'
        return {
          agent,
          result: await runYanaDiscovery(db, {
            trigger: 'anya_owner',
            createdByUserId: userId,
            allowLeads: !observeOnly,
            allowLiveWeb: yanaCfg.allowLiveWeb,
            prospectLimit: yanaCfg.prospectLimit,
          }),
        }
      }
      if (agent === 'john') {
        const { runJohn } = await import('./john/johnAgent.js')
        return { agent, result: await runJohn({ db, mode: params?.mode || 'observe', trigger: 'anya_owner', draftOnly: true, createdByUserId: userId }) }
      }
      if (agent === 'hamilton') {
        if (!params?.profileId) throw new Error('profileId is required for Hamilton')
        const { automateSelected } = await import('./hamilton/hamiltonAutomationOrchestrator.js')
        return { agent, result: await automateSelected(db, { profileId: String(params.profileId), userId, selectedSources: [], options: { source: 'anya_owner' } }) }
      }
      if (agent === 'robert') {
        const { runRobert } = await import('./robert/robertAgent.js').catch(() => ({}))
        if (typeof runRobert !== 'function') return { agent, result: { skipped: 'robert_runner_unavailable' } }
        return { agent, result: await runRobert({ db, profileId: params?.profileId || null, trigger: 'anya_owner', createdByUserId: userId }) }
      }
      if (agent === 'sam') {
        // Sam is the diagnostics/health agent — the one Control-Center agent Anya
        // previously could not drive ("Unknown agent sam"), a gap in the
        // every-agent-usable-by-Anya rule. Default to observe (read-only audit).
        const { runSam } = await import('./sam/samAgent.js')
        return { agent, result: await runSam({ db, mode: params?.mode || 'observe', trigger: 'anya_owner', createdByUserId: userId }) }
      }
      if (agent === 'amy') {
        // Amy runs in the BACKGROUND (crawls up to 100 synthetic profiles live +
        // the Anya→Sam improvement pipeline — minutes of work), so we launch and
        // return the run id immediately; the panel/owner polls status via
        // getAmyRunState. This closes the create→crawl→learn→delete loop on demand.
        const { launchAmyRun } = await import('./amy/amyRunner.js')
        const launched = launchAmyRun({ db, source: 'anya_owner', logger: console })
        return { agent, result: { started: !launched.already_running, already_running: launched.already_running, run_id: launched.run_id } }
      }
      throw new Error(`Unknown agent "${agent}"`)
    } catch (err) {
      return { agent, ok: false, error: err?.message || String(err) }
    }
  },
})

// Edit / save any profile section (the "edit, save" power).
registerTool({
  name: 'owner.edit_profile_section',
  description: 'OWNER ONLY. Create or update a section of any profile (e.g. basic_information, education, university_applications). Use when the owner asks Anya to edit/save profile data directly.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
      sectionKey: { type: 'string', description: 'Section key, e.g. basic_information' },
      data: { type: 'object', description: 'The section JSON to save (replaces the section)' },
    },
    required: ['profileId', 'sectionKey', 'data'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { profileId, sectionKey, data } = params || {}
    if (!profileId || !sectionKey || typeof data !== 'object') throw new Error('profileId, sectionKey, and object data are required')
    const userId = context?.ctx?.userId ?? 'anya_owner'

    // Route Anya's direct edits through the SAME validation choke point the HTTP
    // PUT path uses, so the agent can't write negative income / fractional
    // household size / unknown fields that the form would reject.
    let toSave = data
    let rejected = []
    try {
      const { guardProfileSectionPayload } = await import('../../shared/profileSuggestionGuards.js')
      const profileRow = await db.prepare('SELECT * FROM profiles WHERE id = ?').get(String(profileId))
      const guarded = guardProfileSectionPayload(data, { profile: profileRow || {}, sectionKey, sections: { [sectionKey]: data } })
      toSave = guarded?.data ?? data
      rejected = guarded?.rejected ?? []
    } catch (guardErr) {
      console.warn('[anya owner.edit_profile_section] guard failed, saving raw:', guardErr?.message)
    }

    const json = JSON.stringify(toSave)
    const existing = await db.prepare(`SELECT 1 AS x FROM profile_sections WHERE profile_id = ? AND section_key = ?`).get(String(profileId), String(sectionKey))
    if (existing) {
      await db.prepare(`UPDATE profile_sections SET data = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE profile_id = ? AND section_key = ?`).run(json, userId, String(profileId), String(sectionKey))
    } else {
      await db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by) VALUES (?, ?, ?, ?)`).run(String(profileId), String(sectionKey), json, userId)
    }
    return { ok: true, profile_id: profileId, section_key: sectionKey, saved: true, rejected_fields: rejected.map((r) => r.key) }
  },
})

// Queue a funding crawler ("code crawl" / funding crawl) for a profile.
registerTool({
  name: 'owner.run_crawler',
  description: 'OWNER ONLY. Queue and dispatch a funding crawler job for a profile (e.g. comprehensive, scholarship, local, item_search). Use when the owner asks Anya to "crawl for funding".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
      type: { type: 'string', description: 'Crawler/job type (e.g. comprehensive, scholarship, item_search)' },
    },
    required: ['profileId', 'type'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { createCrawlerJob } = await import('./crawlerJobCreation.js')
    const { dispatchCrawlerJob } = await import('./crawlerDispatcher.js')
    const creation = await createCrawlerJob(db, {
      type: String(params.type),
      parameters: { profile_id: String(params.profileId) },
      requestedBy: context?.ctx?.userId ?? 'anya_owner',
      buildSnapshot: false,
    })
    setImmediate(() => { dispatchCrawlerJob({ db, jobId: creation.jobId }).catch(() => {}) })
    return { ok: true, job_id: creation.jobId, type: params.type, profile_id: params.profileId }
  },
})

registerTool({
  name: 'owner.email_grants_status',
  description: 'OWNER ONLY. Show the status of grants ingested from the owner\'s email inbox bridge — how many were imported into the catalog, skipped, or rejected, and the most recent emails. Use when the owner asks "what grants came in from my email?" or to check the inbox-to-grant pipeline.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'How many recent ingestions to return (default 20, max 100)' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { getEmailGrantHealth } = await import('./emailGrants/emailGrantIngestor.js')
    const health = await getEmailGrantHealth(db, { limit: Number(params?.limit) || 20 })
    return { ok: true, ...health }
  },
})

registerTool({
  name: 'owner.sync_email_grants_from_inbox',
  description: 'OWNER ONLY. Pull recent grant-announcement emails from the connected Microsoft 365 inbox (dr.johnwhite@axiombiolabs.org, via the John Outlook Graph bridge) and parse them into funding opportunities. Use when the owner says "check my email for new grants" or "import grants from my inbox".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      top: { type: 'number', description: 'How many recent inbox messages to scan (default 25, max 100)' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runOutlookGrantFeed } = await import('./emailGrants/outlookGrantFeeder.js')
    const top = Math.max(1, Math.min(100, Number(params?.top) || 25))
    return runOutlookGrantFeed(db, { top })
  },
})

// ── Owner comms / billing / agent super-tools (new subsystems) ─────────────
// Let Anya operate the owner-messaging, free-period, account-status, and the
// Hamilton-digest / Robert-contact-scan subsystems on the owner's behalf.

registerTool({
  name: 'owner.send_broadcast',
  description: 'OWNER ONLY. Send a promotional / notification message to profiles — email (from the dr.johnwhite alias) and/or SMS (opted-in numbers only). Use when the owner says "email/text my users about X". Set all:true to reach every profile, or pass profileIds.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileIds: { type: 'array', items: { type: 'string' }, description: 'Profile IDs to message (omit when all=true)' },
      all: { type: 'boolean', description: 'Send to every profile' },
      channel: { type: 'string', enum: ['auto', 'email', 'sms'], description: 'auto = email, else SMS' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['body'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { sendBroadcast, listProfileContacts } = await import('./comms/commsService.js')
    let ids = Array.isArray(params.profileIds) ? params.profileIds.map(String) : []
    if (params.all) ids = (await listProfileContacts(db)).map((r) => r.profile_id)
    if (ids.length === 0) return { ok: false, error: 'no_recipients' }
    return sendBroadcast(db, {
      profileIds: ids,
      channel: params.channel || 'auto',
      subject: params.subject || null,
      body: String(params.body),
      sentBy: context?.ctx?.email || 'anya_owner',
      kind: 'broadcast',
    })
  },
})

// SMS consent campaign — text profiles asking "is it ok to text you?" (opt-in).
// DRY-RUN by default: previews who WOULD be texted and sends nothing unless the
// owner passes confirm:true. Never texts a blocklisted number; never re-asks a
// number already pending/opted_in/opted_out.
registerTool({
  name: 'owner.sms_consent_campaign',
  description: 'OWNER ONLY. Run the SMS consent (opt-in) campaign: text profiles that have a phone with no recorded consent, asking permission to send grant-deadline & account texts (Reply YES / STOP). DRY-RUN by default — it PREVIEWS who would be texted and sends NOTHING unless you pass confirm:true. Pass action:"status" to just see the consent counts (none / pending / opted_in / opted_out). Never texts a blocklisted number or re-asks a number that already replied. Use when the owner says "ask my users if it\'s ok to text them" or "how many opted in to texts?".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['campaign', 'status'], description: 'campaign = run the opt-in send; status = just show counts', default: 'campaign' },
      confirm: { type: 'boolean', description: 'Must be EXACTLY true to actually send. Omit/false = dry-run preview only.' },
      limit: { type: 'number', description: 'Max numbers to process (default 500)' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runConsentCampaign, getConsentStatusCounts } = await import('./comms/smsConsentService.js')
    if (String(params?.action || 'campaign') === 'status') {
      return { ok: true, action: 'status', counts: await getConsentStatusCounts(db) }
    }
    const confirm = params?.confirm === true
    const summary = await runConsentCampaign(db, {
      confirm,
      limit: Number(params?.limit) || 500,
      requestedBy: context?.ctx?.email || 'anya_owner',
    })
    return { ok: true, action: 'campaign', ...summary }
  },
})

registerTool({
  name: 'owner.create_announcement',
  description: 'OWNER ONLY. Create a one-time, dismissible message shown to users when they next log in (an in-app announcement, not email/SMS). Use when the owner says "show users X on next login" / "tell everyone about X when they sign in". audience:"all" reaches every user; pass a profileId to target just that profile\'s users. Provide title + body (markdown ok).',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      audience: { type: 'string', description: '"all" for everyone, or a profileId to target one profile\'s users', default: 'all' },
      title: { type: 'string' },
      body: { type: 'string', description: 'The message (markdown). Explain plainly.' },
      type: { type: 'string', enum: ['info', 'feature', 'warning'], default: 'feature' },
      expires_in_days: { type: 'number', description: 'Optional auto-expiry (omit = no expiry)' },
    },
    required: ['title', 'body'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const audience = String(params.audience || 'all').trim() || 'all'
    const title = String(params.title || '').trim()
    const body = String(params.body || '').trim()
    if (!title || !body) return { ok: false, error: 'title_and_body_required' }
    const type = ['info', 'feature', 'warning'].includes(params.type) ? params.type : 'feature'
    const id = (await import('node:crypto')).randomUUID()
    const expiresClause = Number.isFinite(params.expires_in_days) && params.expires_in_days > 0
      ? (db.dialect === 'postgres'
        ? `now() + (${Number(params.expires_in_days)} || ' days')::interval`
        : `datetime('now', '+${Number(params.expires_in_days)} days')`)
      : 'NULL'
    await db.prepare(
      `INSERT INTO announcements (id, created_by, title, body, audience, type, active, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ${expiresClause})`,
    ).run(id, context?.ctx?.email || 'anya_owner', title, body, audience, type)
    return {
      ok: true,
      id,
      audience,
      message: audience === 'all'
        ? 'Announcement created — every user will see it once on their next login.'
        : `Announcement created — users of profile ${audience} will see it once on their next login.`,
    }
  },
})

registerTool({
  name: 'owner.grant_free_period',
  description: 'OWNER ONLY. Grant a free week or month (timer starts now; invoices are suppressed and the account is notified). scope:"global" applies to everyone; scope:"profile" needs profileId. Use when the owner says "give X a free week/month" or "give everyone a free month".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['week', 'month'] },
      scope: { type: 'string', enum: ['profile', 'global'] },
      profileId: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['kind'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { grantFreePeriod, grantFreePeriodGlobal } = await import('./billing/invoiceService.js')
    const by = context?.ctx?.email || 'anya_owner'
    if ((params.scope || 'profile') === 'global') return grantFreePeriodGlobal(db, { kind: params.kind, reason: params.reason || null, grantedBy: by })
    if (!params.profileId) return { ok: false, error: 'profileId required for scope "profile"' }
    return grantFreePeriod(db, { profileId: String(params.profileId), kind: params.kind, reason: params.reason || null, grantedBy: by })
  },
})

registerTool({
  name: 'owner.set_account_status',
  description: 'OWNER ONLY. Suspend, reactivate, ban, or unban an account. Suspend pauses access; ban blocks the user\'s login via the owner blocklist. Use when the owner says "suspend/ban X" or "reactivate/unban X".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string' },
      action: { type: 'string', enum: ['suspend', 'reactivate', 'ban', 'unban'] },
      reason: { type: 'string' },
    },
    required: ['profileId', 'action'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const mod = await import('./billing/accountStatus.js')
    const by = context?.ctx?.email || 'anya_owner'
    const profileId = String(params.profileId)
    switch (params.action) {
      case 'suspend': return mod.suspendProfile(db, { profileId, reason: params.reason || 'owner_suspend', suspendedBy: by })
      case 'reactivate': return mod.reactivateProfile(db, { profileId, reactivatedBy: by })
      case 'ban': return mod.banProfileUser(db, { profileId, reason: params.reason || 'owner_ban', bannedBy: by })
      case 'unban': return mod.unbanProfileUser(db, { profileId, unbannedBy: by })
      default: return { ok: false, error: 'unknown_action' }
    }
  },
})

registerTool({
  name: 'owner.run_hamilton_digest',
  description: 'OWNER ONLY. Run Hamilton\'s weekly per-profile funding digest now — drafts a status update per profile into the owner mailbox. Use when the owner says "draft the weekly updates now".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: { profileIds: { type: 'array', items: { type: 'string' } } },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runHamiltonWeeklyDigest } = await import('./hamilton/hamiltonWeeklyDigest.js')
    const profileIds = Array.isArray(params?.profileIds) ? params.profileIds.map(String) : null
    return runHamiltonWeeklyDigest(db, { force: true, profileIds })
  },
})

registerTool({
  name: 'owner.run_portal_reminder',
  description: 'OWNER ONLY. Send the weekly UNMERGED-portal reminder now — for each profile with portals that are not merged (including completed-but-not-merged), emails a reminder to its contacts. Normally runs every Monday morning. Use when the owner says "remind everyone about their unmerged portals".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileIds: { type: 'array', items: { type: 'string' } },
      channel: { type: 'string', enum: ['auto', 'email', 'sms'] },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runMondayPortalReminder } = await import('./hamilton/mondayPortalReminder.js')
    const profileIds = Array.isArray(params?.profileIds) ? params.profileIds.map(String) : null
    const channel = params?.channel || 'auto'
    return runMondayPortalReminder(db, { force: true, profileIds, channel })
  },
})

// ── Portal Autopilot Identity (owner-gated) ───────────────────────────────────
// Setting a master passphrase or running auto-provisioning makes Hamilton create
// real portal accounts under the profile's identity — the same class of power as
// owner.run_portal_sync — so both are requiresOwner:true (owner account only),
// enforced in invokeTool BEFORE the handler. The passphrase is consumed
// immediately and NEVER stored, logged, or returned.
registerTool({
  name: 'owner.set_portal_master_passphrase',
  description: 'OWNER ONLY. Set (or rotate) a profile\'s portal master passphrase — the one passphrase that protects Hamilton\'s auto-provisioned portal logins (password-manager model). Optionally set the autopilot identity email Hamilton registers new accounts with. The passphrase is used immediately and never stored or echoed back. Use when the owner says "set the portal passphrase for <profile>".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile to protect.' },
      passphrase: { type: 'string', description: 'The master passphrase (>= 8 chars). Never stored.' },
      identityEmail: { type: 'string', description: 'Optional: the email/alias Hamilton registers new portal accounts with.' },
    },
    required: ['profileId', 'passphrase'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')
    const passphrase = String(params?.passphrase || '')
    if (passphrase.length < 8) throw new Error('passphrase must be at least 8 characters')
    const { status } = await setPortalMasterPassphrase(db, {
      profileId, passphrase,
      identityEmail: params?.identityEmail === undefined ? undefined : params.identityEmail,
    })
    // Return ONLY the public status — never the passphrase / salt / verifier.
    return { ok: true, vault: status }
  },
})

registerTool({
  name: 'owner.set_portal_autopilot_identity',
  description: 'OWNER ONLY. Set the autopilot identity email/alias a profile\'s Hamilton registers NEW portal accounts with (independent of the passphrase). Use when the owner says "register portals under <email> for <profile>".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile to update.' },
      identityEmail: { type: 'string', description: 'The email/alias for new portal registrations (or empty to clear).' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')
    const status = await setPortalAutopilotIdentity(db, { profileId, identityEmail: params?.identityEmail ?? null })
    return { ok: true, vault: status }
  },
})

registerTool({
  name: 'owner.run_portal_autopilot',
  description: 'OWNER ONLY. Run Hamilton\'s Portal Autopilot Identity for a profile: for each applicable portal, log in with existing credentials, auto-provision a unique master-wrapped login (vault must be unlocked), or hand off to you when identity proofing / a blocker requires it. Pass portalHost to run a single portal. Use when the owner says "set up logins for <profile>\'s portals".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile to run.' },
      portalHost: { type: 'string', description: 'Optional: run a single portal host, e.g. mtsu.edu.' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')
    const userId = context?.ctx?.userId ?? context?.user?.id ?? 'anya_owner'
    const portalHost = params?.portalHost ? String(params.portalHost).trim() : ''
    if (portalHost) {
      const result = await runAutopilotIdentityForPortal(db, { profileId, userId, portalHost })
      // Strip any one-time password from the conversational result.
      const { password_one_time_view, ...safe } = result
      void password_one_time_view
      return { ok: true, result: safe }
    }
    return { ok: true, ...(await runAutopilotIdentityForProfile(db, { profileId, userId })) }
  },
})

registerTool({
  name: 'owner.run_robert_contact_scan',
  description: 'OWNER ONLY. Run Robert\'s email-contact lead scan now — reads the owner\'s Outlook contacts and tags client prospects for John. Use when the owner says "scan my contacts for leads".',
  requiresOwner: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runContactScanForRobert } = await import('./robert/robertContactDiscovery.js')
    return runContactScanForRobert(db, { force: true })
  },
})

registerTool({
  name: 'owner.set_maintenance',
  description: 'OWNER ONLY. Put GrantFlow into (or out of) a maintenance window before/after code changes. action:"schedule" warns signed-in users then takes the app down after a grace period; action:"end" reopens it. Use when the owner says "take the site down for maintenance" / "bring the site back".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['schedule', 'end'] },
      graceMinutes: { type: 'number', description: 'Warning grace before going down (default 5)' },
      estimatedMinutes: { type: 'number', description: 'Expected downtime after grace (default 15)' },
      message: { type: 'string' },
    },
    required: ['action'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const mod = await import('./maintenance/maintenanceMode.js')
    const by = context?.ctx?.email || 'anya_owner'
    if (params.action === 'end') return mod.endMaintenance(db, { by })
    return mod.scheduleMaintenance(db, {
      graceMinutes: params.graceMinutes, estimatedMinutes: params.estimatedMinutes,
      reason: 'deploy', message: params.message || null, by,
    })
  },
})

registerTool({
  name: 'owner.run_nightly_sweep',
  description: 'OWNER ONLY. Run Sam\'s nightly maintenance sweep now: enter a maintenance window, run Sam in repair-safe mode, and reopen only if green. Use when the owner says "run the nightly maintenance" / "have Sam fix things now".',
  requiresOwner: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runNightlyMaintenanceSweep } = await import('./maintenance/nightlySweep.js')
    return runNightlyMaintenanceSweep(db, { force: true })
  },
})

// ── Full self-heal (on demand) ────────────────────────────────────────────
//
// Runs the COMPLETE startup self-heal (baseline-seed gating, uploads/document
// repair, orphaned crawler-job recovery, ALL product-invariant enforcement,
// dedup) — not just the lightweight boot enforceInvariants net. Same power class
// as owner.run_nightly_sweep (it repairs data live), so it is owner-gated. The
// on-demand path downgrades a destructive `force` re-seed to 'auto' (boot-only
// lever), and the structured result is persisted to system_kv for observability.
registerTool({
  name: 'owner.run_self_heal',
  description: 'OWNER ONLY. Run GrantFlow\'s full self-heal now: re-assert every machine-checkable product invariant against the live DB, repair uploads/documents, recover orphaned crawler jobs, and dedupe — then return a truthful per-step summary of exactly what ran and repaired. Use when the owner says "run the self-heal" / "fix the data now". A destructive force re-seed is never triggered on demand.',
  requiresOwner: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { runSelfHealOnDemand } = await import('../startup/selfHeal.js')
    // Returns the structured summary { ok, totalRepaired, steps[], failures[] }.
    // Honesty rule: we return exactly what the heal reported — no synthesized
    // "all good"; surfaced failures stay in failures[].
    return runSelfHealOnDemand(db)
  },
})

registerTool({
  name: 'owner.get_self_heal_status',
  description: 'OWNER ONLY. Show the LAST self-heal run (boot net runs enforceInvariants only; the full heal runs via the nightly sweep or owner.run_self_heal): when it ran, per-step repaired counts, and any failures — read straight from system_kv (no faked "healthy" state). Use when the owner asks "did the self-heal run?" / "what did self-heal fix?".',
  requiresOwner: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { getLastSelfHealRun } = await import('../startup/selfHealStatus.js')
    const last = await getLastSelfHealRun(db)
    if (!last) return { has_run: false, message: 'No full self-heal has run yet (boot runs enforceInvariants only).' }
    return { has_run: true, last_run: last }
  },
})

// ── Hamilton two-way portal sync ──────────────────────────────────────────
//
// Gating rationale: runPortalSync reads from / writes to a user's *authenticated*
// portal session (Hamilton acts inside the real account using a saved login). That
// is the same class of power as owner.run_agent / owner.run_crawler — it makes an
// agent act on a portal on someone's behalf — so it is gated requiresOwner:true
// (owner account buckeye7066@gmail.com only), enforced in invokeTool BEFORE the
// handler runs. The status reader is read-only but is kept owner-scoped too, for
// consistency with the other owner.* read-status tools (e.g. owner.email_grants_status).
registerTool({
  name: 'owner.run_portal_sync',
  description: 'OWNER ONLY. Run Hamilton\'s two-way portal sync for a profile against one portal host: pull the latest data FROM the portal (read), push this profile\'s data TO the portal (write), or both. Uses the profile\'s saved/authenticated portal session, so it is owner-gated. Use when the owner says e.g. "sync MTSU for this profile" or "pull/push my portal data".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile to sync.' },
      portalHost: { type: 'string', description: 'Portal host to sync, e.g. mtsu.edu.' },
      direction: {
        type: 'string',
        enum: ['read', 'write', 'both'],
        description: "Sync direction: 'read' pulls from the portal, 'write' pushes to it, 'both' does both. Default 'read'.",
      },
    },
    required: ['profileId', 'portalHost'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const profileId = String(params?.profileId || '').trim()
    const portalHost = String(params?.portalHost || '').trim()
    if (!profileId) throw new Error('profileId is required')
    if (!portalHost) throw new Error('portalHost is required')
    const direction = ['read', 'write', 'both'].includes(params?.direction) ? params.direction : 'read'
    const actorUserId = context?.ctx?.userId ?? context?.user?.id ?? 'anya_owner'
    // The portal-sync framework is built by a parallel agent; import lazily so
    // this tool registers cleanly even before that module is merged.
    let runPortalSync
    try {
      ;({ runPortalSync } = await import('./hamilton/portalSync/index.js'))
    } catch {
      return { ok: false, error: 'portal_sync_unavailable', detail: 'Portal sync framework is not installed yet.' }
    }
    if (typeof runPortalSync !== 'function') {
      return { ok: false, error: 'portal_sync_unavailable', detail: 'runPortalSync export missing.' }
    }
    return runPortalSync(db, { profileId, portalHost, direction, actorUserId })
  },
})

registerTool({
  name: 'owner.get_portal_sync_status',
  description: 'OWNER ONLY. Show the latest two-way portal sync runs for a profile (optionally a single portal host): status, direction, connector, timestamp, and any error — read straight from portal_sync_runs (no faked "synced!" states). Use when the owner asks "did the portal sync work?" or "what\'s the portal sync status?".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile to report on.' },
      portalHost: { type: 'string', description: 'Optional: restrict to a single portal host, e.g. mtsu.edu.' },
      limit: { type: 'number', description: 'How many recent runs to return (default 25, max 100).' },
    },
    required: ['profileId'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const profileId = String(params?.profileId || '').trim()
    if (!profileId) throw new Error('profileId is required')
    const portalHost = params?.portalHost ? String(params.portalHost).trim() : null
    const limit = Math.max(1, Math.min(100, Number(params?.limit) || 25))
    const { getPortalSyncRuns } = await import('./hamilton/portalSync/portalSyncHealth.js')
    const runs = await getPortalSyncRuns(db, { profileId, portalHost, limit })
    return { ok: true, profile_id: profileId, portal_host: portalHost, count: runs.length, runs }
  },
})

// ── Profile dedupe / combine (owner only) ─────────────────────────────────────
//
// These three tools expose the profileDedupeService merge engine to Anya so the
// owner can say "combine the duplicate profiles" in chat and have it actually
// happen — instead of being told to go find an Admin Tools panel. Gating: merging
// rewrites/soft-deletes profile rows and repoints every foreign key, so it is the
// same destructive class as owner.run_crawler / owner.edit_profile_section and is
// gated requiresOwner:true (ADMIN_EMAIL only), enforced in invokeTool BEFORE the
// handler runs. End-user Anya never sees these — she stays a helpful guide.
//
// Safety contract mirrors the service: merges default to a DRY-RUN preview. Anya
// shows the owner exactly which profiles would fold into which winner, then re-runs
// with apply:true to actually commit. This satisfies the system prompt's honesty
// rule (never claim a side-effect happened unless the tool actually did it).

function ownerActorUserId(context) {
  return context?.ctx?.userId ?? context?.user?.id ?? 'anya_owner'
}

registerTool({
  name: 'owner.find_duplicate_profiles',
  description: 'OWNER ONLY. Find groups of likely-duplicate profiles so they can be combined. Read-only — nothing is changed. Returns each group with its suggested winner (the most complete / user-owned profile) and the losers that would fold into it, with their ids. Use when the owner says "find duplicate profiles" / "which profiles look like duplicates?" before merging.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      strategy: {
        type: 'string',
        enum: ['exact_name', 'similar_name', 'email_or_phone'],
        description: "How to group duplicates: 'exact_name' (default), 'similar_name' (fuzzy), or 'email_or_phone' (shared contact signal).",
      },
      limitGroups: { type: 'number', description: 'Max duplicate groups to return (default 50).' },
      includeInactive: { type: 'boolean', description: 'Include already-deleted profiles (default false).' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const strategy = ['exact_name', 'similar_name', 'email_or_phone'].includes(params?.strategy)
      ? params.strategy
      : 'exact_name'
    const limitGroups = Math.max(1, Math.min(200, Number(params?.limitGroups) || 50))
    const includeInactive = params?.includeInactive === true
    const { findDuplicateProfileGroups } = await import('./profileDedupeService.js')
    const report = await findDuplicateProfileGroups(db, { strategy, limitGroups, includeInactive })
    return {
      ok: true,
      strategy,
      scanned: report?.scanned ?? 0,
      capped: report?.capped ?? false,
      group_count: report?.groups?.length ?? 0,
      groups: report?.groups ?? [],
    }
  },
})

registerTool({
  name: 'owner.merge_profiles',
  description: 'OWNER ONLY. Combine one or more duplicate profiles into a single winner. Non-destructive: only fills empty fields on the winner (never overwrites existing data) and repoints all documents, applications, crawler jobs, sessions, billing, and opportunities to the winner; losers are soft-deleted. Defaults to a DRY-RUN preview (apply:false) — call again with apply:true to actually commit. Use when the owner says "merge these profiles" / "combine profile X into Y".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      winnerId: { type: 'string', description: 'The profile id to KEEP (everything folds into this one).' },
      loserIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more profile ids to fold into the winner and then soft-delete.',
      },
      apply: { type: 'boolean', description: 'false (default) = preview only; true = actually perform the merge.' },
    },
    required: ['winnerId', 'loserIds'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const winnerId = String(params?.winnerId || '').trim()
    const loserIds = Array.isArray(params?.loserIds)
      ? params.loserIds.map((id) => String(id || '').trim()).filter(Boolean)
      : []
    if (!winnerId) throw new Error('winnerId is required')
    if (loserIds.length === 0) throw new Error('loserIds must contain at least one profile id')
    const apply = params?.apply === true
    const { mergeProfiles } = await import('./profileDedupeService.js')
    const result = await mergeProfiles(db, {
      winnerId,
      loserIds,
      dryRun: !apply,
      actorUserId: ownerActorUserId(context),
    })
    return {
      ok: true,
      applied: apply,
      preview: !apply,
      ...result,
    }
  },
})

registerTool({
  name: 'owner.deduplicate_profiles',
  description: 'OWNER ONLY. Auto-combine ALL duplicate profile groups in one pass — picks a deterministic winner per group (most complete / user-owned) and folds the rest in. Defaults to a DRY-RUN preview (apply:false) so the owner can review what would merge; call again with apply:true to commit every group. Use when the owner says "combine similar profiles" / "deduplicate all profiles" / "clean up duplicate profiles".',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      strategies: {
        type: 'array',
        items: { type: 'string', enum: ['exact_name', 'similar_name', 'email_or_phone'] },
        description: 'Which matching strategies to run. Default: all three.',
      },
      includeInactive: { type: 'boolean', description: 'Include already-deleted profiles (default false).' },
      apply: { type: 'boolean', description: 'false (default) = preview only; true = actually merge every group.' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const apply = params?.apply === true
    const includeInactive = params?.includeInactive === true
    const { deduplicateProfileGroups, PROFILE_DEDUPE_STRATEGIES } = await import('./profileDedupeService.js')
    const allowed = new Set(PROFILE_DEDUPE_STRATEGIES)
    const requested = Array.isArray(params?.strategies)
      ? params.strategies.map((s) => String(s || '').trim()).filter((s) => allowed.has(s))
      : []
    const strategies = requested.length > 0 ? requested : PROFILE_DEDUPE_STRATEGIES
    const result = await deduplicateProfileGroups(db, {
      strategies,
      includeInactive,
      dryRun: !apply,
      actorUserId: ownerActorUserId(context),
    })
    return {
      ok: true,
      applied: apply,
      preview: !apply,
      ...result,
    }
  },
})

// ── Amy synthetic crawler-training profiles (owner-gated observability) ───────
// The owner-facing /api/profiles list HIDES created_by='agent:amy' profiles (they
// are not real applicants). That hide is correct for humans but blinds Anya to
// Amy's work — she previously reported she "cannot locate any profiles created by
// agent Amy". This tool is the INTERNAL/agent window into that same cohort: it
// reads Amy's authoritative created_by='agent:amy' rows + amy_metadata and reports
// each profile's crawl lifecycle (crawled_at / crawl_count / floor), age, and
// expiry, plus rollup counts. It never mutates anything.
registerTool({
  name: 'owner.list_synthetic_profiles',
  description:
    'OWNER ONLY. List the synthetic crawler-training profiles created by agent Amy (created_by "agent:amy"), which are intentionally hidden from the normal profile list. Returns each profile with its crawl status (crawled_at, crawl_count, last floor), age, and TTL/expiry, plus rollup counts (total, crawled, never_crawled, expired). Use when the owner or Anya asks "which profiles did Amy create", "show Amy\'s synthetic profiles", or wants Amy\'s create→crawl→delete lifecycle status.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      onlyNeverCrawled: { type: 'boolean', description: 'Only return profiles Amy created but never successfully crawled.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max profiles to return (default 100).' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { listAmyProfiles } = await import('./amy/amyProfileStore.js')
    const nowMs = Date.now()
    const rows = await listAmyProfiles(db)
    const mapped = rows.map((row) => {
      const meta = row.metadata || {}
      const createdAt = meta.created_at || row.created_at || null
      const createdMs = createdAt ? Date.parse(createdAt) : NaN
      const expiresMs = meta.expires_at ? Date.parse(meta.expires_at) : NaN
      return {
        id: row.id,
        display_name: row.display_name,
        primary_type: row.primary_type,
        status: row.status,
        created_by: row.created_by,
        amy_run_id: meta.amy_run_id || null,
        scenario_id: meta.scenario_id || null,
        crawled: Boolean(meta.crawled_at),
        crawled_at: meta.crawled_at || null,
        last_crawled_at: meta.last_crawled_at || null,
        crawl_count: Number(meta.crawl_count || 0),
        last_crawl_floor: meta.last_crawl_floor ?? null,
        created_at: createdAt,
        expires_at: meta.expires_at || null,
        age_hours: Number.isFinite(createdMs) ? Math.round(((nowMs - createdMs) / 3_600_000) * 10) / 10 : null,
        expired: Number.isFinite(expiresMs) ? expiresMs <= nowMs : null,
      }
    })
    const filtered = params?.onlyNeverCrawled ? mapped.filter((p) => !p.crawled) : mapped
    // Never-crawled first, then oldest first, so the accumulation risks surface.
    filtered.sort((a, b) => (Number(a.crawled) - Number(b.crawled)) || ((b.age_hours ?? 0) - (a.age_hours ?? 0)))
    const limit = Math.max(1, Math.min(Number(params?.limit) || 100, 500))
    const summary = {
      total: mapped.length,
      crawled: mapped.filter((p) => p.crawled).length,
      never_crawled: mapped.filter((p) => !p.crawled).length,
      expired: mapped.filter((p) => p.expired === true).length,
    }
    return {
      ok: true,
      created_by: 'agent:amy',
      summary,
      count: Math.min(filtered.length, limit),
      profiles: filtered.slice(0, limit),
    }
  },
})

// ── Anya deletes Amy's synthetic crawler-training profiles (owner-gated) ──────
// Amy's create→crawl→learn→DELETE loop is supposed to reap its own synthetic
// profiles, and the nightly reaper is the standing net — but the owner may want
// Anya to purge them ON DEMAND (e.g. leftovers accumulated). This is that
// capability. It delegates to the SAME guarded cleanupAmyProfiles used by Sam's
// sweep, so the safety invariants are identical: it ONLY ever deletes rows with
// created_by='agent:amy' AND amy_metadata.allow_sam_cleanup===true AND
// synthetic===true, and NEVER a designated/system profile. By default it purges
// ALL synthetic profiles (crawled or not); pass onlyCrawled:true to keep
// never-crawled ones, or dryRun:true to preview.
registerTool({
  name: 'owner.cleanup_synthetic_profiles',
  description:
    'OWNER ONLY. Delete the synthetic crawler-training profiles created by agent Amy (created_by "agent:amy"). Use when the owner asks Anya to "delete Amy\'s test profiles", "clean up the synthetic profiles", or "remove the test profiles Amy created". By default deletes ALL of them (crawled or not); set onlyCrawled=true to keep never-crawled ones, or dryRun=true to preview the count without deleting. Safe: only ever removes Amy\'s own tagged synthetic rows, never a real/designated profile.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      onlyCrawled: { type: 'boolean', description: 'Only delete profiles Amy has already crawled/discovered (keep never-crawled ones). Default false = delete all.' },
      dryRun: { type: 'boolean', description: 'Preview how many WOULD be deleted without deleting.' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { cleanupAmyProfiles } = await import('./amy/amyProfileStore.js')
    const onlyCrawled = params?.onlyCrawled === true
    const dryRun = params?.dryRun === true
    // force:true purges regardless of TTL/expiry; requireCrawled gates on the
    // crawl signal only when the owner asked to keep never-crawled ones.
    const result = await cleanupAmyProfiles(db, {
      force: true,
      requireCrawled: onlyCrawled,
      dryRun,
    })
    return {
      ok: true,
      created_by: 'agent:amy',
      dry_run: dryRun,
      only_crawled: onlyCrawled,
      scanned: result.scanned,
      deleted: result.deleted,
      skipped: result.skipped,
      skipped_reasons: (result.skipped_ids || []).map((s) => s.reasons?.[0]).filter(Boolean),
      message: dryRun
        ? `${result.deleted} synthetic profile(s) would be deleted (${result.skipped} skipped).`
        : `Deleted ${result.deleted} synthetic profile(s) Amy created (${result.skipped} skipped).`,
    }
  },
})

// ── Anya moderates matches directly (owner-gated) ─────────────────────────────
// Before this tool the owner had to hand-edit the DB to promote/demote a match
// score or dismiss/restore a pipeline grant — Anya could only explain matches,
// not act on them. Dismiss/restore reuse the SAME choke points the human UI
// uses (grants DELETE route semantics + pipelineDismissals tombstones), so
// sticky-delete invariants hold no matter which path performed the edit.
registerTool({
  name: 'owner.moderate_match',
  description:
    'OWNER ONLY. Moderate a pipeline match for a profile: "promote"/"demote" set a new match_score (0-100); "dismiss" removes the grant from the pipeline WITH a sticky pipeline_dismissals tombstone (so the matcher never re-adds it); "restore" clears the tombstone for a funding opportunity so the matcher may re-add it on the next run. Use when the owner asks Anya to boost, bury, remove, or bring back a match.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile that owns the match' },
      action: { type: 'string', enum: ['promote', 'demote', 'dismiss', 'restore'], description: 'What to do' },
      grantId: { type: 'string', description: 'grants.id — required for promote/demote/dismiss' },
      opportunityId: { type: 'string', description: 'funding_opportunities.id — required for restore' },
      score: { type: 'integer', minimum: 0, maximum: 100, description: 'New match_score for promote/demote (defaults: promote 85, demote 55)' },
      force: { type: 'boolean', description: 'Allow dismissing a user-progressed grant (submitted/awarded). Default false.' },
    },
    required: ['profileId', 'action'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const profileId = String(params.profileId)
    const action = String(params.action || '').toLowerCase()
    const userId = context?.ctx?.userId ?? context?.user?.id ?? null

    if (action === 'promote' || action === 'demote') {
      if (!params.grantId) throw new Error('grantId is required for promote/demote')
      const grantId = String(params.grantId)
      const row = await db.prepare('SELECT id, title, status, match_score FROM grants WHERE id = ? AND profile_id = ?').get(grantId, profileId)
      if (!row) throw new Error(`Grant ${grantId} not found for profile ${profileId}`)
      const fallback = action === 'promote' ? 85 : 55
      const requested = Number.isFinite(Number(params.score)) ? Math.round(Number(params.score)) : fallback
      const newScore = Math.max(0, Math.min(100, requested))
      await db
        .prepare('UPDATE grants SET match_score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND profile_id = ?')
        .run(newScore, grantId, profileId)
      return {
        ok: true,
        action,
        grant_id: grantId,
        profile_id: profileId,
        title: row.title,
        previous_score: row.match_score ?? null,
        new_score: newScore,
      }
    }

    if (action === 'dismiss') {
      if (!params.grantId) throw new Error('grantId is required for dismiss')
      const grantId = String(params.grantId)
      const grantRow = await db.prepare('SELECT * FROM grants WHERE id = ? AND profile_id = ?').get(grantId, profileId)
      if (!grantRow) throw new Error(`Grant ${grantId} not found for profile ${profileId}`)
      // Protected user-progressed statuses are never auto-purged (canonical
      // invariant); the owner must say force:true to override deliberately.
      const protectedStatuses = new Set(['submitted', 'awarded', 'active', 'completed'])
      if (protectedStatuses.has(String(grantRow.status || '').toLowerCase()) && params.force !== true) {
        throw new Error(
          `Grant ${grantId} is user-progressed (status=${grantRow.status}); pass force:true to dismiss it anyway.`,
        )
      }
      let opportunityRow = null
      if (grantRow.funding_opportunity_id) {
        try {
          opportunityRow = await db
            .prepare('SELECT * FROM funding_opportunities WHERE id = ?')
            .get(grantRow.funding_opportunity_id)
        } catch { /* purged source opportunity — tombstone still records by fingerprint */ }
      }
      // Mirror the human DELETE /api/grants/:id path: children first, then the
      // grant, then the sticky tombstone.
      for (const sql of [
        'DELETE FROM milestones WHERE grant_id = ?',
        'DELETE FROM expenses WHERE grant_id = ?',
        'DELETE FROM application_drafts WHERE grant_id = ?',
        'UPDATE documents SET grant_id = NULL WHERE grant_id = ?',
      ]) {
        try { await db.prepare(sql).run(grantId) } catch { /* optional table absent in this env */ }
      }
      await db.prepare('DELETE FROM grants WHERE id = ?').run(grantId)
      const { recordDismissal } = await import('./pipelineDismissals.js')
      const tombstone = await recordDismissal(db, {
        profileId,
        grantRow,
        opportunity: opportunityRow,
        userId,
        reason: 'owner_anya_dismissed',
      })
      return {
        ok: true,
        action,
        grant_id: grantId,
        profile_id: profileId,
        title: grantRow.title,
        dismissed: true,
        tombstone_recorded: tombstone?.recorded === true,
      }
    }

    if (action === 'restore') {
      if (!params.opportunityId) throw new Error('opportunityId is required for restore')
      const opportunity = await db
        .prepare('SELECT * FROM funding_opportunities WHERE id = ?')
        .get(String(params.opportunityId))
      if (!opportunity) throw new Error(`Funding opportunity ${params.opportunityId} not found`)
      const { clearDismissal } = await import('./pipelineDismissals.js')
      const cleared = await clearDismissal(db, profileId, opportunity)
      return {
        ok: true,
        action,
        profile_id: profileId,
        opportunity_id: String(params.opportunityId),
        tombstones_cleared: cleared,
        message: cleared > 0
          ? 'Dismissal cleared — the matcher may re-add this opportunity on its next run.'
          : 'No dismissal tombstone found for this opportunity/profile.',
      }
    }

    throw new Error(`Unknown action "${action}" — expected promote, demote, dismiss, or restore.`)
  },
})

// ── Anya requeues stuck Hamilton tasks (owner-gated) ──────────────────────────
// Blocked/failed Hamilton application tasks previously required manual DB
// surgery (or waiting for the missing-info auto-resume) to re-enter the run
// queue. This puts a task back to 'ready' so the periodic Hamilton runner
// re-picks it — using the SAME applicationTaskStore state machine (never raw
// SQL against a status the CHECK constraint would reject).
registerTool({
  name: 'owner.requeue_hamilton_task',
  description:
    'OWNER ONLY. Re-queue a blocked, waiting, failed, or cancelled Hamilton application task (status back to "ready") so the Hamilton runner re-picks it. Refuses to requeue in-flight or terminal (submitted/completed) tasks. Use when the owner asks Anya to "re-kick", "retry", or "unstick" a Hamilton application.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'application_tasks.id to requeue' },
      reason: { type: 'string', description: 'Optional note recorded on the task event log' },
    },
    required: ['taskId'],
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const taskId = String(params.taskId)
    const { ensureApplicationTaskSchema, getApplicationTask, updateApplicationTask, appendTaskEvent } = await import('./hamilton/applicationTaskStore.js')
    await ensureApplicationTaskSchema(db)
    const task = await getApplicationTask(db, taskId)
    if (!task) throw new Error(`Hamilton task ${taskId} not found`)

    const status = String(task.status || '')
    const requeueable =
      status === 'failed' ||
      status === 'cancelled' ||
      status === 'queued' ||
      status.startsWith('blocked') ||
      status.startsWith('waiting_for')
    if (!requeueable) {
      throw new Error(
        `Task ${taskId} is in status "${status}" — only blocked/waiting/failed/cancelled/queued tasks can be requeued.`,
      )
    }

    const updated = await updateApplicationTask(db, taskId, { status: 'ready' })
    try {
      await appendTaskEvent(db, {
        taskId,
        eventType: 'owner_requeued',
        status: 'ready',
        message: String(params.reason || 'Requeued by the owner via Anya (owner.requeue_hamilton_task).').slice(0, 500),
        actorUserId: context?.ctx?.userId ?? null,
        actorRole: 'owner',
      })
    } catch { /* event log is best-effort; the requeue itself already succeeded */ }
    return {
      ok: true,
      task_id: taskId,
      previous_status: status,
      new_status: updated?.status || 'ready',
      profile_id: task.profile_id ?? null,
    }
  },
})

// ── Anya targets a re-crawl at a weak profile (owner-gated) ───────────────────
// Robert's coverage analyzer identifies weak/zero-result profiles and his
// funding-trace bridge can seed new sources for them — but nothing re-CRAWLED
// the profile afterwards without the owner manually running a crawler. This
// tool closes the loop: seed sources from funded peers (Robert's trace bridge)
// AND dispatch a real crawler job for the profile in one owner ask. With no
// profileId it runs Robert's weakest-profiles sweep instead.
registerTool({
  name: 'owner.recrawl_weak_profile',
  description:
    'OWNER ONLY. Targeted coverage repair for a weak profile: seeds new funding sources via Robert\'s funding-trace bridge (funded peers → their funders → robert_source_candidates) and dispatches a fresh crawler job for the profile. Without a profileId, runs Robert\'s weakest-profiles auto-seed sweep (highest zero-result risk first). Use when the owner says a profile "has no matches", "needs another crawl", or asks Anya to fix weak coverage.',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      profileId: { type: 'string', description: 'Profile to repair; omit to sweep the weakest profiles instead' },
      crawlType: { type: 'string', description: 'Crawler job type to dispatch (default comprehensive)' },
      maxEntities: { type: 'integer', minimum: 1, maximum: 15, description: 'Trace seeds per profile (default 5)' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Sweep width when no profileId given (default 3)' },
      skipCrawl: { type: 'boolean', description: 'Only seed sources; do not dispatch a crawler job.' },
    },
  },
  handler: async (params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { upsertSourceCandidate } = await import('./robert/robertRunStore.js')
    const { autoSeedTraceForProfile, autoSeedWeakestProfiles } = await import('./robert/robertFundingTraceBridge.js')
    const maxEntities = Math.max(1, Math.min(15, Number(params?.maxEntities) || 5))

    if (!params?.profileId) {
      const sweep = await autoSeedWeakestProfiles(db, {
        limit: Math.max(1, Math.min(20, Number(params?.limit) || 3)),
        maxEntitiesPerProfile: maxEntities,
        deps: { upsert: upsertSourceCandidate },
      })
      return { ok: true, mode: 'weakest_sweep', ...sweep }
    }

    const profileId = String(params.profileId)
    const profile = await db.prepare('SELECT id, display_name FROM profiles WHERE id = ?').get(profileId)
    if (!profile) throw new Error(`Profile ${profileId} not found`)

    let seeded = null
    let seedError = null
    try {
      seeded = await autoSeedTraceForProfile(db, {
        profileId,
        maxEntities,
        deps: { upsert: upsertSourceCandidate },
      })
    } catch (err) {
      // Seeding is best-effort widening; the re-crawl below is the core ask.
      seedError = err?.message || String(err)
    }

    let crawl = null
    if (params?.skipCrawl !== true) {
      const { createCrawlerJob } = await import('./crawlerJobCreation.js')
      const { dispatchCrawlerJob } = await import('./crawlerDispatcher.js')
      const creation = await createCrawlerJob(db, {
        type: String(params?.crawlType || 'comprehensive'),
        parameters: { profile_id: profileId },
        requestedBy: context?.ctx?.userId ?? 'anya_owner',
        buildSnapshot: false,
      })
      setImmediate(() => { dispatchCrawlerJob({ db, jobId: creation.jobId }).catch(() => {}) })
      crawl = { job_id: creation.jobId, type: String(params?.crawlType || 'comprehensive') }
    }

    return {
      ok: true,
      mode: 'targeted',
      profile_id: profileId,
      seeded: seeded
        ? { entities: seeded.seeds_traced ?? null, upserted: seeded.total_upserted ?? null, per_entity: seeded.per_entity ?? [] }
        : null,
      seed_error: seedError,
      crawl,
    }
  },
})

// ── Anya proposes code fixes end-to-end (owner-gated) ─────────────────────────
// The final leg of "Anya edits on her own": she can already FIND issues
// (admin.code.autoRepair dry-run) and DRAFT a patch (code.suggestPatch); this
// tool lets her PROPOSE it — dispatching .github/workflows/anya-code-fix-pr.yml
// which applies the patch on a clean checkout, runs the corruption guard +
// quality gate + release gates, opens a PR against main, and (optionally)
// queues CI-gated auto-merge. Never a direct-to-main mutation: branch
// protection's required checks always gate the merge.
registerTool({
  name: 'owner.propose_code_fix',
  description:
    'OWNER ONLY. Propose a code fix as a CI-gated pull request: dispatches the Anya Code Fix GitHub workflow with a unified diff. The workflow applies the patch, runs the release gates, opens a PR against main, and (by default) queues auto-merge that completes ONLY when the required CI checks pass. Pair with code.suggestPatch or admin.code.autoRepair to generate the diff. Refuses patches that touch protected paths (migrations, schema, workflows, auth, billing).',
  requiresOwner: true,
  schema: {
    type: 'object',
    properties: {
      patch: { type: 'string', description: 'Unified diff to propose (from code.suggestPatch / admin.code.autoRepair)' },
      title: { type: 'string', description: 'Short human summary for the PR title' },
      automerge: { type: 'boolean', description: 'Queue CI-gated auto-merge (default true). false = leave the PR for manual review.' },
    },
    required: ['patch'],
  },
  handler: async (params, context) => {
    const { dispatchCodeFixWorkflow } = await import('./anyaCodeFixDispatch.js')
    const result = await dispatchCodeFixWorkflow({
      patch: String(params.patch),
      title: params?.title ? String(params.title) : '',
      automerge: params?.automerge !== false,
      fetchImpl: typeof context?.fetchImpl === 'function' ? context.fetchImpl : null,
    })
    if (!result.ok) {
      // Surface the refusal/dispatch failure as a structured error the chat
      // layer can show verbatim (validation reasons are owner-actionable).
      throw new Error(result.error || 'Code-fix dispatch failed')
    }
    return result
  },
})

// ── Coverage-sweep observability (Agent Observability Rule read side) ────────
// The nightly per-profile result-coverage sweep persists its outcome to
// system_kv `coverage_audit_last_run` (heartbeat status:'running' before the
// heal loop, status:'failed' on exception, status:'completed' with gap counts
// on success). This read-only tool is Anya's window into it — same pattern as
// owner.get_self_heal_status: report exactly what was recorded, never a
// synthesized "healthy".
registerTool({
  name: 'owner.coverage_audit_status',
  description: 'OWNER ONLY. Show the LAST per-profile result-coverage sweep (nightly runProfileCoverageSweep): when it ran, its status (completed / failed / still running), gap counts (with_gap, needs_rediscovery, surfacing_regressions), what the bounded autoheal re-discovered, and the top gapped profiles — read straight from system_kv. Use when the owner asks "did the coverage audit run?" / "which profiles have coverage gaps?".',
  requiresOwner: true,
  schema: { type: 'object', properties: {} },
  handler: async (_params, context) => {
    const db = context?.db
    if (!db) throw new Error('Database connection required')
    const { getLastCoverageSweep } = await import('./coverageAudit/profileResultCoverageAudit.js')
    const last = await getLastCoverageSweep(db)
    if (!last) {
      return { has_run: false, message: 'No coverage sweep has recorded a run yet (system_kv coverage_audit_last_run absent). It runs inside the 04:00 ET nightly sweep; owner.run_nightly_sweep can trigger one now.' }
    }
    return { has_run: true, last_run: last }
  },
})
