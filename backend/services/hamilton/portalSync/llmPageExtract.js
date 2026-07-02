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
 *   - NEVER fabricates a value. The prompt demands ONLY aid demonstrably
 *     granted/disbursed to the SIGNED-IN USER (never advertised/searchable
 *     scholarship listings), and a deterministic post-filter (partitionAwards)
 *     rejects anything without user-specific evidence or coming from a
 *     search/browse/listing surface — rejections are returned in `rejected`
 *     for human audit.
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
  'CRITICAL: report as "awards" ONLY aid that has demonstrably been GRANTED, AWARDED,',
  'or DISBURSED to THIS signed-in user — evidenced by the user\'s own account context',
  '(an award-status row, "Your awards", a disbursement/credit amount on their account,',
  'an award letter addressed to them).',
  'NEVER report advertised or searchable scholarship LISTINGS, "apply now" cards,',
  'scholarship-match or search results, directories, deadlines pages, or catalog/',
  'marketing entries — those are opportunities someone COULD apply to, not aid this',
  'user has received. A page that merely lists scholarships contains ZERO awards.',
  'Never guess, never fabricate, never infer values that are not written on the page.',
  'If nothing user-specific is present, return empty arrays.',
].join(' ')

/**
 * Shape the model is asked to return. We document it inline so the prompt stays
 * the single source of truth for the contract.
 */
const SCHEMA_INSTRUCTIONS = [
  'Return JSON of exactly this shape:',
  '{',
  '  "awards": [',
  '    { "title": string, "amount": number|null, "status": string|null, "sponsor": string|null, "sourceUrl": string|null, "evidence": string|null }',
  '  ],',
  '  "fields": [',
  '    { "sectionKey": string, "field": string, "value": string|number }',
  '  ]',
  '}',
  '',
  'Award rules (an "award" is aid GRANTED TO THIS USER, never a listing):',
  '- "title" = the scholarship/grant/loan/aid name as written.',
  '- "amount" = the dollar amount as a NUMBER (no $ or commas), or null if not shown.',
  '- "status" = the USER\'s own award status exactly as shown, e.g. "offered","accepted","awarded","disbursed","paid","pending" — NOT a deadline, eligibility note, or "apply" prompt. null only if the page truly shows no status.',
  '- "sponsor" = the awarding institution/organization if shown, else null.',
  '- "sourceUrl" = the page URL where you saw the award (use the provided URL), else null.',
  '- "evidence" = a short verbatim quote (max 200 chars) from the page text that ties this award to the signed-in user (the award-status row, "Your award: $X", a disbursement line). REQUIRED: if you cannot quote user-specific evidence, DO NOT include the award at all.',
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

/**
 * Read the page's visible innerText + document.title, capped, never throwing.
 * The title matters for the fabrication guard: a "Scholarship Search" page is a
 * listing surface whose entries must never be recorded as user awards.
 */
async function readPageSnapshot(page) {
  try {
    const snap = await page.evaluate(() => ({
      text: document.body?.innerText || '',
      title: document.title || '',
    }))
    // Tolerate a legacy/mocked evaluate that returns the bare text string.
    if (typeof snap === 'string') return { text: snap.slice(0, MAX_TEXT_PER_PAGE), title: '' }
    return {
      text: String(snap?.text || '').slice(0, MAX_TEXT_PER_PAGE),
      title: String(snap?.title || '').slice(0, 300),
    }
  } catch {
    return { text: '', title: '' }
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
 * Visit `url`, wait briefly for it to settle, return its visible text + title.
 * Never throws — a navigation failure yields an empty snapshot.
 */
async function visitAndRead(page, url, log) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {})
    return await readPageSnapshot(page)
  } catch (err) {
    log?.(`llmPageExtract: could not read ${url}`, { error: err?.message })
    return { text: '', title: '' }
  }
}

// ── Fabrication guard (deterministic, model-independent) ─────────────────────
// The model prompt already demands user-granted aid only, but a prompt is not a
// guarantee. These filters are the hard backstop that keeps scholarship
// LISTINGS (fastweb/scholly/collegexpress/bold.org-style catalog, search, and
// "apply now" pages) from ever being persisted as if the user was AWARDED them.

// URL paths/queries that mark a search/browse/listing surface, not an account's
// award record. Requires a path/query boundary so e.g. "financial" never
// matches "find".
const LISTING_URL_RE = new RegExp(
  '(/|[?&#])(search|browse|results?|directory|directories|catalog|listings?|list|matches|match-results|find|discover|explore|opportunities)([/?&#._-]|$)'
  + '|[?&](q|query|keyword|keywords|search|term)=',
  'i',
)
// Page titles that mark the same surfaces.
const LISTING_TITLE_RE = /\b(scholarship (search|directory|database|match(es)?|list(ings?)?|finder)|search results?|browse|find (college )?scholarships|matching scholarships|scholarships? (you can|to) apply)\b/i

/** Does this URL/title look like a search/browse/listing surface (non-award page)? */
export function isListingSurface(url, title) {
  const u = String(url || '')
  if (u) {
    try {
      const parsed = new URL(u)
      if (LISTING_URL_RE.test(`${parsed.pathname}?${parsed.search}`)) return true
    } catch {
      if (LISTING_URL_RE.test(u)) return true
    }
  }
  if (title && LISTING_TITLE_RE.test(String(title))) return true
  return false
}

// Statuses that only appear on a signed-in user's own award record — a catalog
// card never says the aid was awarded/accepted/disbursed to you.
const USER_AWARD_STATUS_RE = /\b(award(ed)?|accept(ed)?|disburs(ed|ement)?|paid|grant(ed)?|receiv(ed)?|credit(ed)?|offer(ed)?|pending)\b/i
// Evidence-quote markers that tie an entry to the user's account.
const USER_EVIDENCE_RE = /\b(your (award|aid|account|scholarship)|you (have been|were) awarded|award status|awarded|accepted|disbursed|paid|credited|granted)\b/i

/** Does an extracted award carry user-specific proof it was actually granted? */
function awardHasUserEvidence(a) {
  if (a?.status && USER_AWARD_STATUS_RE.test(String(a.status))) return true
  if (a?.evidence && USER_EVIDENCE_RE.test(String(a.evidence))) return true
  return false
}

/**
 * Deterministic post-filter: partition extracted awards into kept vs rejected.
 * Rejections are RECORDED (title + reason) so a human can audit exactly what the
 * guard threw away — never silently dropped, never silently persisted.
 */
function partitionAwards(awards, pages) {
  const kept = []
  const rejected = []
  const pageByUrl = new Map((pages || []).map((p) => [p.url, p]))
  for (const a of awards || []) {
    const pg = a?.sourceUrl ? pageByUrl.get(a.sourceUrl) : null
    if (isListingSurface(a?.sourceUrl, pg?.title)) {
      rejected.push({
        title: a.title,
        sourceUrl: a?.sourceUrl || null,
        reason: 'listing_surface: page URL/title is a scholarship search/browse/catalog surface, not the user\'s award record',
      })
      continue
    }
    if (!awardHasUserEvidence(a)) {
      rejected.push({
        title: a.title,
        sourceUrl: a?.sourceUrl || null,
        reason: 'no_user_specific_evidence: no user award status (awarded/accepted/disbursed/…) and no account-tied evidence quote — likely an advertised listing, not aid granted to this user',
      })
      continue
    }
    kept.push(a)
  }
  return { kept, rejected }
}

/**
 * Stringify an invokeJsonWithFallback failure WITHOUT losing detail. The
 * provider errors are sometimes objects ({ status, message, … } from
 * summarizeOpenAIError) — naive template interpolation printed
 * "[object Object]" and destroyed the actual failure reason.
 */
function errToText(e) {
  if (e === null || e === undefined || e === '') return null
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  if (typeof e === 'object') {
    const msg = e.message || e.error?.message || null
    if (msg) return e.status ? `${e.status} ${msg}` : String(msg)
    try { return JSON.stringify(e).slice(0, 300) } catch { return Object.prototype.toString.call(e) }
  }
  return String(e)
}

function describeLlmFailure(result) {
  const parts = []
  for (const [label, e] of [
    ['anthropic', result?.anthropicError],
    ['openai', result?.openaiError],
    ['error', result?.error],
  ]) {
    const t = errToText(e)
    if (t) parts.push(`${label}: ${t}`)
  }
  if (result?.raw) parts.push(`raw: ${String(result.raw).slice(0, 200)}`)
  return parts.length ? parts.join('; ') : 'unknown'
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
        evidence: a?.evidence ? String(a.evidence).trim().slice(0, 300) : null,
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
 * @returns {Promise<{ awards:Array, fields:Array, notFound:Array, rejected:Array<{title:string,sourceUrl:string|null,reason:string}>, raw:object }>}
 *   `rejected` is the fabrication-guard audit trail: every extracted item the
 *   deterministic post-filter refused to treat as a user award, with the reason.
 */
export async function extractPortalDataWithLLM(page, opts = {}) {
  const log = opts.log || (() => {})
  const maxPages = Number.isFinite(opts.maxPages) ? opts.maxPages : MAX_PAGES
  const raw = { pagesRead: [], provider: null, attempted: true }

  if (!envFlagOn('PORTAL_SYNC_LLM_EXTRACT', true)) {
    const reason = 'LLM extraction disabled (PORTAL_SYNC_LLM_EXTRACT=false)'
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], rejected: [], raw: { ...raw, attempted: false } }
  }
  if (!anthropicKeyConfigured() && !getOpenAIOptional()) {
    const reason = 'no AI provider configured (ANTHROPIC_API_KEY / OPENAI_API_KEY) — cannot extract portal text'
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], rejected: [], raw: { ...raw, attempted: false } }
  }

  // 1) Gather text from candidate landing pages, the current page, and a few
  //    same-origin aid links — capped at maxPages total.
  const pages = []
  const visited = new Set()
  const pushPage = (url, snap) => {
    if (!snap?.text || !snap.text.trim()) return
    pages.push({ url: url || safeUrl(page), title: snap.title || '', text: snap.text })
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
    pushPage(here, await readPageSnapshot(page))
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
    return { awards: [], fields: [], notFound: [reason], rejected: [], raw }
  }

  // 2) Build a single prompt with per-page URL + title headers so the model can
  //    fill sourceUrl accurately (and the guard can map awards back to pages).
  const corpus = pages
    .map((p, i) => `### PAGE ${i + 1} URL: ${p.url}${p.title ? `\nTITLE: ${p.title}` : ''}\n${p.text}`)
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
    return { awards: [], fields: [], notFound: [reason], rejected: [], raw }
  }

  if (!result?.ok || !result?.json) {
    const reason = `LLM returned no parseable JSON (${describeLlmFailure(result)})`
    log(`llmPageExtract: ${reason}`)
    return { awards: [], fields: [], notFound: [reason], rejected: [], raw }
  }
  raw.provider = result.provider

  const extracted = normalizeExtraction(result.json, safeUrl(page))
  const fields = extracted.fields
  // 4) FABRICATION GUARD: deterministically reject extracted "awards" that lack
  //    user-specific evidence or came from a search/browse/listing surface.
  //    Rejections are returned (and logged) so the run summary shows exactly
  //    what was refused — auditably honest, never silently persisted.
  const { kept: awards, rejected } = partitionAwards(extracted.awards, pages)
  const notFound = []
  if (rejected.length > 0) {
    notFound.push(`fabrication guard rejected ${rejected.length} extracted item(s) lacking user-specific award evidence (listing/marketing entries are not user awards; see rejected list)`)
    log(`llmPageExtract: fabrication guard rejected ${rejected.length} item(s)`, { rejected: rejected.map((r) => r.title) })
  }
  if (awards.length === 0) notFound.push('no financial-aid awards found in the portal text')
  log(`llmPageExtract: ${awards.length} awards (${rejected.length} rejected), ${fields.length} fields from ${pages.length} page(s) via ${result.provider}`)
  return { awards, fields, notFound, rejected, raw }
}

export const _internal = { partitionAwards, awardHasUserEvidence, describeLlmFailure, errToText }

export default { extractPortalDataWithLLM, isListingSurface }
