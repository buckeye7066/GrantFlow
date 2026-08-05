/**
 * funderBehavior.js — canonical facts for the IRS-990 FUNDER-BEHAVIOR GRAPH.
 *
 * WHAT THIS IS. Commercial grant-discovery products (Candid / Foundation
 * Directory) answer "who funds organizations and needs like this one?" from
 * grant TRANSACTIONS — the itemized lists funders file in IRS 990-PF Part XV
 * and Form 990 Schedule I. GrantFlow's 990 lane (`propublica990Adapter`)
 * discovers the FUNDERS but knew nothing about their giving. This module holds
 * the pure facts for reading that giving from the public e-file corpus.
 *
 * THE CHAIN, each link live-verified 2026-08-05:
 *   1. ProPublica's org PAGE (open, no key) lists a funder's e-file object ids
 *      as `download-xml?object_id=<18 digits>` links, newest first.
 *      (ProPublica's JSON API does NOT carry object ids, and its download-xml
 *      endpoint itself sits behind a bot wall — the page is the honest,
 *      reachable index; the XML comes from the data lake below.)
 *   2. The GivingTuesday 990 data lake serves the raw IRS e-file XML keyless:
 *      `https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/<object_id>_public.xml`
 *      (Ford Foundation 990-PF: 200, 6.0 MB, 4,007 itemized grants; Cleveland
 *      Foundation 990 Schedule I: 200, 1,016 recipient rows.)
 *   3. Two filing shapes carry itemized grants:
 *        990-PF : GrantOrContributionPdDurYrGrp — RecipientBusinessName /
 *                 RecipientPersonNm, RecipientUSAddress|RecipientForeignAddress,
 *                 GrantOrContributionPurposeTxt, Amt
 *        990    : RecipientTable (Schedule I) — RecipientBusinessName,
 *                 USAddress|ForeignAddress, RecipientEIN, CashGrantAmt,
 *                 PurposeOfGrantTxt
 *
 * HONESTY RULES.
 *   - Nothing here fabricates: every stored fact is read verbatim from the
 *     funder's own filing. A filing with no itemized grants is a REAL answer
 *     ("this funder files no itemized grant list"), not a failure.
 *   - Identifiers are sanitized to their exact shapes (EIN = 9 digits,
 *     object id = 18 digits) so a URL can never be built from junk.
 *   - Purpose→need matching is a CONSERVATIVE registry of whole-word terms
 *     (min length 4, matched at token boundaries) — the #937 one-shared-word
 *     floor is the standing counterexample; a purpose that names nothing in
 *     the registry evidences nothing.
 */
import { XMLParser } from 'fast-xml-parser'
import { DECLARED_NEED_FIELDS, HOUSING_INSTABILITY_FLAGS } from './crisisNeedRecall.js'

export const PROPUBLICA_ORG_PAGE_URL = (ein) =>
  `https://projects.propublica.org/nonprofits/organizations/${ein}`
export const EFILE_XML_URL = (objectId) =>
  `https://gt990datalake-rawdata.s3.amazonaws.com/EfileData/XmlFiles/${objectId}_public.xml`

/** EIN: exactly 9 digits, or null. */
export function normalizeEin(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return digits.length === 9 ? digits : null
}

/** IRS e-file object id: exactly 18 digits. */
export function isValidObjectId(raw) {
  return /^\d{18}$/.test(String(raw ?? ''))
}

/**
 * Extract e-file object ids from a ProPublica org page, in page order
 * (ProPublica lists newest filings first), de-duplicated. ONLY the
 * `download-xml?object_id=` link shape counts — the page also carries object
 * ids in other link kinds (PDF viewers) that are not e-file XML claims.
 */
export function extractObjectIdsFromOrgHtml(html) {
  const out = []
  const seen = new Set()
  const rx = /download-xml\?object_id=(\d{18})/g
  let m
  while ((m = rx.exec(String(html ?? ''))) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1])
      out.push(m[1])
    }
  }
  return out
}

// ── XML parsing ──────────────────────────────────────────────────────────────

/**
 * Collect every value held under `key` anywhere in a parsed-XML object tree.
 * The IRS wraps the grant groups at slightly different depths across form
 * versions/years; walking by ELEMENT NAME is robust where a fixed path is
 * brittle. Bounded by the tree itself (no cycles in parsed XML).
 */
function collectByKey(node, key, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectByKey(item, key, out)
    return out
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) {
      if (Array.isArray(v)) out.push(...v)
      else out.push(v)
    } else {
      collectByKey(v, key, out)
    }
  }
  return out
}

function firstByKey(node, key) {
  const hits = collectByKey(node, key)
  return hits.length ? hits[0] : null
}

function textOf(v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  if (typeof v === 'object') {
    // fast-xml-parser puts text content under '#text' when attributes exist
    if (typeof v['#text'] === 'string' || typeof v['#text'] === 'number') return String(v['#text']).trim() || null
  }
  return null
}

function numberOf(v) {
  const n = Number(textOf(v))
  return Number.isFinite(n) ? n : null
}

function recipientNameOf(group) {
  const biz = firstByKey(group, 'RecipientBusinessName')
  const line1 = biz ? textOf(firstByKey(biz, 'BusinessNameLine1Txt')) : null
  if (line1) {
    const line2 = textOf(firstByKey(biz, 'BusinessNameLine2Txt'))
    return line2 ? `${line1} ${line2}` : line1
  }
  return textOf(firstByKey(group, 'RecipientPersonNm'))
}

function addressOf(group) {
  const us = firstByKey(group, 'RecipientUSAddress') ?? firstByKey(group, 'USAddress')
  if (us) {
    return {
      city: textOf(firstByKey(us, 'CityNm')),
      state: (textOf(firstByKey(us, 'StateAbbreviationCd')) ?? '').toUpperCase() || null,
      country: 'US',
    }
  }
  const foreign = firstByKey(group, 'RecipientForeignAddress') ?? firstByKey(group, 'ForeignAddress')
  if (foreign) {
    return {
      city: textOf(firstByKey(foreign, 'CityNm')),
      state: null,
      country: (textOf(firstByKey(foreign, 'CountryCd')) ?? '').toUpperCase() || null,
    }
  }
  return { city: null, state: null, country: null }
}

/**
 * Parse one IRS e-file Return XML into itemized grant transactions.
 *
 * Returns { formType, taxYear, filerName, transactions, truncated } where each
 * transaction is { recipient_name, recipient_ein, recipient_city,
 * recipient_state, recipient_country, amount, purpose }.
 *
 * Only CASH grants with a positive amount are recorded (990 Schedule I rows
 * that carry only NonCashAssistanceAmt are excluded — a non-cash gift is not a
 * dollar figure an applicant could receive). A parseable filing with ZERO
 * itemized grants returns transactions: [] — a real answer, never an error.
 */
export function parseGrantTransactionsFromXml(xmlText, { maxTransactions = 5000 } = {}) {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false })
  const tree = parser.parse(String(xmlText ?? ''))
  const ret = tree?.Return ?? tree
  if (!ret || typeof ret !== 'object' || !firstByKey(ret, 'ReturnHeader')) {
    throw new Error('not an IRS e-file Return document')
  }

  const formType = textOf(firstByKey(ret, 'ReturnTypeCd'))
  const taxYearRaw = numberOf(firstByKey(ret, 'TaxYr')) ?? numberOf(firstByKey(ret, 'TaxYear'))
  const header = firstByKey(ret, 'ReturnHeader')
  const filerBiz = firstByKey(firstByKey(header, 'Filer') ?? {}, 'BusinessName')
  const filerName = filerBiz ? textOf(firstByKey(filerBiz, 'BusinessNameLine1Txt')) : null

  const transactions = []
  let truncated = false

  const push = (tx) => {
    if (transactions.length >= maxTransactions) {
      truncated = true
      return false
    }
    transactions.push(tx)
    return true
  }

  // 990-PF Part XV — grants PAID during the year (the "PdDurYr" group; the
  // sibling "ApprvForFutPymtGrp" is approved-not-yet-paid and is deliberately
  // excluded: money not yet given is not demonstrated behavior).
  for (const group of collectByKey(ret, 'GrantOrContributionPdDurYrGrp')) {
    const name = recipientNameOf(group)
    const amount = numberOf(firstByKey(group, 'Amt'))
    if (!name || !(amount > 0)) continue
    const addr = addressOf(group)
    if (
      !push({
        recipient_name: name,
        recipient_ein: null,
        recipient_city: addr.city,
        recipient_state: addr.state,
        recipient_country: addr.country,
        amount,
        purpose: textOf(firstByKey(group, 'GrantOrContributionPurposeTxt')),
      })
    ) break
  }

  // Form 990 Schedule I — grants to domestic organizations/governments.
  for (const group of collectByKey(ret, 'RecipientTable')) {
    const name = recipientNameOf(group)
    const amount = numberOf(firstByKey(group, 'CashGrantAmt'))
    if (!name || !(amount > 0)) continue
    const addr = addressOf(group)
    if (
      !push({
        recipient_name: name,
        recipient_ein: normalizeEin(textOf(firstByKey(group, 'RecipientEIN'))),
        recipient_city: addr.city,
        recipient_state: addr.state,
        recipient_country: addr.country,
        amount,
        purpose: textOf(firstByKey(group, 'PurposeOfGrantTxt')),
      })
    ) break
  }

  return {
    formType: formType ?? null,
    taxYear: Number.isFinite(taxYearRaw) ? taxYearRaw : null,
    filerName,
    transactions,
    truncated,
  }
}

// ── Purpose → canonical need evidence ───────────────────────────────────────

/**
 * CONSERVATIVE registry: canonical need id → whole-word terms that, appearing
 * in a grant's stated PURPOSE, evidence that the funder funds that need.
 * Terms are matched at token boundaries, min length 4. Multi-word terms are
 * preferred; single words appear only where the word alone is unambiguous in
 * grant-purpose prose. Do NOT grow this with generic words ("support",
 * "community", "program") — the #937 one-shared-word floor is the standing
 * counterexample.
 */
export const PURPOSE_NEED_TERMS = Object.freeze({
  housing: ['housing', 'homeless', 'homelessness', 'rent assistance', 'rental assistance', 'shelter', 'eviction'],
  food: ['food bank', 'food pantry', 'hunger', 'meals', 'food insecurity', 'nutrition'],
  education: ['education', 'school', 'tuition', 'students', 'student', 'literacy', 'classroom'],
  scholarship: ['scholarship', 'scholarships'],
  medical: ['medical', 'health care', 'healthcare', 'hospital', 'clinic', 'patient', 'health'],
  mental_health: ['mental health', 'behavioral health', 'counseling', 'suicide prevention'],
  substance_recovery: ['substance abuse', 'addiction', 'recovery services', 'opioid'],
  disability: ['disability', 'disabilities', 'disabled', 'special needs'],
  veterans: ['veteran', 'veterans'],
  employment: ['job training', 'workforce', 'employment', 'vocational'],
  arts_education: ['arts education', 'music education', 'performing arts', 'visual arts'],
  emergency: ['disaster relief', 'emergency assistance', 'emergency relief', 'crisis relief'],
  animal_welfare: ['animal welfare', 'humane society', 'animal rescue', 'animal shelter'],
  childcare: ['child care', 'childcare', 'early childhood'],
  environmental_remediation: ['environmental', 'conservation', 'clean water'],
  legal: ['legal aid', 'legal services', 'legal assistance'],
  transportation: ['transportation'],
  utilities: ['utility assistance', 'energy assistance', 'utility bills'],
  operations: ['general operating support', 'operating support', 'general support'],
})

const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g
function wholeWordRx(term) {
  return new RegExp(`\\b${String(term).replace(RE_ESCAPE, '\\$&')}\\b`, 'i')
}

/**
 * Which canonical needs a grant PURPOSE evidences. Whole-word only, min term
 * length 4; a null/short/unmatched purpose evidences nothing (silence is not
 * evidence, in either direction).
 */
export function needsEvidencedByPurpose(purpose) {
  const text = String(purpose ?? '')
  if (text.length < 4) return []
  const out = []
  for (const [need, terms] of Object.entries(PURPOSE_NEED_TERMS)) {
    for (const term of terms) {
      if (term.length < 4) continue
      if (wholeWordRx(term).test(text)) {
        out.push(need)
        break
      }
    }
  }
  return out
}

/** SQL LIKE superset patterns for a set of declared needs (JS re-adjudicates). */
export function purposeLikePatternsForNeeds(needIds) {
  const patterns = []
  for (const need of needIds ?? []) {
    for (const term of PURPOSE_NEED_TERMS[need] ?? []) {
      if (term.length >= 4) patterns.push(`%${term.toLowerCase()}%`)
    }
  }
  return [...new Set(patterns)]
}

// ── Declared needs (general, all canonical categories) ──────────────────────

function asList(v) {
  if (Array.isArray(v)) return v
  if (typeof v === 'string') {
    const t = v.trim()
    if (t.startsWith('[')) {
      try {
        const p = JSON.parse(t)
        return Array.isArray(p) ? p : []
      } catch {
        return []
      }
    }
    return t ? [t] : []
  }
  return []
}

/**
 * The GENERAL edition of `declaredCrisisNeeds` (crisisNeedRecall.js): reads
 * the SAME `DECLARED_NEED_FIELDS` registry — structured arrays and strict
 * `=== true` housing flags, NEVER prose (prose cannot be told from its own
 * denial, the three-times-shipped class) — but returns EVERY canonical need
 * the profile declares, not only the basic_needs group. `normalizeNeedCategory`
 * and the alias map are injected (the crisisNeedRecall DI posture) so this
 * config stays pure.
 */
export function declaredNeedsOf(profile, sections, normalizeNeedCategory, needAliasMap) {
  const raw = []
  for (const f of DECLARED_NEED_FIELDS) {
    if (typeof f.read === 'function') {
      raw.push(...f.read(profile))
      continue
    }
    for (const [sectionKey, sectionData] of Object.entries(sections ?? {})) {
      if (!sectionData || typeof sectionData !== 'object') continue
      const answers = sectionData.answers ?? sectionData
      if (!answers || typeof answers !== 'object') continue
      if (f.array) {
        raw.push(...asList(answers[f.key]))
        continue
      }
      if (f.sectionKey) {
        const k = String(sectionKey).toLowerCase()
        const base = k.replace(/_information$/, '')
        if (needAliasMap?.[k]) raw.push(k)
        else if (base !== k && needAliasMap?.[base]) raw.push(base)
      }
    }
  }
  for (const [sectionKey, sectionData] of Object.entries(sections ?? {})) {
    if (!/^(housing|shelter)(_information)?$/i.test(sectionKey)) continue
    const answers = sectionData?.answers ?? sectionData
    if (!answers || typeof answers !== 'object') continue
    if (HOUSING_INSTABILITY_FLAGS.some((flag) => answers[flag] === true)) raw.push('housing')
  }
  return new Set(raw.map((v) => normalizeNeedCategory?.(v)).filter(Boolean))
}

// ── Funder-row enrichment ───────────────────────────────────────────────────

/**
 * Idempotence marker: a funder row whose description already carries this
 * marker has been enriched from a filing; re-enrichment REPLACES the marked
 * line rather than appending a second one.
 */
export const FUNDER_GIVING_MARKER = 'IRS 990 grants filed'

/**
 * One honest sentence of demonstrated giving, from the filing alone. Never
 * speculates; states only counts, states, and the amount range actually filed.
 */
export function summarizeFunderGiving({ taxYear, transactions }) {
  const txs = Array.isArray(transactions) ? transactions : []
  if (!txs.length) return null
  const amounts = txs.map((t) => Number(t.amount)).filter((n) => Number.isFinite(n) && n > 0)
  const total = amounts.reduce((a, b) => a + b, 0)
  const min = Math.min(...amounts)
  const max = Math.max(...amounts)
  const states = new Map()
  for (const t of txs) {
    if (t.recipient_state) states.set(t.recipient_state, (states.get(t.recipient_state) ?? 0) + 1)
  }
  const topStates = [...states.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([st, n]) => `${st} (${n})`)
  const yr = taxYear ? ` (tax year ${taxYear})` : ''
  const fmt = (n) => `$${Math.round(n).toLocaleString('en-US')}`
  const stateClause = topStates.length ? ` Top recipient states: ${topStates.join(', ')}.` : ''
  return (
    `${FUNDER_GIVING_MARKER}${yr}: ${txs.length.toLocaleString('en-US')} grants ` +
    `totaling ${fmt(total)}, individual awards ${fmt(min)}–${fmt(max)}.${stateClause}`
  )
}

/**
 * Merge a giving summary into a funder row's existing description,
 * idempotently: an existing marked line is replaced, everything else is kept.
 */
export function mergeGivingSummaryIntoDescription(description, summaryLine) {
  const base = String(description ?? '').trim()
  if (!summaryLine) return base || null
  const lines = base ? base.split('\n').filter((l) => !l.includes(FUNDER_GIVING_MARKER)) : []
  lines.push(summaryLine)
  return lines.join('\n')
}

export default {
  PROPUBLICA_ORG_PAGE_URL,
  EFILE_XML_URL,
  normalizeEin,
  isValidObjectId,
  extractObjectIdsFromOrgHtml,
  parseGrantTransactionsFromXml,
  PURPOSE_NEED_TERMS,
  needsEvidencedByPurpose,
  purposeLikePatternsForNeeds,
  declaredNeedsOf,
  FUNDER_GIVING_MARKER,
  summarizeFunderGiving,
  mergeGivingSummaryIntoDescription,
}
