/**
 * thresholdAnalyzer.js — "almost qualified" awareness.
 *
 * Owner rule (2026-07-03): GrantFlow must tell each user what they DO qualify
 * for, what they ALMOST qualify for, exactly what closes the gap (e.g. "needs
 * ACT 29 — you have 28"), and link them to where to act. The motivating case:
 * MTSU's Honors Centennial wants a 29 ACT; Anastasia has a 28 — that near-miss
 * (and the "retake by Dec 1" move that fixes it) must be visible in the
 * profile, not discovered by a human reading scholarship pages.
 *
 * DETERMINISTIC BY DESIGN: this parses explicit numeric thresholds (ACT / SAT /
 * GPA / income cap / age) out of the opportunity text GrantFlow already has
 * (grants.eligibility_summary / program_description / selection_criteria +
 * linked funding_opportunities.description / eligibility_bullets /
 * eligibility_json) and compares them to the profile's own recorded facts.
 * A threshold that isn't stated in the text, or a fact the profile doesn't
 * have, is reported as UNKNOWN — never guessed (no-fabrication rule).
 *
 * Consumers:
 *   - /api/ai/threshold-report (profile card / Anya)
 *   - the Profile Action Plan merges buildThresholdTodoCategory() as a live
 *     "Threshold watch" category (same pattern as the Hamilton category)
 *   - Anya chat tool profile.thresholdReport
 */

import { createLogger } from '../../utils/logger.js'

const log = createLogger('thresholdAnalyzer')

// ── requirement extraction ───────────────────────────────────────────

function toNumber(value) {
  if (value === null || value === undefined) return null
  const cleaned = String(value).replace(/[$,\s]/g, '')
  // An empty field is a MISSING fact, not zero — Number('') === 0 silently
  // turned a blank sat_score into "SAT 0", flunking every SAT-gated award as
  // "short" instead of the honest "unknown" (caught in prod on 2026-07-03).
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Pull explicit numeric requirements out of free text. Conservative: only
 * unambiguous phrasings count, and values must be in-range for their kind
 * (an "ACT" match of 85 is noise, not a requirement).
 * @returns {Array<{kind:string, value:number, raw:string}>}
 */
export function extractThresholds(text) {
  const t = String(text || '')
  if (!t) return []
  const found = []
  const push = (kind, value, raw, min, max) => {
    const n = toNumber(value)
    if (n === null || n < min || n > max) return
    found.push({ kind, value: n, raw: String(raw).trim().slice(0, 120) })
  }

  // ACT: "29 ACT", "ACT of 29", "minimum ACT score: 29", "ACT 29+"
  for (const m of t.matchAll(/\b(\d{2})\s*(?:\+\s*)?ACT\b/gi)) push('act', m[1], m[0], 10, 36)
  for (const m of t.matchAll(/\bACT(?:\s+(?:composite|score))?(?:\s+of)?(?:\s+at\s+least)?\s*[:\-–]?\s*(\d{2})\b/gi)) push('act', m[1], m[0], 10, 36)

  // SAT: "SAT 1330", "1330 SAT", "SAT of 1330+"
  for (const m of t.matchAll(/\b(\d{3,4})\s*(?:\+\s*)?SAT\b/gi)) push('sat', m[1], m[0], 400, 1600)
  for (const m of t.matchAll(/\bSAT(?:\s+(?:total|score))?(?:\s+of)?(?:\s+at\s+least)?\s*[:\-–]?\s*(\d{3,4})\b/gi)) push('sat', m[1], m[0], 400, 1600)

  // GPA: "3.5 GPA", "GPA of 3.5", "minimum GPA: 3.50", "3.5 or higher GPA",
  // "3.5 high school GPA", "3.25 cumulative GPA"
  const GPA_FILLER = '(?:high\\s+school\\s+|cumulative\\s+|college\\s+|weighted\\s+|unweighted\\s+|overall\\s+|minimum\\s+)?'
  for (const m of t.matchAll(new RegExp(`\\b([0-4](?:\\.\\d{1,2})?)\\s*(?:\\+|or\\s+(?:higher|better|above))?\\s*${GPA_FILLER}GPA\\b`, 'gi'))) {
    push('gpa', m[1], m[0], 1, 4)
  }
  for (const m of t.matchAll(/\bGPA(?:\s+of)?(?:\s+at\s+least)?\s*[:\-–]?\s*([0-4](?:\.\d{1,2})?)\b/gi)) push('gpa', m[1], m[0], 1, 4)

  // Income cap: "income below $30,000", "household income under $25,000",
  // "AGI must not exceed $36,000", "income at or below $45,000"
  const INCOME_CMP = '(?:must\\s+)?(?:be\\s+)?(?:below|under|less\\s+than|at\\s+or\\s+below|not\\s+(?:to\\s+)?exceed(?:ing)?|no\\s+more\\s+than|≤|<=?)'
  for (const m of t.matchAll(new RegExp(`\\b(?:household\\s+|family\\s+|adjusted\\s+gross\\s+)?income\\s+(?:of\\s+)?${INCOME_CMP}\\s*\\$?\\s*([\\d][\\d,]{2,})\\b`, 'gi'))) {
    push('income_max', m[1], m[0], 1000, 10_000_000)
  }
  for (const m of t.matchAll(new RegExp(`\\bAGI\\s+${INCOME_CMP}\\s*\\$?\\s*([\\d][\\d,]{2,})\\b`, 'gi'))) {
    push('income_max', m[1], m[0], 1000, 10_000_000)
  }

  // Age: "at least 18 years old", "ages 16-24", "must be 21+"
  for (const m of t.matchAll(/\bat\s+least\s+(\d{1,2})\s+years?\s+old\b/gi)) push('age_min', m[1], m[0], 5, 99)
  for (const m of t.matchAll(/\bmust\s+be\s+(\d{1,2})\s*\+/gi)) push('age_min', m[1], m[0], 5, 99)
  for (const m of t.matchAll(/\bages?\s+(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/gi)) {
    push('age_min', m[1], m[0], 5, 99)
    push('age_max', m[2], m[0], 5, 99)
  }

  // Collapse duplicates per kind: the BINDING requirement is the strictest
  // (max for score floors / age_min, min for caps / age_max).
  const byKind = new Map()
  for (const r of found) {
    const cur = byKind.get(r.kind)
    const stricter = !cur
      || ((r.kind === 'income_max' || r.kind === 'age_max') ? r.value < cur.value : r.value > cur.value)
    if (stricter) byKind.set(r.kind, r)
  }
  return Array.from(byKind.values())
}

// ── profile facts ────────────────────────────────────────────────────

function parseSafe(v, fb = {}) {
  try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fb) } catch { return fb }
}

/**
 * Read the profile's comparable facts from profile_sections (education +
 * financial sections; denormalized columns are legacy and not present on prod).
 * Missing facts stay null — an unknown is reported, never guessed.
 * @returns {Promise<{act, sat, gpa, income, age}>}
 */
export async function extractProfileFacts(db, profileId) {
  const facts = { act: null, sat: null, gpa: null, income: null, age: null }
  let rows = []
  try {
    rows = await db
      .prepare(`SELECT section_key, data FROM profile_sections WHERE profile_id = ?`)
      .all(String(profileId))
  } catch { rows = [] }

  for (const row of rows || []) {
    const key = String(row.section_key || '').toLowerCase()
    const d = parseSafe(row.data)
    if (key === 'education') {
      facts.act = facts.act ?? toNumber(d.act_score)
      facts.sat = facts.sat ?? toNumber(d.sat_score)
      facts.gpa = facts.gpa ?? toNumber(d.gpa) ?? toNumber(d.high_school_gpa)
    }
    if (key === 'financial' || key === 'financial_information') {
      facts.income = facts.income ?? toNumber(d.household_income)
    }
    if (key === 'basic_information' || key === 'demographics') {
      const dob = d.date_of_birth || d.dob || d.birth_date
      if (facts.age === null && dob) {
        const born = new Date(dob)
        if (!Number.isNaN(born.getTime())) {
          facts.age = Math.floor((Date.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000))
        }
      }
      facts.age = facts.age ?? toNumber(d.age)
    }
  }
  return facts
}

// ── classification ───────────────────────────────────────────────────

// "Near" = realistically crossable: one retake, one better semester, a small
// income delta. Anything further is an honest "short", not a tease.
const NEAR_MARGIN = { act: 3, sat: 160, gpa: 0.4, age_min: 2, age_max: 2 }
const FACT_FOR_KIND = { act: 'act', sat: 'sat', gpa: 'gpa', income_max: 'income', age_min: 'age', age_max: 'age' }
const KIND_LABEL = {
  act: 'ACT', sat: 'SAT', gpa: 'GPA',
  income_max: 'household income cap', age_min: 'minimum age', age_max: 'maximum age',
}

/** @returns {'meets'|'near'|'short'|'unknown'} */
export function classifyRequirement(req, facts) {
  const have = facts?.[FACT_FOR_KIND[req.kind]]
  if (have === null || have === undefined) return 'unknown'
  switch (req.kind) {
    case 'act':
    case 'sat':
    case 'gpa': {
      if (have >= req.value) return 'meets'
      return req.value - have <= NEAR_MARGIN[req.kind] ? 'near' : 'short'
    }
    case 'income_max': {
      if (have <= req.value) return 'meets'
      return have <= req.value * 1.25 ? 'near' : 'short'
    }
    case 'age_min': {
      if (have >= req.value) return 'meets'
      return req.value - have <= NEAR_MARGIN.age_min ? 'near' : 'short'
    }
    case 'age_max': {
      if (have <= req.value) return 'meets'
      return have - req.value <= NEAR_MARGIN.age_max ? 'near' : 'short'
    }
    default:
      return 'unknown'
  }
}

function crossingAdvice(req, have) {
  switch (req.kind) {
    case 'act':
      return `This source asks for an ACT of ${req.value}; the profile shows ${have}. A retake that reaches ${req.value} opens it — most schools count scores on file by December 1 of senior year, and state merit supplements often use the same bar. Update the profile's ACT score when the new result arrives and GrantFlow re-checks automatically.`
    case 'sat':
      return `This source asks for an SAT of ${req.value}; the profile shows ${have}. A retake reaching ${req.value} opens it (some ACT-based awards also accept a concordant SAT — confirm with the sponsor). Update the profile's SAT score when the new result arrives.`
    case 'gpa':
      return `This source asks for a GPA of ${req.value}; the profile shows ${have}. If upcoming grades lift the GPA to ${req.value}, this opens — update the profile GPA when transcripts post.`
    case 'income_max':
      return `This source caps household income at $${req.value.toLocaleString()}; the profile shows $${Number(have).toLocaleString()}. If the profile's income figure is out of date or overstated (gross vs adjusted), correcting it may qualify you — otherwise this one stays out of reach.`
    case 'age_min':
      return `This source requires age ${req.value}+; the profile shows ${have}. It opens automatically at ${req.value} — keep it on the watch list.`
    case 'age_max':
      return `This source is limited to age ${req.value} and under; the profile shows ${have}. Apply before aging out, or look for the sponsor's adult-track equivalent.`
    default:
      return ''
  }
}

// ── report ───────────────────────────────────────────────────────────

const TERMINAL_GRANT_STATUSES = new Set(['declined', 'declined_no_review', 'closed'])

function requirementText(grant, opp) {
  const parts = [
    grant?.title, grant?.eligibility_summary, grant?.program_description, grant?.selection_criteria,
    opp?.title, opp?.description,
  ]
  const bullets = parseSafe(opp?.eligibility_bullets, null)
  if (Array.isArray(bullets)) parts.push(bullets.join('\n'))
  else if (opp?.eligibility_bullets) parts.push(String(opp.eligibility_bullets))
  const eligJson = parseSafe(opp?.eligibility_json, null)
  if (eligJson) parts.push(JSON.stringify(eligJson))
  return parts.filter(Boolean).join('\n')
}

/**
 * Analyze every non-terminal pipeline source for this profile against its
 * recorded facts.
 * @returns {Promise<{facts, qualified:Array, near:Array, short:Array, no_explicit_thresholds:number, analyzed:number}>}
 */
export async function buildThresholdReport(db, profileId) {
  const facts = await extractProfileFacts(db, profileId)

  let grants = []
  try {
    grants = await db
      .prepare(`
        SELECT id, title, status, url, application_url, funding_opportunity_id,
               eligibility_summary, program_description, selection_criteria
        FROM grants WHERE profile_id = ?
      `)
      .all(String(profileId))
  } catch { grants = [] }
  grants = (grants || []).filter((g) => !TERMINAL_GRANT_STATUSES.has(String(g.status || '').toLowerCase()))

  const oppIds = [...new Set(grants.map((g) => g.funding_opportunity_id).filter(Boolean).map(String))]
  const oppById = new Map()
  if (oppIds.length) {
    try {
      const ph = oppIds.map(() => '?').join(',')
      const rows = await db
        .prepare(`SELECT id, title, description, eligibility_bullets, eligibility_json, application_url, url FROM funding_opportunities WHERE id IN (${ph})`)
        .all(...oppIds)
      for (const r of rows || []) oppById.set(String(r.id), r)
    } catch { /* opportunity enrichment is best-effort */ }
  }

  const qualified = []
  const near = []
  const short = []
  let noExplicit = 0

  for (const g of grants) {
    const opp = g.funding_opportunity_id ? oppById.get(String(g.funding_opportunity_id)) : null
    const reqs = extractThresholds(requirementText(g, opp))
    if (reqs.length === 0) { noExplicit += 1; continue }

    const evaluated = reqs.map((r) => ({
      kind: r.kind,
      label: KIND_LABEL[r.kind] || r.kind,
      need: r.value,
      have: facts[FACT_FOR_KIND[r.kind]],
      raw: r.raw,
      status: classifyRequirement(r, facts),
    }))

    const item = {
      grant_id: g.id,
      title: g.title || opp?.title || 'Untitled source',
      link: g.application_url || g.url || opp?.application_url || opp?.url || null,
      requirements: evaluated,
    }

    if (evaluated.some((r) => r.status === 'short')) short.push(item)
    else if (evaluated.some((r) => r.status === 'near')) near.push(item)
    else if (evaluated.some((r) => r.status === 'meets') && evaluated.every((r) => r.status === 'meets' || r.status === 'unknown')) {
      qualified.push(item)
    } else {
      noExplicit += 1 // all-unknown: nothing comparable on the profile yet
    }
  }

  return { facts, qualified, near, short, no_explicit_thresholds: noExplicit, analyzed: grants.length }
}

/**
 * Map the report onto a live Action Plan category — the "you're one move away"
 * list, with what crosses the gap and a link to act. Returned fresh per read,
 * never persisted (same contract as the Hamilton category). Null when there is
 * nothing near-miss to show (never an empty category).
 */
export async function buildThresholdTodoCategory(db, profileId) {
  let report = null
  try {
    report = await buildThresholdReport(db, profileId)
  } catch (err) {
    log.warn('threshold report failed (category skipped):', err?.message || err)
    return null
  }
  if (!report || report.near.length === 0) return null

  const items = []
  for (const miss of report.near.slice(0, 12)) {
    const gaps = miss.requirements.filter((r) => r.status === 'near')
    for (const r of gaps) {
      items.push({
        title: `Almost qualifies: ${miss.title} — needs ${r.label} ${r.need} (has ${r.have})`,
        priority: 'high',
        deadline: null,
        instructions: crossingAdvice({ kind: r.kind, value: r.need }, r.have)
          + (miss.link ? '' : '\n\nNo application link is on file yet — open the source from the pipeline for details.'),
        resources_needed: null,
        contact_or_location: null,
        profile_section: null,
        field_key: r.kind === 'act' ? 'act_score' : r.kind === 'sat' ? 'sat_score' : r.kind === 'gpa' ? 'gpa' : null,
        link_url: miss.link || null,
        source: 'threshold',
        threshold_kind: r.kind,
      })
    }
  }
  if (items.length === 0) return null

  const clearCount = report.qualified.length
  return {
    name: 'Threshold watch — almost qualified',
    icon: 'target',
    source: 'threshold',
    live: true,
    description: `Sources where one number stands between this profile and eligibility${clearCount ? ` (plus ${clearCount} source${clearCount === 1 ? '' : 's'} whose stated thresholds the profile already clears)` : ''}. Computed from the profile's own facts — update a fact and this list re-checks itself.`,
    items,
  }
}

export default { extractThresholds, extractProfileFacts, classifyRequirement, buildThresholdReport, buildThresholdTodoCategory }
