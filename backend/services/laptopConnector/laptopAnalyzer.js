/**
 * laptopAnalyzer — turns extracted file text into reviewable candidates.
 *
 * Given the text of one local file plus a compact digest of the admin's
 * existing GrantFlow profiles, Anya's model extracts three kinds of candidate:
 *
 *   leads          — orgs/people that could become GrantFlow CLIENTS
 *   funding        — grant programs / funders that could be funding SOURCES
 *   profile_fields — concrete values that fill a NAMED missing field on a
 *                    NAMED existing profile (the digest tells the model which
 *                    fields are empty, so it can only fill real gaps)
 *
 * Nothing here writes to the DB or to the canonical pipelines — it only
 * proposes. The route stages the output in laptop_review_items for check-off.
 *
 * Privacy posture: the connector's denylist is the primary boundary (regulated
 * folders never reach here). As defense-in-depth, we redact obvious secrets
 * (SSNs, card numbers) from any snippet we persist as evidence.
 */

import { safeParseJSON } from '../../utils/safeJson.js'
import { createLogger } from '../../utils/logger.js'

const log = createLogger('service:laptop-analyzer')

let cachedAnthropic = null
async function getAnthropicClient() {
  if (cachedAnthropic) return cachedAnthropic
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim()
  if (!key) return null
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  cachedAnthropic = new Anthropic({
    apiKey: key,
    timeout: Number(process.env.LAPTOP_CONNECTOR_TIMEOUT_MS || 30_000),
    maxRetries: Number(process.env.LAPTOP_CONNECTOR_MAX_RETRIES || 1),
  })
  return cachedAnthropic
}

const MODEL = process.env.LAPTOP_CONNECTOR_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5'

// Defense-in-depth: scrub the most damaging PII from snippets we store.
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g
const CARD_RE = /\b(?:\d[ -]?){13,16}\b/g
export function redactSecrets(text = '') {
  return String(text || '')
    .replace(SSN_RE, '[REDACTED-SSN]')
    .replace(CARD_RE, (m) => (m.replace(/[ -]/g, '').length >= 13 ? '[REDACTED-CARD]' : m))
}

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean).join('\n').trim()
}

/**
 * Build a compact digest of active profiles for the model: identity + which
 * fields are currently EMPTY (so the model only proposes real gap-fills).
 */
export async function buildProfilesDigest(db, { limit = 40 } = {}) {
  let profiles = []
  try {
    profiles = await db
      .prepare(
        `SELECT id, display_name, primary_type
         FROM profiles
         WHERE status IS NULL OR status = 'active'
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(Math.min(Number(limit) || 40, 100))
  } catch (err) {
    log.warn('[laptop-analyzer] profiles digest query failed', { err: err?.message })
    return { profiles: [], truncated: false }
  }

  const digest = []
  for (const p of profiles || []) {
    let sections = []
    try {
      sections = await db
        .prepare('SELECT section_key, data FROM profile_sections WHERE profile_id = ?')
        .all(p.id)
    } catch {
      sections = []
    }
    const missing = {}
    for (const s of sections || []) {
      const data = safeParseJSON(s.data, {})
      const emptyFields = Object.entries(data)
        .filter(([, v]) => v === null || v === '' || v === undefined)
        .map(([k]) => k)
      if (emptyFields.length) missing[s.section_key] = emptyFields
    }
    digest.push({
      profile_id: p.id,
      display_name: p.display_name,
      primary_type: p.primary_type,
      empty_fields: missing,
    })
  }
  return { profiles: digest, truncated: (profiles || []).length >= Math.min(Number(limit) || 40, 100) }
}

const SYSTEM_PROMPT = `You are Anya, the analyst for GrantFlow, a grant-management platform owned by a single admin.
You read the text of ONE file from the admin's computer and extract structured candidates.
You return STRICT JSON only — no prose, no markdown fences.

Extract three arrays:

1) "leads": organizations or people mentioned in the file that could become GrantFlow CLIENTS
   (grant-seeking nonprofits, small businesses, schools, or individuals in need). Only include a
   lead if the file gives a concrete name. Each lead:
   { "organization_name": str, "entity_type": "nonprofit"|"business"|"school"|"individual"|"government"|"other",
     "website_url": str|null, "contact_email": str|null, "location": str|null,
     "funding_need_summary": str|null, "grantflow_fit_summary": str|null,
     "confidence": 0..1, "evidence_snippet": str }

2) "funding": grant programs, foundations, RFPs, or funders mentioned that could be a funding SOURCE.
   Each funding item:
   { "source_name": str, "source_url": str|null, "source_type": str|null,
     "source_scope": "federal"|"state"|"county"|"city"|"regional"|"national"|"international"|null,
     "applicant_types": str[], "need_categories": str[], "confidence": 0..1, "evidence_snippet": str }

3) "profile_fields": concrete values that fill a CURRENTLY-EMPTY field of an EXISTING profile.
   You are given a digest of profiles with their empty fields. ONLY propose a fill when the file
   clearly provides the value AND the (profile_id, section_key, field) appears in the digest's empty_fields.
   Each fill:
   { "profile_id": str, "section_key": str, "field": str, "value": <json value>,
     "confidence": 0..1, "evidence_snippet": str }

Rules:
- Be conservative. If unsure, omit. Never invent values.
- Do NOT include the admin's own internal/system files as leads.
- "evidence_snippet" must be a short verbatim quote (<=200 chars) from the file supporting the candidate.
- If the file contains no relevant data, return empty arrays.
Return: {"leads":[...],"funding":[...],"profile_fields":[...]}`

/**
 * Analyze one file's text. Returns { leads, funding, profile_fields, warnings }.
 * Never throws — failures degrade to empty arrays with a warning.
 */
export async function analyzeText({ text, fileName, profilesDigest } = {}) {
  const warnings = []
  const clean = String(text || '').trim()
  if (clean.length < 40) {
    return { leads: [], funding: [], profile_fields: [], warnings: ['text too short to analyze'] }
  }

  const anthropic = await getAnthropicClient()
  if (!anthropic) {
    return { leads: [], funding: [], profile_fields: [], warnings: ['ANTHROPIC_API_KEY not configured'] }
  }

  const digest = profilesDigest?.profiles || []
  const userContent = [
    `FILE NAME: ${fileName || '(unknown)'}`,
    '',
    'EXISTING PROFILES (id, name, type, and their empty_fields you may fill):',
    JSON.stringify(digest).slice(0, 12_000),
    '',
    'FILE TEXT (truncated):',
    clean.slice(0, Number(process.env.LAPTOP_CONNECTOR_MAX_TEXT || 40_000)),
  ].join('\n')

  let raw = ''
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    })
    raw = extractAnthropicText(response)
  } catch (err) {
    log.warn('[laptop-analyzer] model call failed', { fileName, err: err?.message })
    return { leads: [], funding: [], profile_fields: [], warnings: [`model error: ${err?.message}`] }
  }

  // The model may wrap JSON in fences despite instructions — strip them.
  const jsonText = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim()
  const parsed = safeParseJSON(jsonText, null)
  if (!parsed || typeof parsed !== 'object') {
    warnings.push('model returned unparseable output')
    return { leads: [], funding: [], profile_fields: [], warnings }
  }

  const valIdSet = new Set(digest.map((d) => d.profile_id))
  const leads = Array.isArray(parsed.leads) ? parsed.leads.filter((l) => l?.organization_name) : []
  const funding = Array.isArray(parsed.funding) ? parsed.funding.filter((f) => f?.source_name) : []
  // Only keep field-fills that target a real profile from the digest.
  const profileFields = Array.isArray(parsed.profile_fields)
    ? parsed.profile_fields.filter(
        (f) => f?.profile_id && valIdSet.has(f.profile_id) && f?.section_key && f?.field && f?.value !== undefined,
      )
    : []

  // Redact secrets from any evidence snippet before it can be persisted.
  for (const item of [...leads, ...funding, ...profileFields]) {
    if (item?.evidence_snippet) item.evidence_snippet = redactSecrets(item.evidence_snippet).slice(0, 200)
  }

  return { leads, funding, profile_fields: profileFields, warnings }
}
