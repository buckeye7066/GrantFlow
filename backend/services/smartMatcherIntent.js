/**
 * Smart Matcher — turn free-text funding requests into catalog search terms.
 * Rules-first (no API key required); optional OpenAI JSON boost when configured.
 */

import { createOpenAIClient } from '../utils/openaiClient.js'

const MAX_INPUT = 2000
const MAX_TERMS = 14
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
  {
    re: /\b(education|tuition|scholarship|college|student|training)\b/i,
    add: ['education', 'scholarship', 'tuition assistance'],
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
    return { summary: '', search_terms: [], method: 'rules' }
  }

  const added = []
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

  const summary =
    search_terms.length > 0
      ? `Searching for opportunities related to: ${search_terms.slice(0, 6).join(', ')}${search_terms.length > 6 ? '…' : ''}.`
      : 'Describe what you need above — we will suggest search terms.'

  return { summary, search_terms, method: 'rules' }
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
      return {
        summary: ai.summary || rules.summary,
        search_terms: merged.length ? merged : ai.search_terms,
        method: 'openai+rules',
      }
    }
  } catch (e) {
    console.warn('[smartMatcherIntent] OpenAI interpret failed, using rules only:', e?.message || e)
  }

  return rules
}
