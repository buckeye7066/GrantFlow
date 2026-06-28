/**
 * codeGuardService.js — CodeGuard's audit brain, ported from PowerShell to Node.js.
 *
 * Provides three audit tiers that Anya can run automatically or on demand:
 *   1. testEndpoints()        — HTTP health probe against all known API routes
 *   2. auditMatchQuality()    — deterministic pipeline quality grading per profile
 *   3. verifyMissionGoals()   — functional tests for the 15 GrantFlow mission goals
 *
 * Results are persisted in anya_brain_memory (scope: 'global', key: 'codeguard.*')
 * so Anya can recall them during any conversation.
 */

import { storeMemory, getMemory } from './anyaBrainService.js'
import { MISSION_GOALS } from '../config/missionGoals.js'
import { ensureAdminSchemaRepair } from './adminSchemaRepair.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('codeGuardService')

export { MISSION_GOALS }

const AUDIT_COOLDOWN_HOURS = 6

/**
 * Get column names for a table (works on both SQLite and PostgreSQL).
 */
async function getTableColumns(db, tableName) {
  if (db?.dialect === 'postgres') {
    const rows = await db.prepare(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?`
    ).all(tableName)
    return rows || []
  }
  return await db.prepare(`PRAGMA table_info(${tableName})`).all()
}

// ---------------------------------------------------------------------------
// Endpoint health check
// ---------------------------------------------------------------------------

const ENDPOINTS = [
  { path: '/healthz', auth: false, name: 'Health' },
  { path: '/api/meta/build', auth: false, name: 'Build info' },
  { path: '/api/version', auth: false, name: 'Version' },
  { path: '/api/auth/me', auth: true, name: 'Auth me' },
  { path: '/api/profiles?limit=3', auth: true, name: 'Profiles list' },
  { path: '/api/profiles/schema', auth: false, name: 'Profile schema' },
  { path: '/api/opportunities?limit=5', auth: false, name: 'Opportunities' },
  { path: '/api/opportunities/meta/sources', auth: false, name: 'Opportunity sources' },
  { path: '/api/opportunities/geo/summary', auth: false, name: 'Geo summary' },
  { path: '/api/discover-grants?zip=37311&limit=3', auth: false, name: 'Discover TN' },
  { path: '/api/discover-grants?zip=44114&limit=3', auth: false, name: 'Discover OH' },
  { path: '/api/discover-grants?zip=15010&limit=3', auth: false, name: 'Discover PA' },
  { path: '/api/grants?limit=3', auth: true, name: 'Pipeline grants' },
  { path: '/api/matching/health', auth: false, name: 'Match engine health' },
  { path: '/api/organizations?limit=3', auth: true, name: 'Organizations' },
  { path: '/api/crawlers', auth: false, name: 'Crawlers' },
  { path: '/api/real-crawlers', auth: false, name: 'Real crawlers' },
  { path: '/api/services', auth: false, name: 'Services catalog' },
  { path: '/api/documents?limit=3', auth: true, name: 'Documents' },
  { path: '/api/anya/health', auth: true, name: 'Anya health' },
  { path: '/api/admin/diagnostics', auth: true, name: 'Admin diagnostics' },
  { path: '/api/admin/pipeline-health', auth: true, name: 'Pipeline health' },
  { path: '/api/source-directory?limit=3', auth: false, name: 'Source directory' },
  { path: '/api/crawl-logs?limit=3', auth: false, name: 'Crawl logs' },
]

/**
 * Test all known API endpoints and record health.
 * @param {Object} db - Database connection
 * @param {string} baseUrl - e.g. 'http://localhost:3001'
 * @param {string} [adminToken] - Optional admin bearer token
 * @returns {Object} { passed, failed, skipped, total, results, timestamp }
 */
export async function testEndpoints(db, baseUrl, adminToken = null) {
  const results = []
  let passed = 0, failed = 0, skipped = 0

  // Service-auth precedence for the health probe:
  //   1. ADMIN_HEALTH_TOKEN (preferred — read-only scope)
  //   2. Explicit adminToken param
  //   3. ADMIN_TOKEN / ANYA_ADMIN_TOKEN env
  const healthToken = process.env.ADMIN_HEALTH_TOKEN || null
  const fallbackAdmin = adminToken || process.env.ADMIN_TOKEN || process.env.ANYA_ADMIN_TOKEN || null
  const canAuth = Boolean(healthToken || fallbackAdmin)

  const probeEndpoint = async (ep) => {
    if (ep.auth && !canAuth) {
      return { ...ep, status: 'SKIP', code: null, ms: null, reason: 'No auth token' }
    }

    const headers = {}
    if (healthToken) headers['X-Admin-Health-Token'] = healthToken
    if (fallbackAdmin) {
      headers['Authorization'] = `Bearer ${fallbackAdmin}`
      headers['X-Admin-Token'] = fallbackAdmin
    }

    const start = Date.now()
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(`${baseUrl}${ep.path}`, { headers, signal: controller.signal })
      clearTimeout(timeout)
      const ms = Date.now() - start
      const ok = res.status >= 200 && res.status < 400

      let bizWarn = null
      if (ok && ep.path.includes('discover-grants')) {
        try {
          const body = await res.json()
          const arr = body?.results ?? body?.opportunities ?? (Array.isArray(body) ? body : [])
          if (arr.length === 0) bizWarn = 'Zero results returned'
        } catch { /* ignore parse errors */ }
      }

      return { name: ep.name, path: ep.path, status: ok ? 'PASS' : 'FAIL', code: res.status, ms, bizWarn }
    } catch (err) {
      const ms = Date.now() - start
      return { name: ep.name, path: ep.path, status: 'FAIL', code: null, ms, reason: err.message }
    }
  }

  const probed = await Promise.all(ENDPOINTS.map((ep) => probeEndpoint(ep)))
  results.push(...probed)
  passed = results.filter((r) => r.status === 'PASS').length
  failed = results.filter((r) => r.status === 'FAIL').length
  skipped = results.filter((r) => r.status === 'SKIP').length

  const summary = {
    passed,
    failed,
    skipped,
    total: ENDPOINTS.length,
    timestamp: new Date().toISOString(),
    results,
  }

  try {
    await storeMemory(db, {
      scope: 'global',
      memoryKey: 'codeguard.endpoint_health',
      memoryType: 'fact',
      content: summary,
      source: 'codeguard',
    })
  } catch (e) {
    console.warn('[codeGuard] Failed to store endpoint health:', e.message)
  }

  log.info(`[codeGuard] Endpoint health: ${passed} pass, ${failed} fail, ${skipped} skip of ${ENDPOINTS.length}`)
  return summary
}

// ---------------------------------------------------------------------------
// Match quality audit (deterministic — no Claude API calls)
// ---------------------------------------------------------------------------

function gradeProfile(grants) {
  if (!grants.length) return { grade: 'F', stats: { total: 0, withDecision: 0, withExplanation: 0, withUrl: 0, withNeeds: 0, avgScore: 0 } }

  let withDecision = 0, withExplanation = 0, withUrl = 0, withNeeds = 0, scoreSum = 0

  for (const g of grants) {
    if (g.match_decision) withDecision++
    if (g.match_explanation) withExplanation++
    if (g.application_url) withUrl++
    const needs = safeParseJson(g.matched_needs, [])
    if (needs.length > 0) withNeeds++
    scoreSum += g.match_score ?? 0
  }

  const total = grants.length
  const avgScore = Math.round(scoreSum / total)
  const completeness = ((withDecision + withExplanation + withUrl + withNeeds) / (total * 4)) * 100

  let grade = 'F'
  if (completeness >= 80 && avgScore >= 50) grade = 'A'
  else if (completeness >= 60 && avgScore >= 40) grade = 'B'
  else if (completeness >= 40 && avgScore >= 30) grade = 'C'
  else if (completeness >= 20) grade = 'D'

  return { grade, stats: { total, withDecision, withExplanation, withUrl, withNeeds, avgScore } }
}

/**
 * Audit match quality across all profiles using deterministic DB queries.
 * @param {Object} db - Database connection
 * @returns {Object} { profiles: [...], summary, timestamp }
 */
export async function auditMatchQuality(db) {
  await ensureAdminSchemaRepair(db, { backfill: false })
  const profiles = await db.prepare('SELECT id, display_name, primary_type, tags FROM profiles LIMIT 50').all()
  const profileResults = []

  // Check if decision columns exist to avoid SQLITE_ERROR on pre-migration DBs
  const cols = await getTableColumns(db, 'grants')
  const hasDecisionCols = cols.some(c => c.name === 'match_decision')

  const grantQuery = hasDecisionCols
    ? 'SELECT match_score, match_decision, match_explanation, matched_needs, application_url, title FROM grants WHERE profile_id = ? LIMIT 200'
    : 'SELECT match_score, application_url, title FROM grants WHERE profile_id = ? LIMIT 200'

  for (const p of profiles) {
    const grants = await db.prepare(grantQuery).all(p.id)

    const { grade, stats } = gradeProfile(grants)

    profileResults.push({
      profileId: p.id,
      name: p.display_name ?? p.id,
      type: p.primary_type,
      grade,
      ...stats,
    })
  }

  const gradeMap = { A: 0, B: 0, C: 0, D: 0, F: 0 }
  for (const r of profileResults) gradeMap[r.grade]++

  const summary = {
    totalProfiles: profiles.length,
    grades: gradeMap,
    timestamp: new Date().toISOString(),
    profiles: profileResults,
  }

  try {
    await storeMemory(db, {
      scope: 'global',
      memoryKey: 'codeguard.match_quality',
      memoryType: 'fact',
      content: summary,
      source: 'codeguard',
    })
  } catch (e) {
    console.warn('[codeGuard] Failed to store match quality:', e.message)
  }

  log.info(`[codeGuard] Match quality audit: ${profiles.length} profiles — A:${gradeMap.A} B:${gradeMap.B} C:${gradeMap.C} D:${gradeMap.D} F:${gradeMap.F}`)
  return summary
}

// ---------------------------------------------------------------------------
// Mission goal verification (15 goals)
// ---------------------------------------------------------------------------

/**
 * Verify the 15 GrantFlow mission goals using direct DB queries.
 * This is the equivalent of CG5's Start-MissionVerify but runs inside the server.
 * @param {Object} db - Database connection
 * @returns {Object} { goals: [...], score, timestamp }
 */
export async function verifyMissionGoals(db) {
  await ensureAdminSchemaRepair(db)
  const goals = []
  const report = (id, name, status, detail) => goals.push({ id, name, status, detail })

  // Goal 1: Real funding with application URLs
  try {
    const opps = await db.prepare('SELECT application_url, source_url, evidence_url FROM funding_opportunities LIMIT 100').all()
    const withUrl = opps.filter(o => {
      const url = o.application_url || o.source_url || o.evidence_url
      return typeof url === 'string' && url.startsWith('http')
    }).length
    const pct = opps.length ? Math.round(withUrl / opps.length * 100) : 0
    if (opps.length === 0) report(1, MISSION_GOALS[0].short, 'FAIL', 'Zero opportunities in DB')
    else if (pct >= 80) report(1, MISSION_GOALS[0].short, 'PASS', `${pct}% have URLs (${withUrl}/${opps.length})`)
    else report(1, MISSION_GOALS[0].short, 'WARN', `Only ${pct}% have URLs (${withUrl}/${opps.length})`)
  } catch (e) { report(1, MISSION_GOALS[0].short, 'FAIL', e.message) }

  // Goal 2: Match to actual profile needs
  try {
    const grants = await db.prepare(`SELECT match_score, matched_needs, match_decision FROM grants WHERE profile_id IS NOT NULL LIMIT 100`).all()
    const withNeeds = grants.filter(g => {
      const needs = safeParseJson(g.matched_needs, [])
      return needs.length > 0
    }).length
    const pct = grants.length ? Math.round(withNeeds / grants.length * 100) : 0
    if (grants.length === 0) report(2, 'Match to profile needs', 'FAIL', 'No profile-scoped grants')
    else if (pct >= 70) report(2, 'Match to profile needs', 'PASS', `${pct}% have need-alignment data`)
    else report(2, 'Match to profile needs', 'WARN', `Only ${pct}% have need-alignment data`)
  } catch (e) { report(2, 'Match to profile needs', 'FAIL', e.message) }

  // Goal 3: Reject irrelevant/misleading results
  try {
    const junkRe = /\b(loan|loans?|microloan|repayment|closed|coming soon|placeholder|test record|not accepting|applications closed)\b/i
    const grants = await db.prepare('SELECT title, notes FROM grants WHERE profile_id IS NOT NULL LIMIT 200').all()
    const junk = grants.filter(g => junkRe.test(g.title || '') || junkRe.test(g.notes || ''))
    if (grants.length === 0) report(3, 'Reject irrelevant results', 'WARN', 'No grants to check')
    else if (junk.length === 0) report(3, 'Reject irrelevant results', 'PASS', `No junk in ${grants.length} grants`)
    else report(3, 'Reject irrelevant results', 'FAIL', `${junk.length} junk items: ${junk.slice(0, 3).map(j => j.title).join(', ')}`)
  } catch (e) { report(3, 'Reject irrelevant results', 'FAIL', e.message) }

  // Goal 4: Single canonical decision engine
  try {
    const cols = await getTableColumns(db, 'grants')
    const hasDecision = cols.some(c => c.name === 'match_decision')
    if (!hasDecision) {
      report(4, 'Canonical decision engine', 'FAIL', 'grants table missing match_decision column — run migrations')
    } else {
      const withDecisionRow = await db.prepare('SELECT COUNT(*) as c FROM grants WHERE match_decision IS NOT NULL').get()
      const withDecision = withDecisionRow?.c ?? 0
      const totalRow = await db.prepare('SELECT COUNT(*) as c FROM grants WHERE profile_id IS NOT NULL').get()
      const total = totalRow?.c ?? 0
      if (total === 0) report(4, 'Canonical decision engine', 'WARN', 'No profile grants to verify')
      else if (withDecision > 0) report(4, 'Canonical decision engine', 'PASS', `${withDecision}/${total} grants have canonical decisions`)
      else report(4, 'Canonical decision engine', 'FAIL', 'No grants have match_decision populated')
    }
  } catch (e) { report(4, 'Canonical decision engine', 'FAIL', e.message) }

  // Goal 5: Use full profile, not just surface tags
  try {
    const deepRe = /military|education|family|health|emergency|business|housing|employment|financial|disability/i
    const sections = await db.prepare('SELECT DISTINCT section_key FROM profile_sections').all()
    const deepSections = sections.filter(s => deepRe.test(s.section_key))
    if (deepSections.length >= 5) report(5, 'Full profile depth', 'PASS', `${deepSections.length} deep section types used`)
    else if (deepSections.length >= 2) report(5, 'Full profile depth', 'WARN', `Only ${deepSections.length} deep section types`)
    else report(5, 'Full profile depth', 'FAIL', `${deepSections.length} deep section types`)
  } catch (e) { report(5, 'Full profile depth', 'FAIL', e.message) }

  // Goal 6: Handle many applicant types
  try {
    const types = await db.prepare('SELECT DISTINCT primary_type FROM profiles WHERE primary_type IS NOT NULL').all()
    const count = types.length
    if (count >= 3) report(6, 'Multiple applicant types', 'PASS', `${count} types: ${types.map(t => t.primary_type).join(', ')}`)
    else if (count >= 1) report(6, 'Multiple applicant types', 'WARN', `Only ${count} type(s)`)
    else report(6, 'Multiple applicant types', 'FAIL', 'No profiles with primary_type')
  } catch (e) { report(6, 'Multiple applicant types', 'FAIL', e.message) }

  // Goal 7: Balance recall with correctness
  try {
    const grantsRow = await db.prepare('SELECT COUNT(*) as c FROM grants WHERE profile_id IS NOT NULL').get()
    const grants = grantsRow?.c ?? 0
    const profilesRow = await db.prepare('SELECT COUNT(*) as c FROM profiles').get()
    const profiles = profilesRow?.c ?? 0
    const avg = profiles > 0 ? Math.round(grants / profiles) : 0
    if (grants >= 10 && avg >= 2) report(7, 'Recall vs correctness balance', 'PASS', `${grants} grants across ${profiles} profiles (avg ${avg})`)
    else if (grants > 0) report(7, 'Recall vs correctness balance', 'WARN', `Only ${grants} grants across ${profiles} profiles (avg ${avg})`)
    else report(7, 'Recall vs correctness balance', 'FAIL', 'Zero grants in pipeline')
  } catch (e) { report(7, 'Recall vs correctness balance', 'FAIL', e.message) }

  // Goal 8: Explainable and auditable pipeline
  try {
    const cols = await getTableColumns(db, 'grants')
    const hasExplain = cols.some(c => c.name === 'match_explanation')
    if (!hasExplain) {
      report(8, 'Explainable pipeline', 'FAIL', 'grants table missing match_explanation column — run migrations')
    } else {
      const grants = await db.prepare('SELECT match_explanation, match_decision, profile_fingerprint FROM grants WHERE profile_id IS NOT NULL LIMIT 100').all()
      const withExplain = grants.filter(g => g.match_explanation).length
      const pct = grants.length ? Math.round(withExplain / grants.length * 100) : 0
      if (grants.length === 0) report(8, 'Explainable pipeline', 'WARN', 'No grants')
      else if (pct >= 50) report(8, 'Explainable pipeline', 'PASS', `${pct}% have explanations`)
      else report(8, 'Explainable pipeline', 'FAIL', `Only ${pct}% have explanations (${withExplain}/${grants.length})`)
    }
  } catch (e) { report(8, 'Explainable pipeline', 'FAIL', e.message) }

  // Goal 9: Re-evaluate on changes (fingerprints exist)
  try {
    const cols = await getTableColumns(db, 'grants')
    const hasFp = cols.some(c => c.name === 'profile_fingerprint')
    if (!hasFp) {
      report(9, 'Re-evaluation support', 'FAIL', 'grants table missing fingerprint columns — run migrations')
    } else {
      const grants = await db.prepare('SELECT profile_fingerprint, opportunity_fingerprint, matcher_version FROM grants WHERE profile_id IS NOT NULL LIMIT 100').all()
      const withFp = grants.filter(g => g.profile_fingerprint || g.opportunity_fingerprint).length
      const pct = grants.length ? Math.round(withFp / grants.length * 100) : 0
      if (grants.length === 0) report(9, 'Re-evaluation support', 'WARN', 'No grants')
      else if (pct >= 30) report(9, 'Re-evaluation support', 'PASS', `${pct}% have fingerprints`)
      else report(9, 'Re-evaluation support', 'FAIL', `Only ${pct}% have fingerprints`)
    }
  } catch (e) { report(9, 'Re-evaluation support', 'FAIL', e.message) }

  // Goal 10: Help users improve profiles
  try {
    const sectionsRow = await db.prepare('SELECT COUNT(DISTINCT section_key) as c FROM profile_sections').get()
    const sections = sectionsRow?.c ?? 0
    if (sections >= 5) report(10, 'Profile improvement guidance', 'PASS', `${sections} section types in use`)
    else report(10, 'Profile improvement guidance', 'WARN', `Only ${sections} section types`)
  } catch (e) { report(10, 'Profile improvement guidance', 'FAIL', e.message) }

  // Goal 11: Profile-driven crawling
  try {
    const logsRow = await db.prepare('SELECT COUNT(*) as c FROM crawler_logs WHERE profile_id IS NOT NULL').get()
    const logs = logsRow?.c ?? 0
    if (logs > 0) report(11, 'Profile-driven crawling', 'PASS', `${logs} profile-scoped crawl runs logged`)
    else report(11, 'Profile-driven crawling', 'WARN', 'No profile-scoped crawl logs found')
  } catch (e) { report(11, 'Profile-driven crawling', 'FAIL', e.message) }

  // Goal 12: Plain-language explanations
  try {
    const grants = await db.prepare('SELECT match_reasons FROM grants WHERE profile_id IS NOT NULL AND match_reasons IS NOT NULL LIMIT 50').all()
    const withReasons = grants.filter(g => {
      const reasons = safeParseJson(g.match_reasons, [])
      return reasons.length > 0
    }).length
    const pct = grants.length ? Math.round(withReasons / grants.length * 100) : 0
    if (grants.length === 0) report(12, 'Plain-language explanations', 'WARN', 'No grants with reasons')
    else if (pct >= 50) report(12, 'Plain-language explanations', 'PASS', `${pct}% have reasons arrays`)
    else report(12, 'Plain-language explanations', 'FAIL', `Only ${pct}% have reasons`)
  } catch (e) { report(12, 'Plain-language explanations', 'FAIL', e.message) }

  // Goal 13: Application workflow
  try {
    const statuses = await db.prepare(`SELECT DISTINCT status FROM grants WHERE status NOT IN ('discovered', 'archived')`).all()
    if (statuses.length >= 2) report(13, 'Application workflow', 'PASS', `${statuses.length} active statuses: ${statuses.map(s => s.status).join(', ')}`)
    else report(13, 'Application workflow', 'WARN', `Only ${statuses.length} active statuses beyond discovered/archived`)
  } catch (e) { report(13, 'Application workflow', 'FAIL', e.message) }

  // Goal 14: Anya as useful guide
  try {
    const sessionsRow = await db.prepare('SELECT COUNT(*) as c FROM anya_sessions').get()
    const sessions = sessionsRow?.c ?? 0
    const memoriesRow = await db.prepare('SELECT COUNT(*) as c FROM anya_brain_memory').get()
    const memories = memoriesRow?.c ?? 0
    if (sessions > 0 && memories > 0) report(14, 'Anya as guide', 'PASS', `${sessions} sessions, ${memories} memories`)
    else if (sessions > 0) report(14, 'Anya as guide', 'WARN', `${sessions} sessions but ${memories} memories`)
    else report(14, 'Anya as guide', 'FAIL', 'No Anya sessions')
  } catch (e) { report(14, 'Anya as guide', 'FAIL', e.message) }

  // Goal 15: Anya grounded in app structure
  try {
    const toolUsageRow = await db.prepare('SELECT COUNT(DISTINCT tool_name) as c FROM anya_tool_usage').get()
    const toolUsage = toolUsageRow?.c ?? 0
    if (toolUsage >= 3) report(15, 'Anya grounded in app', 'PASS', `${toolUsage} distinct tools used`)
    else if (toolUsage > 0) report(15, 'Anya grounded in app', 'WARN', `Only ${toolUsage} tools used`)
    else report(15, 'Anya grounded in app', 'FAIL', 'No tool usage recorded')
  } catch (e) { report(15, 'Anya grounded in app', 'FAIL', e.message) }

  const passCount = goals.filter(g => g.status === 'PASS').length
  const failCount = goals.filter(g => g.status === 'FAIL').length
  const warnCount = goals.filter(g => g.status === 'WARN').length
  const score = Math.round(passCount / goals.length * 100)

  const result = {
    goals,
    score,
    pass: passCount,
    fail: failCount,
    warn: warnCount,
    total: goals.length,
    timestamp: new Date().toISOString(),
  }

  try {
    await storeMemory(db, {
      scope: 'global',
      memoryKey: 'codeguard.mission_score',
      memoryType: 'fact',
      content: result,
      source: 'codeguard',
    })
  } catch (e) {
    console.warn('[codeGuard] Failed to store mission score:', e.message)
  }

  log.info(`[codeGuard] Mission verification: ${score}% (${passCount} pass, ${warnCount} warn, ${failCount} fail)`)
  return result
}

// ---------------------------------------------------------------------------
// Audit summary for Anya's system context
// ---------------------------------------------------------------------------

/**
 * Build a human-readable audit summary from stored brain data.
 * Anya's system prompt can include this to ground her responses in real system state.
 * @param {Object} db
 * @returns {string} Plain text summary
 */
export async function getAuditSummary(db) {
  const lines = []

  const epHealth = await getMemory(db, { scope: 'global', memoryKey: 'codeguard.endpoint_health' })
  if (epHealth?.content) {
    const h = epHealth.content.endpoints ?? epHealth.content
    lines.push(`Endpoint Health (${h.timestamp ?? 'unknown'}): ${h.passed ?? 0} pass, ${h.failed ?? 0} fail, ${h.skipped ?? 0} skip of ${h.total ?? 0}`)
    const failures = (h.results || []).filter(r => r.status === 'FAIL')
    if (failures.length > 0) {
      lines.push(`  Failing: ${failures.map(f => `${f.name} (${f.code ?? f.reason})`).join(', ')}`)
    }
    const bizWarns = (h.results || []).filter(r => r.bizWarn)
    if (bizWarns.length > 0) {
      lines.push(`  Business warnings: ${bizWarns.map(b => `${b.name}: ${b.bizWarn}`).join(', ')}`)
    }
  }

  const matchQ = await getMemory(db, { scope: 'global', memoryKey: 'codeguard.match_quality' })
  if (matchQ?.content) {
    const m = matchQ.content.matchQuality ?? matchQ.content
    const g = m.grades || {}
    lines.push(`Match Quality (${m.timestamp ?? 'unknown'}): ${m.totalProfiles ?? 0} profiles — A:${g.A ?? 0} B:${g.B ?? 0} C:${g.C ?? 0} D:${g.D ?? 0} F:${g.F ?? 0}`)
    const problemProfiles = (m.profiles || []).filter(p => p.grade === 'D' || p.grade === 'F')
    if (problemProfiles.length > 0) {
      lines.push(`  Needs attention: ${problemProfiles.map(p => `${p.name} (${p.grade})`).join(', ')}`)
    }
  }

  const mission = await getMemory(db, { scope: 'global', memoryKey: 'codeguard.mission_score' })
  if (mission?.content) {
    const mv = mission.content.mission ?? mission.content
    lines.push(`Mission Score (${mv.timestamp ?? 'unknown'}): ${mv.score ?? 0}% — ${mv.pass ?? 0} pass, ${mv.warn ?? 0} warn, ${mv.fail ?? 0} fail of ${mv.total ?? 0}`)
    const failing = (mv.goals || []).filter(g => g.status === 'FAIL')
    if (failing.length > 0) {
      lines.push(`  Failing goals:`)
      for (const g of failing) {
        const goalDef = MISSION_GOALS.find(m => m.id === g.id)
        const rule = goalDef ? ` Rule: ${goalDef.rule}` : ''
        lines.push(`    #${g.id} ${g.name}: ${g.detail}${rule}`)
      }
    }
    const warning = (mv.goals || []).filter(g => g.status === 'WARN')
    if (warning.length > 0) {
      lines.push(`  Warning goals: ${warning.map(g => `#${g.id} ${g.name}: ${g.detail}`).join('; ')}`)
    }
  }

  if (lines.length === 0) {
    return 'CodeGuard: No audit data yet. Audits run automatically on admin startup.'
  }

  return 'CodeGuard System Audit:\n' + lines.join('\n')
}

export function formatAuditSummary({ endpoints = null, matchQuality = null, mission = null } = {}) {
  const lines = []

  if (endpoints) {
    const h = endpoints.endpoints ?? endpoints
    lines.push(`Endpoint Health (${h.timestamp ?? new Date().toISOString()}): ${h.passed ?? 0} pass, ${h.failed ?? 0} fail, ${h.skipped ?? 0} skip of ${h.total ?? 0}`)
    const failures = (h.results || []).filter(r => r.status === 'FAIL')
    if (failures.length > 0) {
      lines.push(`  Failing: ${failures.map(f => `${f.name} (${f.code ?? f.reason})`).join(', ')}`)
    }
  }

  if (matchQuality) {
    const m = matchQuality.matchQuality ?? matchQuality
    const g = m.grades || {}
    lines.push(`Match Quality (${m.timestamp ?? new Date().toISOString()}): ${m.totalProfiles ?? 0} profiles — A:${g.A ?? 0} B:${g.B ?? 0} C:${g.C ?? 0} D:${g.D ?? 0} F:${g.F ?? 0}`)
  }

  if (mission) {
    const mv = mission.mission ?? mission
    lines.push(`Mission Score (${mv.timestamp ?? new Date().toISOString()}): ${mv.score ?? 0}% — ${mv.pass ?? 0} pass, ${mv.warn ?? 0} warn, ${mv.fail ?? 0} fail of ${mv.total ?? 0}`)
  }

  if (lines.length === 0) return 'CodeGuard: No audit data yet. Run CodeGuard audits to populate status.'
  return 'CodeGuard System Audit:\n' + lines.join('\n')
}

/**
 * Check whether enough time has passed since the last audit.
 * @param {Object} db
 * @returns {boolean}
 */
export async function shouldRunAudit(db) {
  try {
    const last = await getMemory(db, { scope: 'global', memoryKey: 'codeguard.last_audit' })
    if (!last?.content?.timestamp) return true
    const hoursSince = (Date.now() - new Date(last.content.timestamp).getTime()) / 3_600_000
    return hoursSince >= AUDIT_COOLDOWN_HOURS
  } catch (e) {
    console.warn('[codeGuard] shouldRunAudit check failed, defaulting to run:', e.message)
    return true
  }
}

/**
 * Mark the current time as the last audit run.
 * @param {Object} db
 */
export async function markAuditComplete(db) {
  await storeMemory(db, {
    scope: 'global',
    memoryKey: 'codeguard.last_audit',
    memoryType: 'fact',
    content: { timestamp: new Date().toISOString() },
    source: 'codeguard',
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson(val, fallback) {
  if (!val) return fallback
  try { return JSON.parse(val) } catch { return fallback }
}
