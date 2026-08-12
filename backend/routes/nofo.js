import express from 'express'
import pdfParse from 'pdf-parse'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import { sanitizeLogValue } from '../utils/logger.js'
import { requireAuthenticatedUser, ensureOrganizationAccess } from '../utils/accessControl.js'
import { standardRateLimiter } from '../middleware/rateLimiting.js'
import { parseGrantsGovDigest } from '../../shared/grantsGovDigestParser.js'
import { saveToProfilePipeline } from '../services/opportunityMatcher.js'
import { loadProfileContext } from '../services/profileHelpers.js'
import { RELEVANCE_FLOOR } from '../config/relevanceFloor.js'
import { fetchPublicResource, publicFetchFailureStatus } from '../utils/safeRemoteFetch.js'

import { createLogger } from '../utils/logger.js'
const routeLogger = createLogger('route:nofo')

// A caller-supplied minMatchThreshold may not drop a save below the canonical
// pipeline relevance floor — clamp every request-controlled threshold so the
// NOFO import endpoints can't be used to smuggle sub-floor rows into a pipeline.
const clampPipelineThreshold = (value) => {
  const numeric = Number(value)
  const requested = Number.isFinite(numeric)
    ? Math.max(0, Math.min(100, numeric))
    : RELEVANCE_FLOOR
  return Math.max(requested, RELEVANCE_FLOOR)
}

const router = express.Router()

const MAX_TEXT_CHARS = Number(process.env.NOFO_PARSE_MAX_TEXT_CHARS || 14_000)
const MAX_REMOTE_BYTES = Number(process.env.NOFO_FETCH_MAX_BYTES || 20 * 1024 * 1024)
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

function getOpenAIOptional() {
  return createOpenAIClient({ allowMissing: true }).openai
}

async function createAnthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.ANYA_ANTHROPIC_TIMEOUT_MS || 15_000),
    maxRetries: Number(process.env.ANYA_ANTHROPIC_MAX_RETRIES || 1),
  })
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

function tryExtractFirstJson(text) {
  const raw = String(text || '')
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch (error) {
    console.warn('[tryExtractFirstJson] Parse failed:', error.message)
    return null
  }
}

async function fetchPdfTextFromUrl(fileUrl) {
  const FETCH_TIMEOUT_MS = Number(process.env.NOFO_FETCH_TIMEOUT_MS || 20_000)
  const remote = await fetchPublicResource(fileUrl, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_REMOTE_BYTES,
    allowedContentTypes: [
      'application/pdf',
      'application/octet-stream',
      'text/html',
      'application/xhtml+xml',
      'text/plain',
      'application/xml',
      'text/xml',
    ],
    userAgent: 'GrantFlow NOFO Parser (+https://app.axiombiolabs.org)',
    accept: 'text/html,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  })
  if (!remote.ok) {
    const err = new Error(`Unable to fetch public HTTPS resource: ${remote.reason}`)
    err.status = publicFetchFailureStatus(remote)
    err.code = `REMOTE_FETCH_${String(remote.reason || 'FAILED').toUpperCase()}`
    throw err
  }
  const contentType = String(remote.contentType || '').toLowerCase()

  // Some callers pass a web page URL (e.g. grants.gov detail pages). In those cases,
  // pdf-parse will throw because the payload is HTML. Treat non-PDF content as text/HTML
  // and extract a best-effort plain-text representation.
  const buf = remote.body
  if (
    contentType === 'application/octet-stream' &&
    (buf.length < 5 || buf.subarray(0, 5).toString('ascii') !== '%PDF-')
  ) {
    const err = new Error('Remote server returned an unverified binary NOFO type.')
    err.status = 415
    err.code = 'REMOTE_NOFO_TYPE_UNVERIFIED'
    throw err
  }
  const asString = () => {
    try {
      return buf.toString('utf8')
    } catch (error) {
      console.warn('[fetchPdfTextFromUrl] String conversion failed:', error.message)
      return ''
    }
  }

  const looksLikePdf =
    contentType.includes('application/pdf') ||
    (buf.length >= 5 && buf.subarray(0, 5).toString('utf8') === '%PDF-')

  if (looksLikePdf) {
    const parsed = await pdfParse(buf)
    const text = String(parsed?.text || '').trim()
    return { text, contentType, bytes: buf.length }
  }

  // HTML/text fallback.
  //
  // Order matters here: decoding HTML entities (&lt; -> <) AFTER stripping
  // tags can reintroduce tag-like structure the strip step already ran past
  // (e.g. literal "&lt;script&gt;" text — safely inert at strip time — comes
  // back out as a live "<script>" in the final output). Decode entities
  // FIRST, then strip tags on the decoded text, so nothing sneaks through
  // (CodeQL js/double-escaping + js/bad-tag-filter).
  const raw = asString()
  const decoded = raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  const withoutScripts = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(p|div|br|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  const text = withoutScripts
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()

  return { text, contentType, bytes: buf.length }
}

function heuristicFallback(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const title = lines.find((l) => l.length >= 8 && l.length <= 140) || null
  return { title, funder: null }
}

async function resolveProfileId(db, { profileId, organizationId }) {
  const normalizedProfileId = profileId ? String(profileId).trim() : ''
  if (normalizedProfileId) {
    const profile = await db.prepare('SELECT id FROM profiles WHERE id = ? LIMIT 1').get(normalizedProfileId)
    return profile?.id ?? null
  }

  const normalizedOrgId = organizationId ? String(organizationId).trim() : ''
  if (!normalizedOrgId) return null

  const byOrg = await db
    .prepare('SELECT id FROM profiles WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(normalizedOrgId)
  if (byOrg?.id) return byOrg.id

  // Legacy deployments sometimes used organization id as profile id.
  const direct = await db.prepare('SELECT id FROM profiles WHERE id = ? LIMIT 1').get(normalizedOrgId)
  return direct?.id ?? null
}

function digestOpportunityToGrantPayload(opp, organizationId) {
  return {
    ...opp,
    title: opp.title,
    funder: opp.funder || opp.sponsor || opp.department || 'Federal',
    sponsor: opp.sponsor || opp.funder || opp.department || 'Federal',
    application_url: opp.application_url || opp.url,
    url: opp.url || opp.application_url,
    organization_id: organizationId,
    status: 'discovered',
    opportunity_type: 'grant',
    ai_status: 'queued',
    source: opp.source || 'grants.gov',
    record_origin: opp.record_origin || 'url_import',
    match_decision: null,
    match_explanation: null,
    matched_needs: [],
    eligibility_status: 'pending',
    ineligibility_reasons: [],
    fingerprints: null,
    matcher_version: null,
    evaluated_at: null,
    match_confidence: null,
  }
}

// POST /api/parseNOFO
// Body: { file_url: string, json_schema?: object, is_url?: boolean }
router.post('/parseNOFO', standardRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return
    const fileUrl = typeof req.body?.file_url === 'string' ? req.body.file_url.trim() : ''
    const schema = req.body?.json_schema && typeof req.body.json_schema === 'object' ? req.body.json_schema : null
    const isUrl = req.body?.is_url === true || req.body?.is_url === 'true'

    if (!fileUrl) {
      return res.status(400).json({ success: false, message: 'file_url is required' })
    }

    const { text, contentType } = await fetchPdfTextFromUrl(fileUrl)
    if (!text) {
      // CodeQL js/log-injection (#585): raw req.body.file_url, no URL-format
      // validation before this log call.
      console.warn('[parseNOFO] Empty text extracted from URL:', sanitizeLogValue(fileUrl), '| contentType:', contentType)
      return res.status(422).json({
        success: false,
        message: contentType.includes('pdf')
          ? 'No extractable text found in document (may be scanned images).'
          : isUrl
            ? 'No extractable text found at the provided URL.'
            : 'No extractable text found in document.',
      })
    }

    const clipped = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS - 1)}…` : text

    const system =
      'You extract grant NOFO information from documents. ' +
      'Only return information supported by the provided text. Do not invent facts.'

    const prompt =
      `Extract a JSON object from this NOFO.\n\n` +
      (schema ? `JSON SCHEMA (use these keys/types):\n${JSON.stringify(schema, null, 2)}\n\n` : '') +
      `NOFO TEXT:\n${clipped}\n\n` +
      `Return ONLY a valid JSON object.`

    const openai = getOpenAIOptional()
    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 1800,
        })

        const raw = completion.choices?.[0]?.message?.content
        const parsed = raw ? tryExtractFirstJson(raw) : null
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return res.json({ success: true, output: parsed, ai_provider: 'openai' })
        }
      } catch (error) {
        const summary = summarizeOpenAIError(error)
        console.warn('[parseNOFO] OpenAI failed, trying Anthropic:', summary?.message || error?.message || error)
      }
    }

    const anthropic = await createAnthropicClient()
    if (anthropic) {
      try {
        const response = await anthropic.messages.create({
          model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
          max_tokens: 1800,
          temperature: 0.1,
          system,
          messages: [{ role: 'user', content: prompt }],
        })
        const raw = extractAnthropicText(response)
        const parsed = raw ? tryExtractFirstJson(raw) : null
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          return res.json({ success: true, output: parsed, ai_provider: 'anthropic' })
        }
      } catch (error) {
        console.warn('[parseNOFO] Anthropic failed:', error?.message || error)
      }
    }

    // No provider available or both failed: return a minimal best-effort object so the UI can proceed.
    // Both AI providers unavailable or failed. Return NO output object so callers
    // cannot accidentally pipe an incomplete record into the pipeline (Goal 1).
    // Include the heuristic data only under a clearly-namespaced key so the UI
    // can display something useful without treating it as a storable grant record.
    return res.status(503).json({
      success: false,
      output: null,
      heuristic_preview: heuristicFallback(clipped),
      ai_provider: 'fallback',
      partial: true,
      warning:
        'AI provider unavailable. Heuristic preview is for display only â it must not be stored or matched without full AI extraction and manual review.',
    })
  } catch (error) {
    console.error('[parseNOFO] Failed:', error)
    const status = Number(error?.status)
    if (Number.isFinite(status) && status >= 400 && status <= 599) {
      return res.status(status).json({
        success: false,
        message:
          status === 403
            ? 'The source site blocked the request (403). Try using a direct PDF URL instead of a webpage.'
            : error?.message || 'Unable to fetch the provided URL',
        error_type: 'nofo_fetch_failed',
      })
    }
    return res.status(500).json({
      success: false,
      message: 'parseNOFO failed',
      error_type: 'nofo_parse_failed',
      details: process.env.NODE_ENV === 'production' ? undefined : (error?.message || String(error)),
    })
  }
})

// POST /api/parseGrantsGovDigest
// Body: { text: string }
router.post('/parseGrantsGovDigest', standardRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    if (!text.trim()) {
      return res.status(400).json({ success: false, message: 'text is required' })
    }

    const parsed = parseGrantsGovDigest(text)
    return res.json({
      success: true,
      opportunities: parsed.opportunities,
      total_urls: parsed.total_urls,
      parse_errors: parsed.parse_errors,
    })
  } catch (error) {
    console.error('[parseGrantsGovDigest] Failed:', error)
    return res.status(500).json({
      success: false,
      message: 'parseGrantsGovDigest failed',
      details: process.env.NODE_ENV === 'production' ? undefined : (error?.message || String(error)),
    })
  }
})

// POST /api/importGrantsGovDigest
// Body: { text: string, organizationId?: string, profileId?: string, minMatchThreshold?: number }
router.post('/importGrantsGovDigest', standardRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const text = typeof req.body?.text === 'string' ? req.body.text : ''
    const organizationId = req.body?.organizationId ?? req.body?.organization_id ?? null
    const profileIdInput = req.body?.profileId ?? req.body?.profile_id ?? null
    const minMatchThreshold = clampPipelineThreshold(
      req.body?.minMatchThreshold ?? req.body?.min_match_threshold ?? RELEVANCE_FLOOR,
    )

    if (!text.trim()) {
      return res.status(400).json({ success: false, message: 'text is required' })
    }

    const resolvedProfileId = await resolveProfileId(req.db, {
      profileId: profileIdInput,
      organizationId,
    })
    if (!resolvedProfileId) {
      return res.status(400).json({
        success: false,
        message: 'Select a profile (or organization linked to a profile) before importing.',
      })
    }

    if (organizationId && !(await ensureOrganizationAccess(req, res, String(organizationId)))) return

    const parsed = parseGrantsGovDigest(text)
    const profileContext = await loadProfileContext(req.db, resolvedProfileId)
    const results = []

    for (const opp of parsed.opportunities) {
      const grantPayload = digestOpportunityToGrantPayload(opp, organizationId)
      const pipelineResult = await saveToProfilePipeline(
        req.db,
        grantPayload,
        resolvedProfileId,
        profileContext,
        null,
        minMatchThreshold,
      )

      let grant = null
      if (pipelineResult.saved && pipelineResult.pipelineId) {
        grant = await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(pipelineResult.pipelineId)
      }

      results.push({
        opportunity_id: opp.opportunity_id,
        title: opp.title,
        saved: pipelineResult.saved,
        reason: pipelineResult.reason ?? null,
        gate: pipelineResult.gate ?? null,
        matchPercentage: pipelineResult.matchPercentage ?? null,
        grant_id: grant?.id ?? pipelineResult.pipelineId ?? null,
      })
    }

    const savedCount = results.filter((row) => row.saved).length
    routeLogger.info('[importGrantsGovDigest] imported digest', {
      profileId: resolvedProfileId,
      total: parsed.opportunities.length,
      saved: savedCount,
    })

    return res.json({
      success: true,
      total_parsed: parsed.opportunities.length,
      total_urls: parsed.total_urls,
      saved_count: savedCount,
      parse_errors: parsed.parse_errors,
      results,
    })
  } catch (error) {
    console.error('[importGrantsGovDigest] Failed:', error)
    return res.status(500).json({
      success: false,
      message: 'importGrantsGovDigest failed',
      details: process.env.NODE_ENV === 'production' ? undefined : (error?.message || String(error)),
    })
  }
})

// POST /api/saveToProfilePipeline
// Body: { opportunity: object, organizationId?: string, profileId?: string, source?: string, minMatchThreshold?: number }
router.post('/saveToProfilePipeline', standardRateLimiter, async (req, res) => {
  try {
    const user = requireAuthenticatedUser(req, res)
    if (!user) return

    const opportunity = req.body?.opportunity
    const organizationId = req.body?.organizationId ?? req.body?.organization_id ?? opportunity?.organization_id ?? null
    const profileIdInput = req.body?.profileId ?? req.body?.profile_id ?? null
    const minMatchThreshold = clampPipelineThreshold(
      req.body?.minMatchThreshold ?? req.body?.min_match_threshold ?? RELEVANCE_FLOOR,
    )

    if (!opportunity || typeof opportunity !== 'object' || Array.isArray(opportunity)) {
      return res.status(400).json({ success: false, message: 'opportunity object is required' })
    }

    const resolvedProfileId = await resolveProfileId(req.db, {
      profileId: profileIdInput,
      organizationId,
    })
    if (!resolvedProfileId) {
      return res.status(400).json({
        success: false,
        message: 'Select a profile (or organization linked to a profile) before saving to the pipeline.',
      })
    }

    if (organizationId && !(await ensureOrganizationAccess(req, res, String(organizationId)))) return

    const normalizedOpportunity = {
      ...opportunity,
      source: opportunity.source || req.body?.source || 'grants.gov',
      record_origin: opportunity.record_origin || 'url_import',
      application_url: opportunity.application_url || opportunity.url || null,
      url: opportunity.url || opportunity.application_url || null,
    }

    const profileContext = await loadProfileContext(req.db, resolvedProfileId)
    const pipelineResult = await saveToProfilePipeline(
      req.db,
      normalizedOpportunity,
      resolvedProfileId,
      profileContext,
      null,
      minMatchThreshold,
    )

    if (!pipelineResult.saved) {
      return res.status(422).json({
        success: false,
        message: pipelineResult.reason || 'Pipeline rejected this opportunity',
        rejection_reason: pipelineResult.reason ?? null,
        gate: pipelineResult.gate ?? null,
        ineligibility_reasons: pipelineResult.ineligibilityReasons ?? [],
        matchPercentage: pipelineResult.matchPercentage ?? null,
        threshold: pipelineResult.threshold ?? null,
      })
    }

    const grant = pipelineResult.pipelineId
      ? await req.db.prepare('SELECT * FROM grants WHERE id = ? LIMIT 1').get(pipelineResult.pipelineId)
      : null

    return res.json({
      success: true,
      grant,
      matchPercentage: pipelineResult.matchPercentage ?? null,
      pipelineId: pipelineResult.pipelineId ?? null,
    })
  } catch (error) {
    console.error('[saveToProfilePipeline] Failed:', error)
    return res.status(500).json({
      success: false,
      message: 'saveToProfilePipeline failed',
      details: process.env.NODE_ENV === 'production' ? undefined : (error?.message || String(error)),
    })
  }
})

export default router
