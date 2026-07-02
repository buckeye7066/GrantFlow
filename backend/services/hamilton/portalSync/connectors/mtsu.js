/**
 * portalSync/connectors/mtsu.js
 *
 * REAL connector for Middle Tennessee State University's student / financial-aid
 * portals (PipelineMT / MyMT, and the AcademicWorks scholarship portal MTSU
 * uses). Driven with an already-authenticated Playwright page.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EXTRACTION STRATEGY (why this is selector-INDEPENDENT)
 * ───────────────────────────────────────────────────────────────────────────
 * The exact DOM of a live, authenticated MTSU portal CANNOT be verified from
 * this environment, and Banner/Ellucian/AcademicWorks markup differs widely. So
 * the PRIMARY read path navigates the authenticated landing + known MTSU hosts
 * and delegates extraction to the shared, model-driven `extractPortalDataWithLLM`
 * (llmPageExtract.js) — it reads the page's visible text and lets Claude pull
 * out awards + fields. This is robust where guessed CSS selectors never were.
 *
 * The legacy label/table selectors remain ONLY as a low-priority fallback for
 * fields the LLM didn't return (and only when LLM extraction was actually
 * attempted but came back empty). Nothing here fabricates a value or claims a
 * write that didn't land; missing items are reported in `notFound`.
 */

import { normalizeHost } from '../../hamiltonCredentialSessionService.js'
import { extractPortalDataWithLLM } from '../llmPageExtract.js'

export const id = 'mtsu'
export const label = 'Middle Tennessee State University (PipelineMT / AcademicWorks)'
// Matches mtsu.edu and its portal subdomains (pipeline.mtsu.edu, mymt, the
// AcademicWorks tenant mtsu.academicworks.com).
export const hostMatch = /(^|\.)mtsu\.edu$|mtsu\.academicworks\.com$/i

// MTSU federates auth through Microsoft (login.microsoftonline.com) with 2FA, so
// a saved username/password alone CANNOT authenticate a headless sync — the sync
// must reuse a captured login session (durable Playwright storageState from the
// side-by-side login). requiresSession=true makes runPortalSync fail honestly
// ("needs a captured session") instead of running an unauthenticated, misleading
// "completed, 0 awards" pass. See portalSync/index.js.
export const requiresSession = true

// How long any single page interaction waits before we treat the element as
// absent. Short on purpose: a missing selector should fail FAST into `notFound`,
// not hang the whole sync.
const FIND_TIMEOUT_MS = 4000

// ── Assumed navigation targets (ASSUMPTION) ────────────────────────────────
// Authenticated landing pages for each data class. These are best-effort guesses
// at MTSU's portal structure; if navigation 404s/redirects we simply read
// whatever the current page exposes and report notFound for the rest.
const NAV = {
  // PipelineMT financial-aid award package (Banner Self-Service "Award by Year").
  awards: ['https://pipelinemt.mtsu.edu/', 'https://mtsu.edu/financial-aid/'],
  // Test scores typically live in the admissions / academic record area.
  scores: ['https://pipelinemt.mtsu.edu/'],
  // Application status (admissions decision / aid application status).
  status: ['https://pipelinemt.mtsu.edu/'],
}

// Label anchors we search for (case-insensitive substring) to locate values by
// their on-screen label rather than a brittle absolute selector. ASSUMPTION —
// used only as a low-priority fallback when LLM extraction returns nothing.
// Keyed by the canonical `education` section field the value writes into.
const SCORE_LABELS = {
  act_score: ['ACT Composite', 'ACT Score', 'Composite ACT'],
  sat_score: ['SAT Total', 'SAT Score', 'SAT Composite', 'Total SAT'],
}
const AWARD_TABLE_SELECTORS = [
  'table[summary*="award" i]',
  'table[id*="award" i]',
  'table[class*="award" i]',
  '.award-summary table',
  'table', // last-resort: scan every table and keep rows that look like awards
]
function num(v) {
  if (v === null || v === undefined) return null
  const n = Number(String(v).replace(/[^0-9.]/g, ''))
  return Number.isFinite(n) ? n : null
}
function money(v) {
  const n = num(v)
  return n !== null && n > 0 ? n : null
}

async function gotoFirst(page, urls, log) {
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      log?.(`navigated to ${url}`)
      return true
    } catch (err) {
      log?.(`navigation failed: ${url}`, { error: err?.message })
    }
  }
  return false
}

/**
 * Find a value on the page by an on-screen LABEL: look for an element whose text
 * contains the label, then read the nearest following sibling / cell / input.
 * Returns the trimmed string or null. Best-effort, never throws.
 */
async function readByLabel(page, labels) {
  for (const label of labels) {
    try {
      const value = await page.evaluate((lbl) => {
        const want = lbl.toLowerCase()
        const els = Array.from(document.querySelectorAll('th,td,label,span,dt,div,strong,b'))
        for (const el of els) {
          const t = (el.textContent || '').trim()
          if (!t || t.length > 80) continue
          if (!t.toLowerCase().includes(want)) continue
          // value is commonly the next cell (td after th), the dd after dt, a
          // following sibling, or an input the label points at.
          const candidates = []
          if (el.nextElementSibling) candidates.push(el.nextElementSibling.textContent)
          if (el.parentElement) {
            const sib = el.parentElement.querySelector('td:last-child, dd, .value, input')
            if (sib) candidates.push(sib.value || sib.textContent)
          }
          for (const c of candidates) {
            const v = (c || '').trim()
            // keep only a short value that isn't just the label repeated
            if (v && v.toLowerCase() !== want && v.length <= 60) return v
          }
        }
        return null
      }, label)
      if (value) return { value, label }
    } catch { /* try next label */ }
  }
  return null
}

// Canonical `education` field name -> value coercion used when we fall back to
// brittle label lookups. Scores are stored as text per sectionMetadata.
const SCORE_FIELD_SECTION = 'education'

/**
 * READ: financial-aid awards + key fields (ACT/SAT scores).
 *
 * PRIMARY path: navigate the authenticated landing + known MTSU hosts, then
 * delegate to the shared model-driven extractor (selector-independent). The
 * legacy label/table selectors run ONLY as a fallback for items the LLM didn't
 * surface. Returns { fields, awards, notFound, raw }; every missing item is
 * reported in notFound — we never claim a value we didn't actually read.
 */
export async function read(page, ctx = {}) {
  const log = ctx.log || (() => {})
  const fields = []
  const awards = []
  const notFound = []
  const raw = { llm: null, fallback: { scores: {}, awards: [] }, navigated: false }

  // Navigate to the authenticated landing / known MTSU hosts so the extractor
  // starts from a useful page. We do NOT depend on these succeeding — the
  // extractor also reads same-origin aid links from wherever we land.
  const navCandidates = [...new Set([...NAV.awards, ...NAV.scores, ...NAV.status])]
  const landed = await gotoFirst(page, navCandidates, log)
  raw.navigated = landed

  // ── PRIMARY: model-driven, selector-independent extraction ─────────────────
  const llm = await extractPortalDataWithLLM(page, { log, navCandidates })
  raw.llm = llm.raw
  // Fabrication-guard audit trail (items the extractor refused to treat as user
  // awards) — surfaced in the run summary for human review.
  const rejected = Array.isArray(llm.rejected) ? llm.rejected : []
  const seenAwardKeys = new Set()
  for (const a of llm.awards || []) {
    awards.push({
      title: a.title,
      amount: a.amount,
      amountDisplay: a.amountDisplay || null,
      status: a.status || null,
      sponsor: a.sponsor || 'Middle Tennessee State University',
      sourceUrl: a.sourceUrl || safeUrl(page),
    })
    seenAwardKeys.add(String(a.title).trim().toLowerCase())
  }
  const seenFieldKeys = new Set()
  for (const f of llm.fields || []) {
    fields.push(f)
    seenFieldKeys.add(`${f.sectionKey}.${f.field}`)
  }
  for (const reason of llm.notFound || []) notFound.push({ kind: 'llm', name: 'extraction', reason })

  // ── FALLBACK: legacy label lookups for scores the model did NOT return ──────
  for (const [field, labels] of Object.entries(SCORE_LABELS)) {
    if (seenFieldKeys.has(`${SCORE_FIELD_SECTION}.${field}`)) continue
    const hit = await readByLabel(page, labels)
    const n = num(hit?.value)
    if (n !== null) {
      // education.act_score / education.sat_score are TEXT per sectionMetadata.
      fields.push({ sectionKey: SCORE_FIELD_SECTION, field, value: String(n), label: hit.label, source: 'label_lookup' })
      raw.fallback.scores[field] = n
    }
  }

  // ── FALLBACK: legacy award-table scrape when the model found NO awards ──────
  if (awards.length === 0) {
    for (const sel of AWARD_TABLE_SELECTORS) {
      let rows = []
      try {
        rows = await page.$$eval(sel, (tables) => {
          const out = []
          for (const table of tables) {
            for (const tr of Array.from(table.querySelectorAll('tr'))) {
              const cells = Array.from(tr.querySelectorAll('td')).map((c) => (c.textContent || '').trim())
              if (cells.length < 2) continue
              const amountCell = cells.find((c) => /\$|\d{3,}/.test(c) && /\d/.test(c))
              const nameCell = cells.find((c) => /[a-zA-Z]{4,}/.test(c) && !/\$/.test(c))
              if (amountCell && nameCell) out.push({ name: nameCell, amount: amountCell })
            }
          }
          return out
        })
      } catch (err) {
        log(`award table selector failed: ${sel}`, { error: err?.message })
        continue
      }
      if (rows && rows.length) {
        for (const r of rows) {
          const key = String(r.name).trim().toLowerCase()
          if (seenAwardKeys.has(key)) continue
          seenAwardKeys.add(key)
          awards.push({
            title: r.name,
            amount: money(r.amount),
            amountDisplay: r.amount,
            status: null,
            sponsor: 'Middle Tennessee State University',
            sourceUrl: safeUrl(page),
          })
          raw.fallback.awards.push(r)
        }
        break // first selector that yields award-shaped rows wins
      }
    }
  }

  if (awards.length === 0 && !notFound.some((n) => n.kind === 'llm')) {
    notFound.push({ kind: 'award', name: 'financial_aid_awards', reason: 'no awards found by model extraction or label/table fallback' })
  }

  // NOTE: we intentionally do NOT emit an `application_status` profile field.
  // The `university_applications` section schema only accepts `applications` and
  // `school_portal_imports` (both JSON), so a scalar `application_status` would
  // be rejected by the section guard and silently dropped. Award status is
  // captured per-award above instead.

  log(`MTSU read complete: ${fields.length} fields, ${awards.length} awards (${rejected.length} rejected by fabrication guard), ${notFound.length} notFound`)
  return { fields, awards, notFound, rejected, raw }
}

/**
 * WRITE: push GrantFlow funding sources / awards INTO MTSU's portal where a form
 * accepts them. In practice MTSU's aid portal exposes very few writable fields
 * to a student (most aid data is read-only / institution-controlled), and
 * AcademicWorks "additional funding" reporting forms vary by tenant. So this is
 * deliberately conservative: it attempts ONE realistic write — reporting
 * external/outside scholarships on the "Report Outside Scholarship" form if one
 * is present — and SKIPS everything it can't safely fill, with a reason.
 *
 * @param {object} data  { fundingSources?: Array<{name, amount, sponsor?}> }
 */
export async function write(page, ctx = {}, data = {}) {
  const log = ctx.log || (() => {})
  const written = []
  const skipped = []
  const sources = Array.isArray(data?.fundingSources) ? data.fundingSources : []

  if (sources.length === 0) {
    skipped.push({ target: 'outside_scholarships', reason: 'no GrantFlow funding sources to push' })
    return { written, skipped }
  }

  // ASSUMPTION: an "outside / additional scholarship reporting" form exists and
  // is reachable. We look for a link to it, then for name + amount inputs. If any
  // step fails we SKIP (never pretend success).
  let onForm = false
  try {
    // Try to reach a reporting form by its link text (assumption).
    const link = await page.getByRole('link', { name: /outside scholarship|report.*scholarship|additional funding/i }).first()
    if (await link.isVisible({ timeout: FIND_TIMEOUT_MS }).catch(() => false)) {
      await link.click({ timeout: FIND_TIMEOUT_MS }).catch(() => {})
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
      onForm = true
    }
  } catch { onForm = false }

  if (!onForm) {
    skipped.push({ target: 'outside_scholarships', reason: 'no outside-scholarship reporting form found (selectors are assumptions; confirm MTSU/AcademicWorks markup)' })
    return { written, skipped }
  }

  for (const src of sources) {
    const name = String(src?.name || src?.title || '').trim()
    const amount = money(src?.amount)
    if (!name) { skipped.push({ target: 'scholarship', reason: 'funding source has no name' }); continue }

    // ASSUMPTION: form has name + amount inputs locatable by label/placeholder.
    const nameInput = page.getByLabel(/scholarship name|award name|source/i).first()
    const amountInput = page.getByLabel(/amount|award amount|value/i).first()
    const nameOk = await nameInput.isVisible({ timeout: FIND_TIMEOUT_MS }).catch(() => false)
    if (!nameOk) {
      skipped.push({ target: name, reason: 'scholarship-name input not found on form' })
      continue
    }
    try {
      await nameInput.fill(name, { timeout: FIND_TIMEOUT_MS })
      if (amount !== null && await amountInput.isVisible({ timeout: FIND_TIMEOUT_MS }).catch(() => false)) {
        await amountInput.fill(String(amount), { timeout: FIND_TIMEOUT_MS })
      }
      // We DO NOT auto-submit here: submission is a state-changing action that
      // belongs to the autopilot's authorized-submit path, not a sync. We fill
      // and report it as written-to-form (staged), leaving submit to the
      // operator/autopilot. Honest label: 'filled (not submitted)'.
      written.push({ target: name, value: amount !== null ? `$${amount} (filled, not submitted)` : 'filled, not submitted' })
      log(`MTSU write: staged outside scholarship "${name}"`)
    } catch (err) {
      skipped.push({ target: name, reason: `fill failed: ${err?.message || err}` })
    }
  }

  return { written, skipped }
}

function safeUrl(page) {
  try { return page.url() } catch { return null }
}

// Email/username domains and label hints that identify an MTSU account even when
// the saved login lives under a shared IdP host (MTSU federates through Microsoft
// — accounts log in at login.microsoftonline.com as <user>@mtmail.mtsu.edu).
const MTSU_ACCOUNT_DOMAINS = /@(mtmail\.)?mtsu\.edu$/i
const MTSU_IDP_HOSTS = /(^|\.)(login\.microsoftonline\.com|login\.microsoft\.com|microsoftonline\.com|office\.com)$/i

/**
 * Claim a saved credential as MTSU's. True when the host is an MTSU host, OR the
 * credential is a shared-IdP login (Microsoft) whose username/label points at an
 * MTSU account. Lets an MTSU login stored under login.microsoftonline.com route
 * to this connector instead of the generic one.
 * @param {{ host?:string, username?:string, label?:string }} ctx
 */
export function matchesCredential({ host, username = null, label = null } = {}) {
  const h = normalizeHost(host)
  if (h && hostMatch.test(h)) return true
  const hay = `${username || ''} ${label || ''}`
  if (MTSU_ACCOUNT_DOMAINS.test(String(username || ''))) return true
  if (/\bmtsu\b|middle tennessee state/i.test(hay)) return true
  if (h && MTSU_IDP_HOSTS.test(h) && /mtsu/i.test(hay)) return true
  return false
}

/** @type {import('../types.js').PortalConnector} */
const connector = { id, label, hostMatch, requiresSession, matchesCredential, read, write }

// Convenience: does this connector claim the given host?
export function matchesHost(host) {
  const h = normalizeHost(host)
  return !!h && hostMatch.test(h)
}

export default connector
