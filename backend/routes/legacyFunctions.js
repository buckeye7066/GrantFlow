import express from 'express'
import crypto from 'crypto'
import {
  ensureGrantAccess,
  ensureOrganizationAccess,
  requireAuthenticatedUser,
} from '../utils/accessControl.js'
import { crawlGrantsGov } from '../services/crawlerOsCompatibility.js'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { searchStateBenefits } from '../services/connectors/benefitsGovConnector.js'
import { createOpenAIClient } from '../utils/openaiClient.js'
import { extractCompletionText } from '../utils/openai.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { requireTierCapability, TIER_CAPABILITIES } from '../utils/tierGating.js'
import { extractStateFromContext, loadProfileContext } from '../services/profileHelpers.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:legacyFunctions')

const router = express.Router()

function nowIso() {
  return new Date().toISOString()
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {})
  } catch {
    return '{}'
  }
}

function createLogId() {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

async function insertCrawlLog(db, { id, source, metadata }) {
  await db
    .prepare(
      `
        INSERT INTO crawl_logs (
          id, source, status, records_found, records_imported, records_updated, duration_ms, error_message, metadata
        ) VALUES (?, ?, 'started', 0, 0, 0, NULL, NULL, ?)
      `,
    )
    .run(id, source, safeJson(metadata))
}

async function updateCrawlLog(db, { id, status, found, imported, updated, durationMs, errorMessage, metadata }) {
  const nextMeta = metadata ? safeJson(metadata) : null
  await db
    .prepare(
      `
        UPDATE crawl_logs
        SET status = ?,
            records_found = ?,
            records_imported = ?,
            records_updated = ?,
            duration_ms = ?,
            error_message = ?,
            metadata = COALESCE(?, metadata)
        WHERE id = ?
      `,
    )
    .run(
      status,
      Number(found ?? 0),
      Number(imported ?? 0),
      Number(updated ?? 0),
      Number(durationMs ?? 0),
      errorMessage ?? null,
      nextMeta,
      id,
    )
}

async function loadOrganizationLocation(db, organizationId) {
  if (!organizationId) return { state: null, zip: null }
  try {
    const row = await db
      .prepare('SELECT state, zip FROM organizations WHERE id = ? LIMIT 1')
      .get(String(organizationId))
    return { state: row?.state ?? null, zip: row?.zip ?? null }
  } catch (error) {
    console.warn('[loadOrganizationLocation] Database error:', error?.message)
    return { state: null, zip: null }
  }
}

function stableId(prefix, state, title) {
  const payload = `${prefix}|${state || ''}|${title || ''}`
  return `${prefix}-${crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24)}`
}

function requireUser(req, res) {
  return requireAuthenticatedUser(req, res)
}

function requireAdminCrawlerUser(req, res) {
  const user = requireUser(req, res)
  if (!user) return null
  if (req.ctx?.isAdmin !== true) {
    res.status(403).json({ error: 'admin_required' })
    return null
  }
  return user
}

async function ensureOrg(req, res, orgId) {
  return await ensureOrganizationAccess(req, res, String(orgId))
}

async function getSourceDirectoryRow(db, id) {
  return await db.prepare('SELECT * FROM source_directory WHERE id = ?').get(String(id))
}

function tryExtractFirstJson(text) {
  const raw = String(text || '')
  const match = raw.match(/\{[\s\S]*\}/)
  return safeParseJSON(match ? match[0] : raw, null)
}

function fallbackGrantAnalysisMarkdown({ title }) {
  const t = title ? String(title) : 'Grant'
  return [
    `## ${t} — Analysis (fallback)`,
    '',
    'AI analysis is currently unavailable (no provider configured or provider error).',
    '',
    '### Next steps',
    '- Review eligibility requirements and selection criteria.',
    '- Confirm applicant fit (location, applicant type, and required registrations).',
    '- Gather missing narrative inputs (problem statement, goals, budget, timeline).',
    '',
  ].join('\n')
}

async function invokeOpenAiOptional(prompt) {
  const openai = createOpenAIClient({ allowMissing: true }).openai
  if (!openai) return { text: null, provider: 'fallback' }
  try {
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1200,
    })
    return { text: extractCompletionText(completion), provider: 'openai' }
  } catch {
    return { text: null, provider: 'fallback' }
  }
}

// POST /api/crawlGrantsGov (legacy function endpoint)
router.post('/crawlGrantsGov', async (req, res) => {
  // This endpoint starts a global catalog crawl, not profile-scoped paid work.
  // Only DB-backed admins may run it; a user id must never be misread as a
  // profile id for billing.
  const user = requireAdminCrawlerUser(req, res)
  if (!user) return
  const profileId = String(req.body?.profile_id || req.body?.profileId || '').trim()
  if (!profileId) {
    return res.status(400).json({
      ok: false,
      error: 'profile_id_required',
      message: 'Grants.gov crawling is profile-driven; supply profile_id.',
    })
  }

  const logId = createLogId()
  const startedAt = Date.now()
  await insertCrawlLog(req.db, {
    id: logId,
    source: 'grants_gov',
    metadata: { requested_at: nowIso(), user_id: user?.userId ?? null, profile_id: profileId },
  })

  // Background execution (non-blocking).
  setImmediate(async () => {
    try {
      const options = req.body ?? {}
      const maxPages = Math.max(1, Math.min(Number(options.maxPages ?? 1), 10))
      const rowsPerPage = Math.max(10, Math.min(Number(options.rowsPerPage ?? 50), 200))
      const result = await crawlGrantsGov(req.db, { profileId, maxPages, rowsPerPage })
      if (!result?.success) throw new Error(result?.message || result?.error || 'crawler_os_run_failed')
      const inserted = Number(result?.inserted ?? 0)
      const updated = Number(result?.updated ?? 0)
      const errors = Number(result?.errors ?? 0)
      const found = inserted + updated + errors
      const status = errors > 0 && inserted === 0 ? 'error' : errors > 0 ? 'partial' : 'success'
      await updateCrawlLog(req.db, {
        id: logId,
        status,
        found,
        imported: inserted,
        updated,
        durationMs: Date.now() - startedAt,
        errorMessage: errors > 0 ? `${errors} inserts/updates failed` : null,
        metadata: { ...result, completed_at: nowIso() },
      })
    } catch (error) {
      console.error('[crawlBenefitsGov] Background crawl failed:', error?.message || error)
      await updateCrawlLog(req.db, {
        id: logId,
        status: 'error',
        found: 0,
        imported: 0,
        updated: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: error?.message || String(error),
        metadata: { completed_at: nowIso() },
      }).catch(e => console.warn('[crawlBenefitsGov background]', e?.message || e))
    }
  }, 0)

  return res.json({ ok: true, crawl_log_id: logId, profile_id: profileId, activation_authority: 'crawler-os/planner' })
})

// POST /api/crawlBenefitsGov (legacy function endpoint)
router.post('/crawlBenefitsGov', async (req, res) => {
  // This endpoint starts a global catalog crawl, not profile-scoped paid work.
  // Only DB-backed admins may run it; a user id must never be misread as a
  // profile id for billing.
  const user = requireAdminCrawlerUser(req, res)
  if (!user) return

  const payload = req.body ?? {}
  const organizationId = payload.organization_id ?? payload.organizationId ?? null
  const profileId = payload.profile_id ?? payload.profileId ?? null
  const { state: orgState } = await loadOrganizationLocation(req.db, organizationId)

  // Resolve state from multiple sources: org table, profile sections, profile row
  let resolvedState = orgState ? String(orgState).toUpperCase() : null

  if ((!resolvedState || !/^[A-Z]{2}$/.test(resolvedState)) && (profileId || organizationId)) {
    try {
      // Find profile linked to this org (or use profileId directly)
      let pid = profileId
      if (!pid && organizationId) {
        const profileRow = await req.db
          .prepare('SELECT id FROM profiles WHERE organization_id = ? LIMIT 1')
          .get(String(organizationId))
        pid = profileRow?.id ?? null
      }
      if (pid) {
        const ctx = await loadProfileContext(req.db, pid)
        const sectionState = extractStateFromContext({
          profile: ctx?.profile ?? {},
          sections: ctx?.sections ?? {},
        })
        if (sectionState && /^[A-Z]{2}$/.test(sectionState)) {
          resolvedState = sectionState
        }
      }
    } catch (err) {
      console.warn('[crawlBenefitsGov] Profile section state lookup failed:', err?.message)
    }
  }

  const logId = createLogId()
  const startedAt = Date.now()
  await insertCrawlLog(req.db, {
    id: logId,
    source: 'benefits_gov',
    metadata: { requested_at: nowIso(), user_id: user?.userId ?? null, state: resolvedState, organization_id: organizationId ?? null },
  })

  setImmediate(async () => {
    try {
      if (!resolvedState || !/^[A-Z]{2}$/.test(resolvedState)) {
        await updateCrawlLog(req.db, {
          id: logId,
          status: 'error',
          found: 0,
          imported: 0,
          updated: 0,
          durationMs: Date.now() - startedAt,
          errorMessage: 'Missing organization state; add a state to the profile and try again.',
          metadata: { completed_at: nowIso() },
        })
        return
      }

      const programs = await searchStateBenefits(resolvedState, {})
      const list = Array.isArray(programs) ? programs : []
      let inserted = 0
      let updated = 0
      let errors = 0

      for (const p of list) {
        try {
          const title = String(p?.title || 'Benefit Program').trim()
          const sponsor = String(p?.sponsor || `${resolvedState} program`).trim()
          const sourceUrl = p?.source_url || p?.application_url || null
          const appUrl = p?.application_url || p?.source_url || null
          const opp = {
            id: stableId('benefits-gov', resolvedState, title),
            title,
            sponsor,
            source: 'benefits.gov',
            source_id: stableId('benefits-gov-src', resolvedState, title),
            source_url: sourceUrl,
            application_url: appUrl,
            evidence_url: sourceUrl,
            description: p?.description || '',
            eligibility_bullets: Array.isArray(p?.eligibility_bullets) ? p.eligibility_bullets : p?.eligibility || [],
            deadline_type: 'rolling',
            opportunity_type: 'program',
            is_national: false,
            state: resolvedState,
            record_origin: 'live_crawl',
          }

          const r = await upsertFundingOpportunity(req.db, opp)
          if (r?.inserted) inserted += 1
          if (r?.updated) updated += 1
          if (r?.error) errors += 1
        } catch (e) {
          errors += 1
          console.warn('[crawlBenefitsGov] upsertFundingOpportunity failed for opportunity:', p?.title ?? '(unknown)', e?.message || e)
        }
      }

      const found = inserted + updated + errors
      const status = errors > 0 && inserted === 0 ? 'error' : errors > 0 ? 'partial' : 'success'
      await updateCrawlLog(req.db, {
        id: logId,
        status,
        found,
        imported: inserted,
        updated,
        durationMs: Date.now() - startedAt,
        errorMessage: errors > 0 ? `${errors} inserts/updates failed` : null,
        metadata: { completed_at: nowIso(), state: resolvedState },
      })
    } catch (error) {
      console.error('[crawlBenefitsGov] Background crawl failed:', error?.message || error)
      await updateCrawlLog(req.db, {
        id: logId,
        status: 'error',
        found: 0,
        imported: 0,
        updated: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: error?.message || String(error),
        metadata: { completed_at: nowIso() },
      }).catch(e => console.warn('[crawlBenefitsGov background]', e?.message || e))
    }
  }, 0)

  return res.json({ ok: true, crawl_log_id: logId })
})

// POST /api/discoverLocalSources
router.post('/discoverLocalSources', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  const orgId = req.body?.organization_id ?? null
  if (!orgId) return res.status(400).json({ success: false, message: 'organization_id required' })
  if (!(await ensureOrg(req, res, orgId))) return

  try {
    // Seed a few deterministic sources if none exist for this org.
    const existing = await req.db
      .prepare('SELECT COUNT(*) AS count FROM source_directory WHERE discovered_for_organization_id = ?')
      .get(String(orgId))?.count
    if (Number(existing || 0) > 0) {
      return res.json({ success: true, added: 0 })
    }

    const org = await req.db
      .prepare('SELECT name, city, state FROM organizations WHERE id = ?')
      .get(String(orgId))
    const city = org?.city ?? null
    const state = org?.state ?? null

    const rows = [
      {
        name: `${city ? `${city} ` : ''}Community Foundation`,
        source_type: 'community_foundation',
        website_url: null,
        notes: 'Seeded by local discovery. Replace with real URLs.',
      },
      {
        name: `${state ? `${state} ` : ''}Department of Development`,
        source_type: 'state_agency',
        website_url: null,
        notes: 'Seeded by local discovery. Replace with real URLs.',
      },
      {
        name: 'Regional Hospital System Grants',
        source_type: 'hospital_system',
        website_url: null,
        notes: 'Seeded by local discovery. Replace with real URLs.',
      },
    ]

    const insertSql = `
      INSERT INTO source_directory (
        id, discovered_for_organization_id,
        name, source_type, website_url,
        city, state, active, crawl_frequency, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `

    let added = 0
    for (const r of rows) {
      await req.db
        .prepare(insertSql)
        .run(
          crypto.randomUUID(),
          String(orgId),
          String(r.name),
          r.source_type,
          r.website_url,
          city,
          state,
          1,
          'monthly',
          r.notes,
        )
      added += 1
    }

    return res.json({ success: true, added })
  } catch (error) {
    routeLogger.error('[legacyFunctions] discoverLocalSources error:', error)
    return res.status(500).json({ success: false, message: error?.message || String(error) })
  }
})

// POST /api/searchForSource
router.post('/searchForSource', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  const { source_name, location, organization_id } = req.body ?? {}
  if (!organization_id) return res.status(400).json({ success: false, message: 'organization_id required' })
  if (!(await ensureOrg(req, res, organization_id))) return

  const name = String(source_name || '').trim()
  if (!name) return res.status(400).json({ success: false, message: 'source_name required' })

  // We do NOT call external services here; we just pre-fill a record for the user to review/save.
  const source = {
    id: null,
    discovered_for_organization_id: String(organization_id),
    name,
    website_url: null,
    scholarship_page_url: '',
    city: '',
    state: '',
    zip: '',
    source_type: 'other',
    crawl_frequency: 'monthly',
    active: true,
    notes: `Pre-filled from search query (${String(location || '').trim() || 'no location'}). Replace placeholder URL.`,
  }

  return res.json({ success: true, source })
})

// POST /api/crawlSourceDirectory
router.post('/crawlSourceDirectory', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  const sourceId = req.body?.source_id ?? null
  if (!sourceId) return res.status(400).json({ success: false, message: 'source_id required' })

  try {
    const row = await getSourceDirectoryRow(req.db, sourceId)
    if (!row) return res.status(404).json({ success: false, message: 'Source not found' })
    if (!(await ensureOrg(req, res, row.discovered_for_organization_id))) return

    // Mark crawl completion immediately for now (no external crawling in dev).
    const now = nowIso()
    await req.db
      .prepare('UPDATE source_directory SET last_crawled = ?, updated_at = ? WHERE id = ?')
      .run(now, now, String(sourceId))

    return res.json({ success: true })
  } catch (error) {
    routeLogger.error('[legacyFunctions] crawlSourceDirectory error:', error)
    return res.status(500).json({ success: false, message: error?.message || String(error) })
  }
})

// POST /api/deleteSourceWithCascade
router.post('/deleteSourceWithCascade', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  const orgId = req.body?.organization_id ?? null
  const sourceIds = Array.isArray(req.body?.source_ids) ? req.body.source_ids.map(String) : []
  if (!orgId) return res.status(400).json({ success: false, message: 'organization_id required' })
  if (sourceIds.length === 0) return res.status(400).json({ success: false, message: 'source_ids required' })
  if (!(await ensureOrg(req, res, orgId))) return

  try {
    const rows = await req.db
      .prepare(
        `
          SELECT id, name
          FROM source_directory
          WHERE discovered_for_organization_id = ?
            AND id IN (${sourceIds.map(() => '?').join(', ')})
        `,
      )
      .all(String(orgId), ...sourceIds)

    if (!rows || rows.length === 0) {
      return res.json({ success: true, count: 0, opportunitiesDeleted: 0, grantsDeleted: 0 })
    }

    const names = rows.map((r) => r.name).filter(Boolean)
    const ids = rows.map((r) => r.id)

    let opportunitiesDeleted = 0
    let grantsDeleted = 0

    await req.db.withTransaction(async (tx) => {
      // Delete related grants first (if they reference funding_opportunity_id).
      if (names.length > 0) {
        const oppRows = await tx
          .prepare(
            `
              SELECT id
              FROM funding_opportunities
              WHERE source = 'source_directory'
                AND sponsor IN (${names.map(() => '?').join(', ')})
                AND (profile_id IS NULL OR profile_id = '')
            `,
          )
          .all(...names)
          .catch(() => [])

        const oppIds = Array.isArray(oppRows) ? oppRows.map((r) => r.id).filter(Boolean) : []
        if (oppIds.length > 0) {
          const resGrants = await tx
            .prepare(
              `
                DELETE FROM grants
                WHERE funding_opportunity_id IN (${oppIds.map(() => '?').join(', ')})
              `,
            )
            .run(...oppIds)
            .catch(() => ({ changes: 0 }))
          grantsDeleted = Number(resGrants?.changes ?? 0)

          const resOpps = await tx
            .prepare(
              `
                DELETE FROM funding_opportunities
                WHERE id IN (${oppIds.map(() => '?').join(', ')})
              `,
            )
            .run(...oppIds)
            .catch(() => ({ changes: 0 }))
          opportunitiesDeleted = Number(resOpps?.changes ?? 0)
        }
      }

      const resSources = await tx
        .prepare(
          `
            DELETE FROM source_directory
            WHERE discovered_for_organization_id = ?
              AND id IN (${ids.map(() => '?').join(', ')})
          `,
        )
        .run(String(orgId), ...ids)
      return resSources
    })

    return res.json({
      success: true,
      count: ids.length,
      opportunitiesDeleted,
      grantsDeleted,
    })
  } catch (error) {
    routeLogger.error('[legacyFunctions] deleteSourceWithCascade error:', error)
    return res.status(500).json({ success: false, message: error?.message || String(error) })
  }
})

// POST /api/analyzeGrant (legacy function endpoint)
// Used by Diagnostics + GrantDetail + NOFO Parser. Must exist in production.
router.post('/analyzeGrant', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  try {
    const payload = req.body ?? {}
    const grantId = payload.grantId ?? payload.grant_id ?? null
    if (!grantId) return res.status(400).json({ success: false, error: 'grantId is required' })

    if (!(await ensureGrantAccess(req, res, String(grantId)))) return

    const grant = await req.db
      .prepare(
        `
          SELECT id, organization_id, profile_id, title, funder, deadline,
                 program_description, eligibility_summary, selection_criteria
          FROM grants
          WHERE id = ?
          LIMIT 1
        `,
      )
      .get(String(grantId))

    if (!grant) return res.status(404).json({ success: false, error: 'Grant not found' })

    // Tier enforcement: Grant analysis is a DOCUMENT_AI feature.
    // Try to derive the billing-scoped id from the grant row. Admin bypass remains intact.
    const ctx = req.ctx ?? {}
    // DB-backed admin only — do NOT OR-in the token-claim isAdminUser (stale-JWT bypass).
    const admin = ctx.isAdmin === true
    const resolvedProfileId = String(grant.profile_id ?? grant.organization_id ?? '').trim() || null
    if (!admin) {
      if (!resolvedProfileId) {
        return res.status(400).json({ success: false, error: 'profile_id required for analysis' })
      }
      const allowed = await requireTierCapability(req, res, resolvedProfileId, TIER_CAPABILITIES.DOCUMENT_AI)
      if (!allowed) return
    }

    const title = payload.title ?? grant.title ?? ''
    const description = payload.description ?? grant.program_description ?? ''
    const eligibility = payload.eligibility ?? grant.eligibility_summary ?? ''
    const selectionCriteria = payload.selectionCriteria ?? payload.selection_criteria ?? grant.selection_criteria ?? ''

    const prompt = `
You are a grant proposal coach. Analyze this grant opportunity and return JSON ONLY with:
{
  "analysis_markdown": "markdown string",
  "required_profile_fields": ["field_key", ...]
}

Grant title: ${String(title || '')}
Description: ${String(description || '')}
Eligibility: ${String(eligibility || '')}
Selection criteria: ${String(selectionCriteria || '')}

Notes:
- "required_profile_fields" should be organization/profile fields likely needed to assess fit (e.g. website, mission, annual_budget, staff_count, applicant_type, state, zip, keywords).
`.trim()

    const ai = await invokeOpenAiOptional(prompt)
    if (!ai.text) {
      return res.json({
        success: true,
        analysis: {
          analysis_markdown: fallbackGrantAnalysisMarkdown({ title }),
          required_profile_fields: [],
          ai_provider: ai.provider,
          warning: 'No AI provider configured (OPENAI_API_KEY missing) or provider error.',
        },
      })
    }

    const parsed = tryExtractFirstJson(ai.text) || {}
    const analysis_markdown =
      typeof parsed.analysis_markdown === 'string' && parsed.analysis_markdown.trim()
        ? parsed.analysis_markdown
        : String(ai.text).trim()
    const required_profile_fields = Array.isArray(parsed.required_profile_fields)
      ? parsed.required_profile_fields.filter((v) => typeof v === 'string' && v.trim())
      : []

    return res.json({
      success: true,
      analysis: {
        analysis_markdown,
        required_profile_fields,
        ai_provider: ai.provider,
      },
    })
  } catch (error) {
    routeLogger.error('[legacyFunctions] analyzeGrant error:', error)
    return res.status(500).json({ success: false, error: error?.message || String(error) })
  }
})

export default router
