/**
 * portalCheckService.js
 *
 * Checks configured financial aid and scholarship portals for a student profile
 * and syncs any detected award updates back to the student's university_applications
 * financial_aid_pipeline.
 *
 * Portal content is fetched via HTTP and parsed with the same heuristics used
 * by documentFallbackParser.js (detectScholarshipAmount / detectDecision).
 *
 * NOTE: Most financial-aid portals require authenticated sessions and do not
 * expose award data to anonymous requests.  This service therefore implements a
 * best-effort lightweight scrape of the *public* portal landing page and records
 * the check-in timestamp even when no new awards are found, so operators have a
 * complete audit trail.
 */

import { randomUUID } from 'crypto'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { SCHOLARSHIPS } from './shared/data/scholarships.js'
import { STATE_REGISTRY } from './shared/data/stateRegistry.js'
import ensurePortalCheckResultsTable from '../utils/ensurePortalCheckResultsTable.js'
import { guardProfileSectionForWrite } from '../utils/guardedProfileSectionWrite.js'
import { createLogger } from '../utils/logger.js'
const log = createLogger('portalCheckService')

// ---------------------------------------------------------------------------
// Helpers — re-implemented locally so this service has no circular dependency
// on documentFallbackParser.js (which has no named exports for the detection
// functions).  The logic mirrors what documentFallbackParser uses.
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function findMoneyAmounts(text) {
  const t = String(text || '')
  const matches = []
  const re = /\$[\s]*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/g
  let m
  while ((m = re.exec(t))) {
    const raw = m[0]
    const num = Number(String(m[1]).replace(/,/g, ''))
    if (Number.isFinite(num)) matches.push({ raw, value: num })
    if (matches.length >= 10) break
  }
  return matches
}

function detectScholarshipAmount(text) {
  const t = normalizeText(text)
  const amounts = findMoneyAmounts(text)
  if (amounts.length === 0) return null

  const keywords = ['scholarship', 'award', 'grant', 'merit', 'tuition', 'endowment']
  for (const amt of amounts) {
    const idx = t.indexOf(String(amt.raw).toLowerCase().replace(/\s+/g, ' '))
    if (idx === -1) continue
    const window = t.slice(Math.max(0, idx - 80), Math.min(t.length, idx + 80))
    if (keywords.some((k) => window.includes(k))) {
      return amt
    }
  }
  return amounts.sort((a, b) => b.value - a.value)[0]
}

function detectAwardKeywords(text) {
  const t = normalizeText(text)
  const awardPhrases = [
    'you have been awarded',
    'congratulations',
    'financial aid package',
    'scholarship award',
    'endowment award',
    'grant award',
    'award letter',
    'merit award',
    'financial aid offer',
    'aid package',
    'new award',
    'award notification',
  ]
  return awardPhrases.some((phrase) => t.includes(phrase))
}

// ---------------------------------------------------------------------------
// HTTP fetch — lightweight, no external dependencies
// ---------------------------------------------------------------------------

function fetchUrlOnce(urlString, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(urlString)
    } catch {
      return reject(new Error(`Invalid URL: ${urlString}`))
    }

    const lib = parsed.protocol === 'https:' ? https : http
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': 'GrantFlow-PortalChecker/1.0 (+https://grantflow.app)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }

    const req = lib.request(options, (res) => {
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        resolve(fetchUrlOnce(res.headers.location, timeoutMs))
        res.resume()
        return
      }

      const chunks = []
      res.on('data', (chunk) => {
        chunks.push(chunk)
        if (chunks.reduce((n, c) => n + c.length, 0) > 512 * 1024) {
          req.destroy()
        }
      })
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      res.on('error', reject)
    })

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${urlString}`))
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchUrl(urlString, timeoutMs = 20_000) {
  try {
    return await fetchUrlOnce(urlString, timeoutMs)
  } catch (firstErr) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      return await fetchUrlOnce(urlString, timeoutMs)
    } catch {
      throw firstErr
    }
  }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script[^>]*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Build portal list for a student profile
// ---------------------------------------------------------------------------

/**
 * Returns the list of portals to check for a given student profile.
 * Includes:
 *   1. Per-application school portals from university_applications
 *   2. Global scholarship portals (FAFSA, SCHOLARSHIPS with type === 'portal')
 *   3. State-specific aid portal from stateRegistry
 */
function buildPortalList({ profileSections, state }) {
  const portals = []

  // 1. School-specific portals from university_applications
  const uniData = profileSections?.university_applications
  const parsedUni = typeof uniData === 'string' ? tryParse(uniData) : (uniData || {})
  const apps = Array.isArray(parsedUni?.applications) ? parsedUni.applications : []

  for (const app of apps) {
    const schoolName = app.school_name || app.name || 'Unknown School'
    const portalUrls = [
      { label: `${schoolName} — Financial Aid`, url: app.portals?.financial_aid_url },
      { label: `${schoolName} — Scholarships`, url: app.portals?.scholarships_url },
      { label: `${schoolName} — Student Portal`, url: app.portals?.student_portal_url },
      { label: `${schoolName} — Admissions`, url: app.portals?.admissions_url },
    ]
    for (const p of portalUrls) {
      if (p.url && isValidUrl(p.url)) {
        portals.push({
          portalName: p.label,
          portalUrl: p.url,
          applicationId: app.id || null,
          schoolName,
        })
      }
    }
  }

  // 2. Global scholarship portals (type === 'portal')
  // Skip portals that block automated requests (e.g., government sites, bot-protected portals)
  for (const sch of SCHOLARSHIPS) {
    if (sch.type === 'portal' && sch.url && !sch.skipLivenessCheck) {
      portals.push({
        portalName: sch.name,
        portalUrl: sch.url,
        applicationId: null,
        schoolName: null,
      })
    }
  }

  // 3. State-specific aid portal
  const st = String(state || '').toUpperCase()
  if (st && STATE_REGISTRY[st]?.benefitsPortal) {
    portals.push({
      portalName: `${STATE_REGISTRY[st].name} — State Aid Portal (${STATE_REGISTRY[st].benefitsPortalName || 'Benefits Portal'})`,
      portalUrl: STATE_REGISTRY[st].benefitsPortal,
      applicationId: null,
      schoolName: null,
    })
  }

  // Deduplicate by URL
  const seen = new Set()
  return portals.filter((p) => {
    if (seen.has(p.portalUrl)) return false
    seen.add(p.portalUrl)
    return true
  })
}

function isValidUrl(value) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function tryParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function normalizePortalAward(update = {}, nowIso = new Date().toISOString()) {
  const amountValue = Number(update.awardAmount ?? update.award_amount)
  const awardName =
    String(
      update.awardName ??
      update.award_name ??
      update.portalName ??
      update.portal_name ??
      'Portal award',
    ).trim() || 'Portal award'
  const portalName =
    String(update.portalName ?? update.portal_name ?? awardName).trim() || awardName
  const portalUrl = String(update.portalUrl ?? update.portal_url ?? '').trim() || null
  const awardAmountRaw = String(update.awardAmountRaw ?? update.award_amount_raw ?? '').trim() || null
  return {
    id: String(update.id ?? update.portal_award_id ?? `portal_award_${randomUUID().slice(0, 8)}`),
    source: 'portal_check',
    portal_name: portalName,
    portal_url: portalUrl,
    award_name: awardName,
    award_amount: Number.isFinite(amountValue) ? amountValue : null,
    award_amount_raw: awardAmountRaw,
    detected_at: String(update.detectedAt ?? update.detected_at ?? nowIso),
    merged_at: String(update.mergedAt ?? update.merged_at ?? nowIso),
    status: 'merged',
  }
}

function portalAwardIdentityParts(award = {}) {
  return [
    String(award.portal_url ?? award.portalUrl ?? '').trim().toLowerCase(),
    String(award.portal_name ?? award.portalName ?? '').trim().toLowerCase(),
    String(award.award_name ?? award.awardName ?? '').trim().toLowerCase(),
    String(award.award_amount_raw ?? award.awardAmountRaw ?? '').trim().toLowerCase(),
    Number.isFinite(Number(award.award_amount ?? award.awardAmount))
      ? String(Number(award.award_amount ?? award.awardAmount))
      : '',
  ]
}

export function portalAwardsMatch(left = {}, right = {}) {
  const [leftUrl, leftPortal, leftAward, leftRaw, leftAmount] = portalAwardIdentityParts(left)
  const [rightUrl, rightPortal, rightAward, rightRaw, rightAmount] = portalAwardIdentityParts(right)
  const sameUrl = leftUrl && rightUrl ? leftUrl === rightUrl : true
  const samePortal = leftPortal && rightPortal ? leftPortal === rightPortal : true
  const sameAward = leftAward && rightAward ? leftAward === rightAward : true
  const sameRaw = leftRaw && rightRaw ? leftRaw === rightRaw : true
  const sameAmount = leftAmount && rightAmount ? leftAmount === rightAmount : true
  return sameUrl && samePortal && sameAward && sameRaw && sameAmount
}

function buildPortalAwardPipelineLabel(update = {}) {
  const awardName =
    String(update.awardName ?? update.award_name ?? update.portalName ?? update.portal_name ?? 'Portal award').trim() ||
    'Portal award'
  return `Scholarship Award Detected: ${awardName}`
}

function buildPortalAwardPipelineNote(update = {}) {
  const bits = []
  const amountRaw = String(update.awardAmountRaw ?? update.award_amount_raw ?? '').trim()
  if (amountRaw) bits.push(`Amount: ${amountRaw}`)
  const portalName = String(update.portalName ?? update.portal_name ?? '').trim()
  if (portalName) bits.push(`Source: ${portalName}`)
  bits.push('Merged from portal check')
  return bits.join(' — ')
}

function toIsoDateString(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10)
  }
  const parsed = new Date(value || Date.now())
  return Number.isNaN(parsed.getTime())
    ? new Date().toISOString().slice(0, 10)
    : parsed.toISOString().slice(0, 10)
}

export function mergePortalAwardIntoApplications(applications, update, options = {}) {
  const nextApplications = safeArray(applications).map((application) => ({
    ...application,
    imported_portal_awards: safeArray(application?.imported_portal_awards).map((award) => ({ ...award })),
    financial_aid_pipeline: safeArray(application?.financial_aid_pipeline).map((stage) => ({ ...stage })),
  }))
  const targetApplicationId = String(
    update.applicationId ??
    update.application_id ??
    options.applicationId ??
    '',
  ).trim()
  if (!targetApplicationId) {
    throw new Error('application_id required')
  }
  const targetIndex = nextApplications.findIndex((application) => String(application?.id ?? '') === targetApplicationId)
  if (targetIndex === -1) {
    throw new Error('University application not found')
  }

  const nowIso = String(options.nowIso ?? new Date().toISOString())
  const mergedAward = normalizePortalAward(update, nowIso)
  const target = { ...nextApplications[targetIndex] }
  const importedAwards = safeArray(target.imported_portal_awards).slice()
  const existingAwardIndex = importedAwards.findIndex((award) => portalAwardsMatch(award, mergedAward))
  if (existingAwardIndex === -1) {
    importedAwards.unshift(mergedAward)
  } else {
    importedAwards[existingAwardIndex] = {
      ...importedAwards[existingAwardIndex],
      ...mergedAward,
      id: importedAwards[existingAwardIndex]?.id ?? mergedAward.id,
    }
  }

  const pipeline = safeArray(target.financial_aid_pipeline).slice()
  const label = buildPortalAwardPipelineLabel(update)
  const normalizedLabel = label.toLowerCase()
  const notes = buildPortalAwardPipelineNote(update)
  const completedAt = toIsoDateString(nowIso)
  const existingStageIndex = pipeline.findIndex(
    (stage) => String(stage?.label || '').trim().toLowerCase() === normalizedLabel,
  )
  if (existingStageIndex === -1) {
    pipeline.unshift({
      id: `stage_${randomUUID().slice(0, 8)}`,
      label,
      status: 'completed',
      due_date: null,
      completed_at: completedAt,
      notes,
    })
  } else {
    pipeline[existingStageIndex] = {
      ...pipeline[existingStageIndex],
      status: 'completed',
      completed_at: pipeline[existingStageIndex]?.completed_at || completedAt,
      notes: pipeline[existingStageIndex]?.notes || notes,
    }
  }

  target.imported_portal_awards = importedAwards
  target.financial_aid_pipeline = pipeline
  nextApplications.splice(targetIndex, 1, target)
  return {
    applications: nextApplications,
    mergedAward: importedAwards[existingAwardIndex === -1 ? 0 : existingAwardIndex],
    application: target,
  }
}

export function collectMergedPortalAwards(applications) {
  return safeArray(applications).flatMap((application) =>
    safeArray(application?.imported_portal_awards).map((award) => ({
      ...award,
      application_id: application?.id ?? null,
      application_name: application?.name ?? application?.school_name ?? null,
    })),
  )
}

// ---------------------------------------------------------------------------
// Check a single portal
// ---------------------------------------------------------------------------

async function checkPortal(portal) {
  const detectedAt = new Date().toISOString()
  const base = {
    portalName: portal.portalName,
    portalUrl: portal.portalUrl,
    detectedAt,
    rawContent: null,
    updateType: null,
    awardName: null,
    awardAmount: null,
    applicationId: portal.applicationId || null,
  }

  let rawText = ''
  try {
    const res = await fetchUrl(portal.portalUrl, 20_000)
    rawText = stripHtml(res.body).slice(0, 4_000) // Keep first 4K chars
    base.rawContent = rawText
  } catch (err) {
    console.warn(`[portal-check] fetch failed for ${portal.portalUrl}:`, err?.message)
    return { ...base, error: err?.message || 'fetch failed' }
  }

  const hasAwardKeywords = detectAwardKeywords(rawText)
  const amount = detectScholarshipAmount(rawText)

  if (hasAwardKeywords || amount) {
    base.updateType = amount ? 'scholarship_award' : 'award_notification'
    base.awardName = portal.portalName
    base.awardAmount = amount ? amount.value : null
    base.awardAmountRaw = amount ? amount.raw : null
  }

  return base
}

// ---------------------------------------------------------------------------
// Sync updates into the student's university_applications pipeline
// ---------------------------------------------------------------------------

async function syncAwardToProfile(db, profileId, update) {
  if (!update.applicationId) return

  const row = await new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`SELECT data FROM profile_sections
       WHERE profile_id = ? AND section_key = 'university_applications'
       LIMIT 1`)
      const result = stmt.get(profileId)
      resolve(result)
    } catch (err) {
      reject(err)
    }
  })

  if (!row?.data) return

  let parsed
  try {
    parsed = JSON.parse(row.data)
  } catch {
    return
  }

  const apps = Array.isArray(parsed?.applications) ? parsed.applications : []
  const merged = mergePortalAwardIntoApplications(apps, update)
  const nextPayload = { ...(parsed || {}), applications: merged.applications }

  await new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`INSERT INTO profile_sections (profile_id, section_key, data, updated_by)
       VALUES (?, 'university_applications', ?, 'portal_check')
       ON CONFLICT(profile_id, section_key) DO UPDATE SET
         data = excluded.data,
         updated_at = CURRENT_TIMESTAMP,
         updated_by = excluded.updated_by`)
      guardProfileSectionForWrite(db, profileId, 'university_applications', nextPayload)
        .then((guarded) => resolve(stmt.run(profileId, JSON.stringify(guarded.data))))
        .catch(reject)
    } catch (err) {
      reject(err)
    }
  })
}

// ---------------------------------------------------------------------------
// Store portal check result
// ---------------------------------------------------------------------------

async function storePortalCheckResult(db, { profileId, portalName, portalUrl, checkType, awardsDetected, resultsJson }) {
  const id = randomUUID()
  const checkedAt = new Date().toISOString()

  try {
    await new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`INSERT INTO portal_check_results
           (id, profile_id, portal_name, portal_url, check_type, status, awards_detected, results_json, checked_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?)`)
      const result = stmt.run(id, profileId, portalName, portalUrl || null, checkType || 'scheduled', awardsDetected, resultsJson, checkedAt)
      resolve(result)
    } catch (err) {
      reject(err)
    }
  })
  } catch (err) {
    console.warn('[portal-check] failed to store result:', err?.message)
  }
}

// ---------------------------------------------------------------------------
// Get last check info for each portal (used by frontend)
// ---------------------------------------------------------------------------

export async function getPortalCheckStatus(db, profileId) {
  if (!db || !profileId) return []

  try {
    await ensurePortalCheckResultsTable(db)

    const rows = await new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(`SELECT id, portal_name, portal_url, awards_detected, checked_at, results_json
          FROM portal_check_results
          WHERE profile_id = ?
          ORDER BY checked_at DESC`)
        const result = stmt.all(profileId)
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })

    const sectionRow = await new Promise((resolve, reject) => {
      try {
        const stmt = db.prepare(`SELECT data FROM profile_sections
          WHERE profile_id = ? AND section_key = 'university_applications'
          LIMIT 1`)
        const result = stmt.get(profileId)
        resolve(result)
      } catch (err) {
        reject(err)
      }
    })
    const parsedSection = sectionRow?.data ? tryParse(sectionRow.data) : {}
    const applications = safeArray(parsedSection?.applications)
    const mergedAwards = collectMergedPortalAwards(applications)
    const appNameById = new Map(
      applications.map((application) => [
        String(application?.id ?? ''),
        application?.name ?? application?.school_name ?? null,
      ]),
    )

    const seen = new Set()
    const latestRows = []
    for (const row of rows || []) {
      const parsed = row?.results_json ? tryParse(row.results_json) : {}
      const applicationKey = String(parsed?.applicationId ?? parsed?.application_id ?? '').trim()
      const portalNameKey = String(row?.portal_name ?? parsed?.portalName ?? '').trim().toLowerCase()
      const portalUrlKey = String(row?.portal_url ?? parsed?.portalUrl ?? '').trim().toLowerCase()
      const key = applicationKey
        ? `${applicationKey}|${portalNameKey || portalUrlKey || row?.id || ''}`
        : String(portalUrlKey || portalNameKey || row?.id || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      latestRows.push(row)
    }

    return latestRows.map((row) => {
      const parsed = row?.results_json ? tryParse(row.results_json) : {}
      const mergedAward = mergedAwards.find((award) => portalAwardsMatch(award, parsed)) || null
      const applicationId = String(parsed?.applicationId ?? parsed?.application_id ?? '').trim() || null
      return {
        id: row?.id ?? null,
        portal_name: row?.portal_name ?? parsed?.portalName ?? null,
        portal_url: row?.portal_url ?? parsed?.portalUrl ?? null,
        awards_detected: row?.awards_detected ?? 0,
        checked_at: row?.checked_at ?? null,
        application_id: applicationId,
        application_name: applicationId ? appNameById.get(applicationId) ?? null : null,
        award_name: parsed?.awardName ?? null,
        award_amount: parsed?.awardAmount ?? null,
        award_amount_raw: parsed?.awardAmountRaw ?? null,
        detected_at: parsed?.detectedAt ?? row?.checked_at ?? null,
        update_type: parsed?.updateType ?? null,
        error: parsed?.error ?? null,
        merged_to_profile: Boolean(mergedAward),
        merged_application_id: mergedAward?.application_id ?? null,
        merged_application_name: mergedAward?.application_name ?? null,
      }
    })
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Main export: run portal check for a student profile
// ---------------------------------------------------------------------------

/**
 * Run a portal check for the given student profile.
 *
 * @param {object} db - Database instance
 * @param {string} profileId - Student profile ID
 * @param {object} [options]
 * @param {string} [options.checkType] - 'scheduled' | 'manual' (default: 'scheduled')
 * @param {number} [options.maxPortals] - Max portals to check in one run (default: 20)
 * @returns {Promise<{ profileId, portalsChecked, awardsDetected, updates }>}
 */
export async function runPortalCheck(db, profileId, options = {}) {
  const { checkType = 'scheduled', maxPortals = 20 } = options

  log.info(`[portal-check] Starting portal check for profile ${profileId}`)

  await ensurePortalCheckResultsTable(db)

  // Load profile sections
  const sectionsRows = await new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`SELECT section_key, data FROM profile_sections WHERE profile_id = ?`)
      const result = stmt.all(profileId)
      resolve(result)
    } catch (err) {
      reject(err)
    }
  })

  const profileSections = {}
  for (const row of sectionsRows || []) {
    try {
      profileSections[row.section_key] = JSON.parse(row.data)
    } catch {
      profileSections[row.section_key] = row.data
    }
  }

  // Get state from profile
  const profile = await new Promise((resolve, reject) => {
    try {
      const stmt = db.prepare(`SELECT * FROM profiles WHERE id = ? LIMIT 1`)
      const result = stmt.get(profileId)
      resolve(result)
    } catch (err) {
      reject(err)
    }
  })

  const state =
    profileSections?.personal_info?.state ||
    profile?.state ||
    null

  const portals = buildPortalList({ profileSections, state }).slice(0, maxPortals)

  log.info(`[portal-check] Checking ${portals.length} portals for profile ${profileId}`)

  const updates = []
  let awardsDetected = 0

  for (const portal of portals) {
    const result = await checkPortal(portal)

    if (result.updateType) {
      awardsDetected++
      updates.push(result)

      // Sync to pipeline if this portal is linked to a specific application
      if (result.applicationId) {
        try {
          await syncAwardToProfile(db, profileId, result)
        } catch (err) {
          console.warn(`[portal-check] failed to sync award for app ${result.applicationId}:`, err?.message)
        }
      }
    }

    // Store check-in record
    await storePortalCheckResult(db, {
      profileId,
      portalName: portal.portalName,
      portalUrl: portal.portalUrl,
      checkType,
      awardsDetected: result.updateType ? 1 : 0,
      resultsJson: JSON.stringify(result),
    })
  }

  log.info(`[portal-check] Completed for profile ${profileId}: ${awardsDetected} awards detected across ${portals.length} portals`)

  return {
    profileId,
    portalsChecked: portals.length,
    awardsDetected,
    updates,
  }
}
