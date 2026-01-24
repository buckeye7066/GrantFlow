import express from 'express'
import crypto from 'crypto'
import { ensureOrganizationAccess, requireAuthenticatedUser } from '../utils/accessControl.js'
import { crawlGrantsGov } from '../services/grantsDotGovCrawler.js'
import { upsertFundingOpportunity } from '../services/opportunityInserter.js'
import { searchStateBenefits } from '../services/connectors/benefitsGovConnector.js'

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
  } catch {
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

async function ensureOrg(req, res, orgId) {
  return await ensureOrganizationAccess(req, res, String(orgId))
}

async function getSourceDirectoryRow(db, id) {
  return await db.prepare('SELECT * FROM source_directory WHERE id = ?').get(String(id))
}

// POST /api/crawlGrantsGov (legacy Base44 function endpoint)
router.post('/crawlGrantsGov', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  const logId = createLogId()
  const startedAt = Date.now()
  await insertCrawlLog(req.db, {
    id: logId,
    source: 'grants_gov',
    metadata: { requested_at: nowIso(), user_id: user?.userId ?? null },
  })

  // Background execution (non-blocking).
  setTimeout(async () => {
    try {
      const options = req.body ?? {}
      const maxPages = Math.max(1, Math.min(Number(options.maxPages ?? 1), 10))
      const rowsPerPage = Math.max(10, Math.min(Number(options.rowsPerPage ?? 50), 200))
      const result = await crawlGrantsGov(req.db, { maxPages, rowsPerPage })
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
      await updateCrawlLog(req.db, {
        id: logId,
        status: 'error',
        found: 0,
        imported: 0,
        updated: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: error?.message || String(error),
        metadata: { completed_at: nowIso() },
      }).catch(() => {})
    }
  }, 0)

  return res.json({ ok: true, crawl_log_id: logId })
})

// POST /api/crawlBenefitsGov (legacy Base44 function endpoint)
router.post('/crawlBenefitsGov', async (req, res) => {
  const user = requireUser(req, res)
  if (!user) return

  const payload = req.body ?? {}
  const organizationId = payload.organization_id ?? payload.organizationId ?? null
  const { state } = await loadOrganizationLocation(req.db, organizationId)
  const resolvedState = state ? String(state).toUpperCase() : null

  const logId = createLogId()
  const startedAt = Date.now()
  await insertCrawlLog(req.db, {
    id: logId,
    source: 'benefits_gov',
    metadata: { requested_at: nowIso(), user_id: user?.userId ?? null, state: resolvedState, organization_id: organizationId ?? null },
  })

  setTimeout(async () => {
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
          const sourceUrl = p?.source_url || p?.application_url || 'https://www.benefits.gov'
          const appUrl = p?.application_url || sourceUrl
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
      await updateCrawlLog(req.db, {
        id: logId,
        status: 'error',
        found: 0,
        imported: 0,
        updated: 0,
        durationMs: Date.now() - startedAt,
        errorMessage: error?.message || String(error),
        metadata: { completed_at: nowIso() },
      }).catch(() => {})
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
        website_url: 'https://example.com',
        notes: 'Seeded by local discovery. Replace with real URLs.',
      },
      {
        name: `${state ? `${state} ` : ''}Department of Development`,
        source_type: 'state_agency',
        website_url: 'https://example.com',
        notes: 'Seeded by local discovery. Replace with real URLs.',
      },
      {
        name: 'Regional Hospital System Grants',
        source_type: 'hospital_system',
        website_url: 'https://example.com',
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
    console.error('[legacyFunctions] discoverLocalSources error:', error)
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
    website_url: 'https://example.com',
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
    console.error('[legacyFunctions] crawlSourceDirectory error:', error)
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
    console.error('[legacyFunctions] deleteSourceWithCascade error:', error)
    return res.status(500).json({ success: false, message: error?.message || String(error) })
  }
})

export default router

