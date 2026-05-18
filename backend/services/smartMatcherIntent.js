/**
 * Smart Matcher — turn free-text funding requests into catalog search terms.
 * Rules-first (no API key required); optional OpenAI JSON boost when configured.
 *
 * Returns:
 *   {
 *     summary,
 *     search_terms,
 *     method,
 *     primary_category,        // e.g. 'professional_development', 'income_support', 'general'
 *     excluded_categories,     // categories the matcher should hard-exclude
 *     branded_program,         // recognized branded name (e.g. 'PROBE') if any
 *     credentials_detected,    // ['RN','LCSW',...] when extracted from text
 *   }
 */

import { createOpenAIClient } from '../utils/openaiClient.js'

const MAX_INPUT = 2000
const MAX_TERMS = 18
const MAX_TERM_LEN = 64

const STOP = new Set(
  `a an the and or but if to of at by for from with without in on as is are was were be been being
   it this that these those i me my we our you your he she they them what which who whom
   help need want looking look find funding fund money grant grants source sources program programs
   assistance support please can could would should may might get obtain acquiring acquire give gives giving away free`
    .split(/\s+/),
)

/** @param {string} raw */
export function sanitizeSearchTerm(raw) {
  let s = String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TERM_LEN)
  return s
}

// ---------------------------------------------------------------------------
// Branded CE / licensure / remediation program lookup
//
// When a user enters one of these well-known program names, we know the
// general category and can route to the appropriate funder pools instead of
// treating it as an unknown string. This was a real production bug: a query
// for "PROBE: Ethics and Boundaries" surfaced SSI cash assistance because the
// matcher had no concept of "professional ethics CE course."
// ---------------------------------------------------------------------------
const BRANDED_PROGRAMS = [
  {
    re: /\b(probe|pro\s*be)\b.*(ethics|boundar)/i,
    name: 'PROBE',
    program_type: 'ethics_remediation',
    add: [
      'probe ethics',
      'professional boundaries',
      'license reinstatement',
      'nursing reinstatement',
      'ethics course',
      'remediation course',
      'professional ethics ce',
      'continuing education',
      'professional development',
      'wioa training',
      'workforce training board',
      'vocational rehabilitation',
      'state nurses foundation',
    ],
  },
  // Catch the bare program name even without the "ethics/boundaries" suffix.
  // The user said “PROBE program” → still professional development, not SSI.
  {
    re: /\b(probe|pro\s*be)\s+(program|class|course)\b/i,
    name: 'PROBE',
    program_type: 'ethics_remediation',
    add: [
      'probe ethics',
      'professional boundaries',
      'license reinstatement',
      'remediation course',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\bciti\s*(program|training|module|course)?\b/i,
    name: 'CITI',
    program_type: 'research_ethics',
    add: [
      'research ethics',
      'human subjects training',
      'irb training',
      'continuing education',
      'professional development',
      'university training',
    ],
  },
  {
    re: /\bscope\s*(program|course|training)\b/i,
    name: 'SCOPE',
    program_type: 'physician_remediation',
    add: [
      'physician remediation',
      'medical license remediation',
      'continuing medical education',
      'cme',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\bpace\s*(program|course|training)?\b/i,
    name: 'PACE',
    program_type: 'physician_remediation',
    add: [
      'pace program',
      'physician assessment',
      'physician remediation',
      'continuing medical education',
      'cme',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\bcpep\s*(program|course)?\b/i,
    name: 'CPEP',
    program_type: 'physician_remediation',
    add: [
      'cpep',
      'physician evaluation',
      'physician remediation',
      'continuing medical education',
      'cme',
      'continuing education',
    ],
  },
  {
    re: /\b(nclex|nclex.?rn|nclex.?pn)\b/i,
    name: 'NCLEX',
    program_type: 'nursing_licensure_exam',
    add: [
      'nclex prep',
      'nursing licensure',
      'nursing exam',
      'continuing education',
      'professional development',
      'wioa training',
    ],
  },
  {
    re: /\b(bls|acls|pals)\b\s*(certification|class|course|training)?/i,
    name: 'BLS/ACLS/PALS',
    program_type: 'medical_certification',
    add: [
      'bls certification',
      'acls certification',
      'medical certification',
      'continuing education',
      'professional development',
    ],
  },
]

// ---------------------------------------------------------------------------
// Credentials → professional_development pool
// ---------------------------------------------------------------------------
const CREDENTIAL_RE = /\b(RN|LPN|APRN|CNA|MD|DO|MBBS|PA|PA\-C|NP|FNP|DNP|CRNA|LCSW|LMSW|LSW|MSW|LPC|LMFT|LMHC|PsyD|PhD|EdD|DDS|DMD|RDH|PharmD|RPh|DPT|PT|OT|OTR|SLP|RN\-BC)\b/g

function extractCredentials(text) {
  const found = new Set()
  const matches = String(text || '').match(CREDENTIAL_RE) || []
  for (const m of matches) found.add(m.toUpperCase())
  return Array.from(found)
}

// ---------------------------------------------------------------------------
// Category detection: maps a free-text request to a primary_category and
// the set of categories that should be excluded from the result set.
//
// This is the rule from the user spec:
//   "if extracted keywords match the Professional Development taxonomy,
//    exclude general means-tested cash-assistance programs from the result
//    set unless explicitly requested."
// ---------------------------------------------------------------------------
const PROFESSIONAL_DEVELOPMENT_TRIGGERS = [
  /\b(probe|nclex|citi|scope|pace|cpep|bls|acls|pals)\b/i,
  /\b(ethics|boundary|boundaries)\s+(training|course|class|program|education|ce|ceu|cme|credit|credits|requirement|requirements|hours)\b/i,
  /\b(continuing\s+education|continuing\s+medical\s+education|cme|ceus?|ce credit|ceu credit)\b/i,
  /\b(license|licensure|licensing)\s+(reinstatement|renewal|restoration|exam|fee|prep)\b/i,
  /\b(remediation|remedial)\s+(course|class|program|education|training|coursework)\b/i,
  /\b(professional\s+development|professional\s+training|professional\s+education)\b/i,
  /\b(certification|recertification|credential|credentialing)\s+(course|class|exam|fee|training)?\b/i,
  /\b(nurse|nursing|social\s+work|counseling|counselor|therap(?:ist|y)|physician|medical|pharmacist|dental)\b\s+(?:scholarship|ce|continuing|reentry|re-entry|refresher|workforce|training|license|licensure|remediation)\b/i,
  /\b(workforce\s+development|wioa|individual\s+training\s+account|ita\b|vocational\s+rehab|voc\s+rehab|workforce\s+board|american\s+job\s+center|career\s+one\s*stop)\b/i,
  /\b(refresher|reentry|re-entry|return\s+to\s+practice|return\s+to\s+nursing)\b/i,
  /\b(professional\s+association\s+(scholarship|grant)|ana|nasw|amas?|apa|aacn|aanp)\s+(scholarship|grant|ce|fund)\b/i,
]

const INCOME_SUPPORT_CATEGORIES = [
  'income_support',
  'cash_assistance',
  'ssi',
  'ssdi',
  'snap',
  'tanf',
  'wic',
  'liheap',
  'general_assistance',
]

function detectPrimaryCategory(text, expandedTerms = []) {
  const haystack = `${String(text || '').toLowerCase()} ${expandedTerms.join(' ').toLowerCase()}`
  for (const re of PROFESSIONAL_DEVELOPMENT_TRIGGERS) {
    if (re.test(haystack)) {
      return {
        primary_category: 'professional_development',
        excluded_categories: INCOME_SUPPORT_CATEGORIES.slice(),
      }
    }
  }
  // Other categories can be detected the same way later; default neutral.
  return { primary_category: 'general', excluded_categories: [] }
}

// ---------------------------------------------------------------------------
// Term expansion rules (rules-only path).
// ---------------------------------------------------------------------------
const EXPANSIONS = [
  {
    re: /\b(bereave|bereavement|funeral|grief|mourning|memorial|death in family|lost a loved one)\b/i,
    add: [
      'bereavement',
      'funeral assistance',
      'emergency travel',
      'family crisis',
      'travel assistance',
      'memorial',
    ],
  },
  {
    re: /\b(airplane|airline|plane ticket|flight ticket|air fare|airfare|fly to|flying)\b/i,
    add: ['travel assistance', 'transportation', 'emergency travel', 'trip assistance', 'airline'],
  },
  {
    re: /\b(passenger van|15[\s-]?passenger|minibus|church van|school van|transport van|wheelchair van|accessible van)\b/i,
    add: [
      'vehicle grant',
      'transportation equipment',
      'van',
      'accessible vehicle',
      'nonprofit vehicle',
      'fleet',
    ],
  },
  {
    re: /\b(van|minivan|suv|truck|car|vehicle|automobile)\b/i,
    add: ['vehicle assistance', 'transportation', 'car repair', 'automotive'],
  },
  {
    re: /\b(rent|rental|eviction|housing|homeless|mortgage|utilities|electric|heat|water bill)\b/i,
    add: ['housing assistance', 'rental assistance', 'utility assistance', 'home repair'],
  },
  {
    re: /\b(food|groceries|snap|hunger|meal)\b/i,
    add: ['food assistance', 'nutrition', 'food bank'],
  },
  {
    re: /\b(medical|health|hospital|prescription|dental|vision|disability)\b/i,
    add: ['healthcare', 'medical assistance', 'disability'],
  },
  // Generic education (kept for college / K-12 routing).
  {
    re: /\b(education|tuition|scholarship|college|student)\b/i,
    add: ['education', 'scholarship', 'tuition assistance'],
  },
  // Professional development / continuing education / licensure.
  // This is the new pool that powers PROBE / CITI / nursing / social-work CE
  // queries. It deliberately includes workforce-board terms (WIOA / ITA /
  // American Job Center) because those are the primary funding channel for
  // license reinstatement and CE courses for individuals.
  {
    re: /\b(continuing\s+education|continuing\s+medical\s+education|cme|ceus?|ce credit|professional\s+development|professional\s+training)\b/i,
    add: [
      'continuing education',
      'professional development',
      'cme',
      'ceu',
      'license reinstatement',
      'wioa training',
      'individual training account',
      'workforce training board',
      'professional association scholarship',
      'state nurses foundation',
    ],
  },
  {
    re: /\b(licensure|license|licensing)\s+(reinstatement|renewal|restoration|exam|fee|prep)\b/i,
    add: [
      'license reinstatement',
      'license renewal',
      'licensure',
      'credential restoration',
      'recertification',
      'professional development',
      'continuing education',
      'wioa training',
      'workforce training board',
      'vocational rehabilitation',
    ],
  },
  {
    re: /\b(ethics|boundary|boundaries)\s+(training|course|class|program|education|ce|ceu|cme|credit|credits|requirement|requirements|hours)\b/i,
    add: [
      'ethics training',
      'professional boundaries',
      'probe ethics',
      'remediation course',
      'continuing education',
      'professional development',
      'license reinstatement',
    ],
  },
  {
    re: /\b(remediation|remedial)\s+(course|class|program|education|training|coursework)\b/i,
    add: [
      'remediation course',
      'remediation program',
      'professional remediation',
      'license reinstatement',
      'continuing education',
      'professional development',
    ],
  },
  {
    re: /\b(refresher|reentry|re-entry|return\s+to\s+practice|return\s+to\s+nursing)\b/i,
    add: [
      'nurse reentry',
      'return to practice',
      'nursing refresher',
      'continuing education',
      'license reinstatement',
      'professional development',
      'workforce reentry',
    ],
  },
  {
    re: /\b(certification|recertification|credential|credentialing)\b/i,
    add: [
      'certification',
      'recertification',
      'credentialing',
      'credential restoration',
      'professional development',
      'continuing education',
      'wioa training',
    ],
  },
  {
    re: /\b(workforce|wioa|individual\s+training\s+account|ita\b|vocational\s+rehab|voc\s+rehab|workforce\s+board|american\s+job\s+center|career\s+one\s*stop)\b/i,
    add: [
      'workforce development',
      'wioa training',
      'individual training account',
      'workforce training board',
      'american job center',
      'vocational rehabilitation',
    ],
  },
  {
    re: /\b(small business|startup|entrepreneur)\b/i,
    add: ['small business', 'entrepreneurship'],
  },
  {
    re: /\b(veteran|military|service member)\b/i,
    add: ['veteran', 'military'],
  },
]

function uniqueTerms(list) {
  const out = []
  const seen = new Set()
  for (const t of list) {
    const s = sanitizeSearchTerm(t)
    if (!s || s.length < 2) continue
    if (seen.has(s)) continue
    seen.add(s)
    out.push(s)
    if (out.length >= MAX_TERMS) break
  }
  return out
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
}

/**
 * Rule-based interpretation (always runs as baseline / fallback).
 * @param {string} text
 */
export function interpretFundingIntentRules(text) {
  const raw = String(text || '').trim().slice(0, MAX_INPUT)
  if (!raw) {
    return {
      summary: '',
      search_terms: [],
      method: 'rules',
      primary_category: 'general',
      excluded_categories: [],
      branded_program: null,
      credentials_detected: [],
    }
  }

  const added = []
  let brandedProgram = null

  // 1. Branded program lookup (highest signal — overrides loose token matches).
  for (const entry of BRANDED_PROGRAMS) {
    if (entry.re.test(raw)) {
      added.push(...entry.add)
      if (!brandedProgram) {
        brandedProgram = { name: entry.name, program_type: entry.program_type }
      }
    }
  }

  // 2. General term expansions.
  for (const { re, add } of EXPANSIONS) {
    if (re.test(raw)) added.push(...add)
  }

  const tokens = tokenize(raw)
  const phraseHints = []
  const bigram = []
  const words = raw.toLowerCase().split(/\s+/)
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i].replace(/[^a-z0-9]/g, '')
    const b = words[i + 1].replace(/[^a-z0-9]/g, '')
    if (a.length > 2 && b.length > 2) bigram.push(`${a} ${b}`)
  }
  phraseHints.push(...bigram.slice(0, 4))

  const search_terms = uniqueTerms([...added, ...phraseHints, ...tokens])

  const credentials = extractCredentials(raw)
  // Credentials by themselves should also trigger the professional development
  // category because licensed-professional searches almost always benefit from
  // CE / workforce-board sources, even when the request text is generic.
  const haystack = `${raw.toLowerCase()} ${added.join(' ').toLowerCase()}`
  const cat = detectPrimaryCategory(raw, search_terms)
  if (
    cat.primary_category === 'general' &&
    credentials.length > 0 &&
    /\b(scholarship|ce|continuing|training|course|exam|license|funding|grant)\b/i.test(haystack)
  ) {
    cat.primary_category = 'professional_development'
    cat.excluded_categories = INCOME_SUPPORT_CATEGORIES.slice()
  }

  const summary =
    search_terms.length > 0
      ? `Searching for opportunities related to: ${search_terms.slice(0, 6).join(', ')}${search_terms.length > 6 ? '…' : ''}.`
      : 'Describe what you need above — we will suggest search terms.'

  return {
    summary,
    search_terms,
    method: 'rules',
    primary_category: cat.primary_category,
    excluded_categories: cat.excluded_categories,
    branded_program: brandedProgram,
    credentials_detected: credentials,
  }
}

/**
 * Optional OpenAI refinement: returns merged terms (capped).
 * @param {string} text
 * @param {import('openai').default|null} openai
 */
async function interpretWithOpenAI(text, openai) {
  if (!openai) return null
  const raw = String(text || '').trim().slice(0, MAX_INPUT)
  if (!raw) return null

  const completion = await openai.chat.completions.create({
    model: process.env.SMART_MATCHER_INTENT_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You help users find grant and assistance programs. Given a plain-language request, output JSON only:
{"summary":"one short sentence for the user","search_terms":["term1","term2",...]}
Rules:
- search_terms: 4-12 short lowercase phrases (2-4 words each) useful for SQL LIKE against titles/descriptions (funding, nonprofits, government programs, charities).
- Include both specific items (e.g. "bereavement travel", "passenger van") and adjacent help types (e.g. "emergency assistance", "transportation grant").
- For professional development / continuing education / licensure / nursing PROBE / CME / remediation requests, also include: "professional development", "continuing education", "license reinstatement", "wioa training", "workforce training board", "individual training account".
- No duplicates. No PII. English only.`,
      },
      { role: 'user', content: raw },
    ],
  })

  const msg = completion?.choices?.[0]?.message?.content
  if (!msg) return null
  let parsed
  try {
    parsed = JSON.parse(msg)
  } catch {
    return null
  }
  const terms = uniqueTerms(Array.isArray(parsed.search_terms) ? parsed.search_terms : [])
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
  if (!terms.length) return null
  return {
    summary: summary || `Looking for: ${terms.slice(0, 5).join(', ')}.`,
    search_terms: terms,
    method: 'openai',
  }
}

/**
 * @param {string} text
 * @param {{ openai?: import('openai').default | null }} [opts]
 */
export async function interpretFundingIntent(text, opts = {}) {
  const rules = interpretFundingIntentRules(text)
  let openai = opts.openai
  if (openai === undefined) {
    try {
      const r = createOpenAIClient({ allowMissing: true })
      openai = r?.openai ?? null
    } catch {
      openai = null
    }
  }

  try {
    const ai = await interpretWithOpenAI(text, openai)
    if (ai && ai.search_terms?.length) {
      const merged = uniqueTerms([...ai.search_terms, ...rules.search_terms])
      // Re-detect category against the merged term set so AI-only terms can
      // still trigger the professional_development pool.
      const cat = rules.primary_category !== 'general'
        ? { primary_category: rules.primary_category, excluded_categories: rules.excluded_categories }
        : detectPrimaryCategory(text, merged)
      return {
        summary: ai.summary || rules.summary,
        search_terms: merged.length ? merged : ai.search_terms,
        method: 'openai+rules',
        primary_category: cat.primary_category,
        excluded_categories: cat.excluded_categories,
        branded_program: rules.branded_program,
        credentials_detected: rules.credentials_detected,
      }
    }
  } catch (e) {
    console.warn('[smartMatcherIntent] OpenAI interpret failed, using rules only:', e?.message || e)
  }

  return rules
}

// Exported for tests & for the matching route to re-detect category server-side
// when a frontend pre-dates the new fields.
export { detectPrimaryCategory, extractCredentials, INCOME_SUPPORT_CATEGORIES }
