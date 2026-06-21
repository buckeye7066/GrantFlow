import { buildGrantApplicationApproachPrompt } from '../prompts/grantApplicationApproach.js'
import { createOpenAIClient, summarizeOpenAIError } from '../utils/openaiClient.js'
import { extractCompletionText } from '../utils/openai.js'
import { createLogger } from '../utils/logger.js'
import { buildLanguageDirectiveForProfileAsync } from './languagePreference.js'
const log = createLogger('grantApplicationApproachAdvisor')

function normalizeString(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeUrl(url) {
  const u = normalizeString(url)
  if (!u) return null
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}

function parseContactInfo(raw) {
  if (!raw) return null
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function guessMethodFromSignals({ applicationUrl, portalUrl, description, contact }) {
  const app = (applicationUrl || '').toLowerCase()
  const portal = (portalUrl || '').toLowerCase()
  const text = String(description || '').toLowerCase()

  const hasEmail = Boolean(contact?.email) || /@/.test(text)
  const hasPhone = Boolean(contact?.phone) || /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)

  const looksPortal =
    portal.includes('portal') ||
    app.includes('portal') ||
    app.includes('login') ||
    app.includes('apply') ||
    app.includes('submittable') ||
    app.includes('smartselect') ||
    app.includes('fluxx') ||
    app.includes('survey') ||
    text.includes('portal') ||
    text.includes('log in') ||
    text.includes('login')

  const looksPdfOrPrint =
    app.endsWith('.pdf') ||
    app.includes('.pdf?') ||
    text.includes('print') ||
    text.includes('mail') ||
    text.includes('fax') ||
    text.includes('postmark') ||
    text.includes('paper application')

  if (looksPortal) return 'portal'
  if (looksPdfOrPrint) return 'print_and_mail'
  if (hasEmail && (text.includes('email') || text.includes('submit') || text.includes('send'))) return 'email_contact'
  if (hasPhone && (text.includes('call') || text.includes('phone'))) return 'phone_contact'
  if (applicationUrl) return 'direct_url'
  return 'unknown'
}

async function hasColumn(db, { tableName, columnName }) {
  const dialect = db?.dialect || 'sqlite'
  if (dialect === 'postgres') {
    const row = await db
      .prepare(
        `
          SELECT 1 AS ok
          FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name=?
            AND column_name=?
          LIMIT 1
        `,
      )
      .get(String(tableName), String(columnName))
    return Boolean(row?.ok)
  }

  const safeName = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(tableName)) ? String(tableName) : null
  if (!safeName) throw new Error(`hasColumn: invalid tableName '${String(tableName)}'`)
  const rows = await db.prepare(`PRAGMA table_info(${safeName})`).all()
  return rows.some((r) => String(r?.name || '').toLowerCase() === String(columnName).toLowerCase())
}

async function updateGrantGuidance(db, grantId, payload) {
  // Be resilient during migrations: only update columns that exist.
  const columns = [
    'application_method',
    'application_steps',
    'contact_name',
    'contact_email',
    'contact_phone',
    'portal_url',
    'application_url',
  ]

  const existing = new Set()
  for (const col of columns) {
    try {
      if (await hasColumn(db, { tableName: 'grants', columnName: col })) existing.add(col)
    } catch {
      // ignore
    }
  }

  const updates = []
  const values = []

  const setIf = (col, value) => {
    if (!existing.has(col)) return
    if (value === undefined) return
    updates.push(`${col} = ?`)
    values.push(value)
  }

  setIf('application_method', payload.application_method ?? null)
  setIf('application_steps', payload.application_steps ?? null)
  setIf('contact_name', payload.contact_name ?? null)
  setIf('contact_email', payload.contact_email ?? null)
  setIf('contact_phone', payload.contact_phone ?? null)
  if (payload.portal_url) {
    setIf('portal_url', payload.portal_url)
  } else {
    log.debug('[grant-application-approach] portal_url not set â value was empty or invalid', { grantId })
  }
  if (payload.application_url) {
    setIf('application_url', payload.application_url)
  } else {
    console.warn('[grant-application-approach] application_url not set â grant may lack a valid application path', { grantId })
  }

  if (updates.length === 0) return

  await db
    .prepare(
      `
        UPDATE grants
        SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
    )
    .run(...values, grantId)
}

export async function analyzeAndPersistGrantApplicationApproach({ db, grantId, profileSummary = null }) {
  const grant = await db.prepare('SELECT * FROM grants WHERE id = ?').get(grantId)
  if (!grant) return null

  const opportunity = grant.funding_opportunity_id
    ? await db.prepare('SELECT * FROM funding_opportunities WHERE id = ?').get(grant.funding_opportunity_id)
    : null

  const contact = parseContactInfo(opportunity?.contact_info) ?? null
  const applicationUrl = normalizeUrl(grant.application_url || opportunity?.application_url || opportunity?.source_url || null)
  const portalUrl = normalizeUrl(grant.portal_url || opportunity?.portal_url || null)
  const description = opportunity?.description || grant.notes || null

  const heuristicMethod = guessMethodFromSignals({
    applicationUrl,
    portalUrl,
    description,
    contact,
  })

  const heuristic = {
    application_method: heuristicMethod,
    portal_url: portalUrl,
    application_url: applicationUrl,
    contact_name: contact?.name ?? null,
    contact_email: contact?.email ?? null,
    contact_phone: contact?.phone ?? null,
    application_steps: [
      heuristicMethod === 'portal'
        ? 'Open the portal URL and create/sign in to an account.'
        : heuristicMethod === 'print_and_mail'
        ? 'Open the application URL and download/print the application form.'
        : heuristicMethod === 'email_contact'
        ? 'Email the contact address with a short introduction and request application instructions.'
        : heuristicMethod === 'phone_contact'
        ? 'Call the listed phone number to confirm application steps and deadlines.'
        : heuristicMethod === 'direct_url'
        ? 'Open the application URL and locate the “Apply” / “How to apply” section.'
        : 'Open the sponsor website and locate application instructions.',
      'Confirm eligibility requirements and required documents.',
      'Add key dates and tasks to the pipeline checklist.',
    ].join('\n'),
  }

  // Optional AI refinement (keeps heuristics as baseline).
  let final = { ...heuristic }
  try {
    const { openai } = createOpenAIClient({ allowMissing: true })
    if (openai) {
      const prompt = buildGrantApplicationApproachPrompt({
        grant: {
          id: grant.id,
          title: grant.title,
          funder: grant.funder,
          deadline: grant.deadline,
          application_url: applicationUrl,
          portal_url: portalUrl,
        },
        opportunity: opportunity
          ? {
              title: opportunity.title,
              sponsor: opportunity.sponsor,
              application_url: opportunity.application_url,
              source_url: opportunity.source_url,
              description: opportunity.description,
              contact_info: contact,
            }
          : null,
        profileSummary,
      })

      // The application_steps reach the user, so honour their chosen language.
      const languageDirective = await buildLanguageDirectiveForProfileAsync(db, grant.profile_id)
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `Output JSON only.${languageDirective}` },
          { role: 'user', content: prompt },
        ],
      })

      const text = extractCompletionText(completion) || '{}'
      const parsed = JSON.parse(text)

      const steps = Array.isArray(parsed?.steps) ? parsed.steps.filter(Boolean).slice(0, 10) : []
      const mergedSteps =
        steps.length > 0 ? steps.join('\n') : heuristic.application_steps

      const resolvedAppUrl = normalizeUrl(parsed?.application_url) || heuristic.application_url
    if (!resolvedAppUrl) {
      console.warn('[grant-application-approach] no valid application_url found after AI enrichment; guidance persisted without application path', { grantId })
    }
    final = {
        application_method: parsed?.application_method || heuristic.application_method,
        portal_url: normalizeUrl(parsed?.portal_url) || heuristic.portal_url,
        application_url: resolvedAppUrl ?? null,
        contact_name: parsed?.contact_name || heuristic.contact_name,
        contact_email: parsed?.contact_email || heuristic.contact_email,
        contact_phone: parsed?.contact_phone || heuristic.contact_phone,
        application_steps: mergedSteps,
      }
    }
  } catch (error) {
    const summary = summarizeOpenAIError(error)
    console.warn('[grant-application-approach] AI enrichment failed; using heuristics', {
      grantId,
      message: summary.message,
      status: summary.status,
    })
  }

  await updateGrantGuidance(db, grantId, final)
  return final
}

export function scheduleGrantApplicationApproach({ db, grantId, profileSummary = null }) {
  // Non-blocking: run after response returns.
  setTimeout(() => {
    analyzeAndPersistGrantApplicationApproach({ db, grantId, profileSummary }).catch((error) => {
      console.warn('[grant-application-approach] failed', {
        grantId,
        message: error?.message || String(error),
        stack: error?.stack || null,
      })
    })
  }, 0)
}

