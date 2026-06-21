/**
 * portalSync/llmPageExtract.js
 *
 * Selector-INDEPENDENT, GLOBAL portal extraction. Given an already-authenticated
 * Playwright `page`, gather the visible text from the current page plus a few
 * same-origin aid/award/account links, then ask Claude to extract STRUCTURED
 * financial-aid awards and key profile fields from that text.
 *
 * Why this exists: per-portal GUESSED CSS selectors and GUESSED award-page URLs
 * can never work reliably across real portals (Banner/Ellucian/AcademicWorks all
 * differ, and the markup is unknowable from this environment). Reading the
 * page's plain text and letting the model find the awards is robust for MTSU and
 * every future portal. This is the primary extraction path; brittle selectors
 * are at most a low-priority fallback in a connector.
 *
 * Honesty contract (matches the rest of portalSync):
 *   - NEVER fabricates a value. The prompt tells the model to return empty
 *     arrays when nothing is present and to use ONLY text actually on the page.
 *   - NEVER throws. On any failure it returns empty arrays + an honest
 *     `notFound` reason; the orchestrator surfaces that verbatim in the run
 *     summary instead of recording status:'ok' with invented data.
 *   - Reuses the project's canonical AI wrapper (backend/utils/aiProviders.js
 *     invokeJsonWithFallback) — no new key, no new model id.
 */

import { invokeJsonWithFallback, getOpenAIOptional } from '../../../utils/aiProviders.js'

// Same-origin links whose visible text or href hint at financial-aid data are
// worth visiting so the model sees the award package, not just a dashboard.
const AID_LINK_RE = /award|aid|scholarship|financial|account|disburse|offer/i

// Caps keep a sync fast and the prompt within token budget. A missing element
// should fail FAST into an empty result, never hang the whole sync.
const MAX_PAGES = 4
const MAX_TEXT_PER_PAGE = 12_000
const NAV_TIMEOUT_MS = 12_000
const SETTLE_TIMEOUT_MS = 4_000

const SYSTEM = [
  'You extract financial-aid data from the VISIBLE TEXT of a student/financial-aid',
  'portal that the user is already logged into.',
  'You return STRICT JSON only — no markdown, no prose, no code fences.',
  'CRITICAL: include ONLY awards and fields that are ACTUALLY present in the text.',
  'Never guess, never fabricate, never infer values that are not written on the page.',
  'If nothing relevant is present, return empty arrays.',
].join(' ')

/**
 * Shape the model is asked to return. We document it inline so the prompt stays
 * the single source of truth for the contract.
 */
const SCHEMA_INSTRUCTIONS = [
  'Return JSON of exactly this shape:',
  '{',
  '  "awards": [',
  '    { "title": string, "amount": number|null, "status": string|null, "sponsor": string|null, "sourceUrl": string|null }',
  '  ],',
  '  "fields": [',
  '    { "sectionKey": string, "field": string, "value": string|number }',
  '  ]',
  '}',
  '',
  'Award rules:',
  '- "title" = the scholarship/grant/loan/aid name as written.',
  '- "amount" = the dollar amount as a NUMBER (no $ or commas), or null if not shown.',
  '- "status" = e.g. "offered","accepted","disbursed","pending" if shown, else null.',
  '- "sponsor" = the awarding institution/organization if shown, else null.',
  '- "sourceUrl" = the page URL where you saw the award (use the provided URL), else null.',
  '',
  'Field rules (only when the value is explicitly on the page):',
  '- ACT composite score -> { "sectionKey": "education", "field": "act_score", "value": <text> }',
  '- SAT total score      -> { "sectionKey": "education", "field": "sat_score", "value": <text> }',
  'Do NOT emit any field whose value is not literally shown on the page.',
].join('\n')

function envFlagOn(name, defaultOn = true) {
  const raw = process.env[name]
  if (raw === undefined || raw === null || raw === '') return defaultOn
  return String(raw).trim().toLowerCase() !== 'false'
}

function anthropicKeyConfigured() {
  return Boolean(String(process.env.ANTHROPIC_API_KEY || '').trim())
}

function safeUrl(page) {
  try { return page.url() } catch { return null }
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const n = Number(String(value).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n : null
}

/** Read the page's visible innerText, capped, never throwing. */
async function readVisibleText(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '')
    return String(text || '').slice(0, MAX_TEXT_PER_PAGE)
  } catch {
    return ''
  }
}

/**
 * Collect same-origin links whose text/href look aid-related, so we can visit a
 * few of them and read their text too. Best-effort; never throws.
 * @returns {Promise<string[]>} absolute URLs
 */
async function collectAidLinks(page) {
  try {
    const origin = await page.evaluate(() => location.origin)
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((a) => ({
      href: a.href,
      text: (a.textContent || '').trim().slice(0, 120),
    })))
    const seen = new Set()
    const out = []
    for (const { href, text } of links || []) {
      if (!href || !href.startsWith(origin)) continue // same-origin only
      if (!AID_LINK_RE.test(`${text} ${href}`)) continue
      if (seen.has(href)) continue
      seen.add(href)
      out.push(href)
    }
    return out
  } catch {
    return []
  }
}

/**
 * Visit `url`, wait briefly for it to settle, return its visible text. Never
 * throws — a navigation failure yields ''.
 */
async function visitAndRead(page, url, log) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
    return await readVisibleText(page)
  } catch (err) {
    log?.(`llmPageExtract: could not read ${url}`, { error: err?.message })
    return ''
  }
}

/**
 * Defensively coerce the model's JSON into our shape. Anything malformed is
 * dropped rather than trusted.
 */
function normalizeExtraction(json, fallbackUrl) {
  const awards = []
  const fields = []
  if (json && typeof json === 'object') {
    for (const a of Array.isArray(json.awards) ? json.awards : []) {
      const title = String(a?.title || '').trim()
      if (!title) continue
      awards.push({
        title,
        amount: toNumberOrNull(a?.amount),
        amountDisplay: a?.amount !== null && a?.amount !== undefined && typeof a.amount !== 'number' ? String(a.amount) : null,
        status: a?.status ? String(a.status).trim() : null,
        sponsor: a?.sponsor ? String(a.sponsor).trim() : null,
        sourceUrl: a?.sourceUrl ? String(a.sourceUrl) : (fallbackUrl || null),
        source: 'llm_extract',
      })
    }
    for (const f of Array.isArray(json.fields) ? json.fields : []) {
      const sectionKey = String(f?.sectionKey || '').trim()
      const field = String(f?.field || '').trim()
      if (!sectionKey || !field) continue
      if (f?.value === undefined || f?.value === null || String(f.value).trim() === '') continue
      fields.push({ sectionKey, field, value: f.value, source: 'llm_extract' })
    }
  }
  return { awards, fields }
}

/**
 * Extract structured awards + fields from an authenticated portal page using the
 * project's Claude wrapper. Selector-independent and global.
 *
 * @param {import('playwright').Page} page  an authenticated page.
 * @param {object} [opts]
 * @param {(msg:string, detail?:object)=>void} [opts.log]
 * @param {string[]} [opts.navCandidates]  extra URLs to try reading first (e.g.
 *   a connector's known authenticated landing pages). Best-effort.
 * @param {number} [opts.maxPages]
 * @returns {Promise<{ awards:Array, fields:Array, notFound:Array, raw:object }>}
 */
export async function extractPortalDataWithLLM(page, opts = {}) {
  const log = opts.log || (() => {})
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : MAX_PAGES
  const raw = { pagesRead: [], provider: null, attempted: true }

  if (!envFlagOn('PORTAL_SYNC_LLM_EXTRACT', true)) {
    const reason = 'LLM extraction disabled (PORTAL_SYNC_LLM_EXTRACT=false)'
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], raw: { ...raw, attempted: false } }
  }
  if (!anthropicKeyConfigured() && !getOpenAIOptional()) {
    const reason = 'no AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY) — cannot extract portal text'
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], raw: { ...raw, attempted: false } }
  }

  // 1) Gather text from candidate landing pages, the current page, and a few
  //    same-origin aid links — capped at maxPages total.
  const pages = []
  const visited = new Set()
  const pushPage = (url, text) => {
    if (!text || !text.trim()) return
    pages.push({ url: url || safeUrl(page), text })
    raw.pagesRead.push(url || safeUrl(page))
  }

  for (const url of Array.isArray(opts.navCandidates) ? opts.navCandidates : []) {
    if (pages.length >= maxPages) break
    if (!url || visited.has(url)) continue
    visited.add(url)
    pushPage(url, await visitAndRead(page, url, log))
  }

  // Current page (after nav attempts) — always include if it has text.
  if (pages.length < maxPages) {
    const here = safeUrl(page)
    if (here && !visited.has(here)) visited.add(here)
    pushPage(here, await readVisibleText(page))
  }

  // A few same-origin aid links from wherever we landed.
  if (pages.length < maxPages) {
    for (const url of await collectAidLinks(page)) {
      if (pages.length >= maxPages) break
      if (visited.has(url)) continue
      visited.add(url)
      pushPage(url, await visitAndRead(page, url, log))
    }
  }

  if (pages.length === 0) {
    const reason = 'no readable text found on the authenticated portal pages'
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], raw }
  }

  // 2) Build a single prompt with per-page URL headers so the model can fill
  //    sourceUrl accurately.
  const corpus = pages
    .map((p, i) => `### PAGE ${i + 1} URL: ${p.url}\n${p.text}`)
    .join('\n\n')
  const prompt = `${SCHEMA_INSTRUCTIONS}\n\nPORTAL TEXT (extract ONLY what is present below):\n\n${corpus}`

  // 3) Call the canonical wrapper (OpenAI preferred when present, else Anthropic).
  let result
  try {
    result = await invokeJsonWithFallback({
      openai: getOpenAIOptional(),
      system: SYSTEM,
      prompt,
      temperature: 0,
      maxTokens: 1500,
    })
  } catch (err) {
    const reason = `LLM extraction call failed: ${err?.message || err}`
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], raw }
  }

  if (!result?.ok || !result?.json) {
    const reason = `LLM returned no parseable JSON (${result?.anthropicError || result?.openaiError || result?.error?.message || 'unknown'})`
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], raw }
  }
  raw.provider = result.provider

  const { awards, fields } = normalizeExtraction(result.json, safeUrl(page))
  const notFound = []
  if (awards.length === 0) notFound.push('no financial-aid awards found in the portal text')
  log(`llmPageExtract: ${awards.length} awards, ${fields.length} fields from ${pages.length} page(s) via ${result.provider}`)
  return { awards, fields, notFound, raw }
}

export default { extractPortalDataWithLLM }
