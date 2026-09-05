/**
 * hamiltonFieldAnswerer.js — the LLM field-understanding layer.
 *
 * Hamilton's fill loop recognizes a FIXED vocabulary of ~30 common fields
 * (FIELD_RULES). Any portal-specific question outside it ("Describe your
 * community involvement", "Intended research area", "List your honors",
 * "Parent/guardian occupation") was left blank → the form was incomplete →
 * missing_info → draft. This module answers those UNRECOGNIZED fields from the
 * profile, so an arbitrary portal question gets a real answer instead of a gap.
 *
 * OWNER RULES (2026-08-22), enforced here, not just prompted:
 *   - Answer ONLY from facts present in the profile. NEVER invent, assume, or
 *     embellish. A short-fact answer must be grounded IN the profile text (a
 *     deterministic token check rejects anything the profile does not contain);
 *     a placeholder/"[needed]" answer is rejected.
 *   - If the profile does not contain enough to answer truthfully, return null —
 *     the caller leaves the field blank so it becomes a NAMED ask to the user
 *     (Hamilton pings the profile owner rather than fabricating).
 *   - Free text is written at the same MBA-experienced, funder-tailored level as
 *     the proposal generator, grounded strictly in the profile.
 *
 * Degrades safely: with no AI provider (e.g. exhausted credits) invokeJson
 * returns not-ok and this returns null — exactly the pre-existing "leave it for
 * the user" behavior, never a fabricated value.
 */
import { invokeJsonWithFallback, getOpenAIOptional } from '../../utils/aiProviders.js'

// A field this layer will attempt: a text input or a textarea. Selects,
// checkboxes, radios, files, and identity/credential inputs are out of scope
// (handled elsewhere or genuinely need a human).
export function isAnswerableUnknownField(field) {
  if (!field || typeof field !== 'object') return false
  if (field.tag === 'textarea') return true
  if (field.tag === 'input') {
    const t = String(field.type || '').toLowerCase()
    return t === '' || t === 'text' || t === 'search'
  }
  // A <select> with its options listed ("Are you a U.S. Bank client?" —
  // Yes/No) is answerable ONLY as a choice among those options, and only when
  // the profile states the fact. Options come from detectFields.
  if (field.tag === 'select') return Array.isArray(field.options) && field.options.length > 0 && field.options.length <= 60
  return false
}

function selectOptionTexts(field) {
  return (Array.isArray(field?.options) ? field.options : [])
    .map((o) => (typeof o === 'string' ? o : (o?.label ?? o?.text ?? o?.value ?? '')))
    .map((s) => String(s).trim())
    .filter((s) => s && !/^(select|choose|please select|please choose|--|—|-)/i.test(s))
}

export function fieldLabelOf(field) {
  return String(field?.label || field?.ariaLabel || field?.placeholder || field?.name || '').trim()
}

// Flatten the profile bundle into a compact, readable evidence blob the model
// can ground on (and the grounding check can scan). Capped so a huge profile
// cannot blow the prompt budget. Values only — no code, no secrets (identity
// secrets live in the encrypted vault, not this object).
//
// MEASURED FAILURE THIS GUARDS AGAINST (2026-08-23, the U.S. Bank e2e): the
// profiles ROW carries an 8.5MB base64 `avatar_data` column, and the old walk
// emitted it as one line BEFORE any section — so the 6KB cap held nothing but
// avatar bytes, the model truthfully answered "the profile does not state
// this" for EVERY portal question, and the answerer was silently neutered for
// any profile with a stored image. Three rules now hold:
//   1. CURATED SECTIONS WALK FIRST — the applicant's declared facts can never
//      be pushed past the cap by a row column.
//   2. A base64/data-URI blob is not a fact: any space-less leaf > 400 chars
//      is dropped; ordinary long prose is truncated per-leaf, never dropped.
//   3. The cap is a budget for FACTS (12KB), not whatever happened to walk
//      first.
function evidenceLeaf(value) {
  const v = String(value).trim()
  if (!v) return null
  if (/^data:[a-z]+\//i.test(v)) return null
  if (v.length > 400 && !v.includes(' ')) return null // base64/hex blob, not prose
  return v.length > 400 ? `${v.slice(0, 400)}…` : v
}

export function buildProfileEvidence(profile, cap = 12000) {
  const lines = []
  const walk = (obj, prefix) => {
    if (obj === null || obj === undefined) return
    if (Array.isArray(obj)) {
      const flat = obj
        .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
        .map((v) => evidenceLeaf(v))
        .filter(Boolean)
      if (flat.length) lines.push(`${prefix}: ${flat.join(', ')}`)
      obj.forEach((v, i) => { if (v && typeof v === 'object') walk(v, `${prefix}[${i}]`) })
      return
    }
    if (typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) walk(v, prefix ? `${prefix}.${k}` : k)
      return
    }
    const s = evidenceLeaf(obj)
    if (s) lines.push(`${prefix}: ${s}`)
  }
  try {
    const sections = profile?.sections
    if (sections && typeof sections === 'object' && !Array.isArray(sections)) {
      for (const [k, v] of Object.entries(sections)) walk(v, k)
      for (const [k, v] of Object.entries(profile ?? {})) {
        if (k === 'sections' || k in sections) continue
        walk(v, k)
      }
    } else {
      walk(profile, '')
    }
  } catch { /* best-effort */ }
  return lines.join('\n').slice(0, cap)
}

// Normalize for grounding comparison: lower-case, strip punctuation to spaces.
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// A SHORT-FACT answer must actually appear in the profile — either as a
// contiguous phrase, or every content word of it present in the profile text.
// This is the hard anti-hallucination gate for extracted values.
export function isGroundedInProfile(answer, evidenceText) {
  const a = norm(answer)
  const e = norm(evidenceText)
  if (!a) return false
  if (e.includes(a)) return true
  const stop = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'for', 'at', 'is', 'are', 'my', 'i', 'with', 'on'])
  const words = a.split(' ').filter((w) => w.length > 2 && !stop.has(w))
  if (words.length === 0) return false
  const eWords = new Set(e.split(' '))
  return words.every((w) => eWords.has(w))
}

const PLACEHOLDER_RX = /\[[^\]]*(needed|tbd|insert|your\s|placeholder|xxx|n\/a)[^\]]*\]|\blorem ipsum\b/i

/**
 * Answer one unrecognized portal field from the profile, or null (ask the user).
 * `_deps` injects the LLM + provider factory for hermetic tests.
 */
export async function answerUnknownField(field, {
  profile, opportunity = null, grant = null, _deps = null,
} = {}) {
  if (!profile || !isAnswerableUnknownField(field)) return null
  const label = fieldLabelOf(field)
  if (!label || label.length > 300) return null

  const invokeJson = _deps?.invokeJson || invokeJsonWithFallback
  const openaiFactory = _deps?.getOpenAIOptional || getOpenAIOptional
  const evidence = buildProfileEvidence(profile)
  if (!evidence) return null
  const freeText = field.tag === 'textarea'
  const isSelect = field.tag === 'select'
  const options = isSelect ? selectOptionTexts(field) : []
  if (isSelect && options.length === 0) return null

  // The portal's OWN stated limit wins over our historical constants. Those
  // constants (300 / 4000) were invented here and applied regardless of what
  // the form actually allowed, so a funder permitting a 10,000-character
  // narrative received 4,000 and every short field was chopped at 300 —
  // frequently mid-sentence, which reads as a careless applicant.
  const declaredLimit = Number.isFinite(Number(field?.maxLength)) && Number(field.maxLength) > 0
    ? Number(field.maxLength)
    : null
  const fallbackLimit = freeText ? 4000 : 300
  const effectiveLimit = declaredLimit ?? fallbackLimit
  // Ask the model to WRITE to the budget rather than relying on truncation. A
  // well-formed shorter answer beats a longer one cut mid-word.
  const budgetLine = declaredLimit
    ? `\nLENGTH LIMIT: this field accepts at most ${declaredLimit} characters. Write a complete answer that fits inside it — do not exceed it and do not stop mid-sentence.\n`
    : ''

  const funderLine = (opportunity || grant)
    ? `FUNDING SOURCE: ${String(opportunity?.title || grant?.title || '').slice(0, 160)} — ${String(opportunity?.sponsor || grant?.funder || '').slice(0, 120)}\n`
      + `What the funder looks for: ${String(opportunity?.eligibility_text || opportunity?.description || grant?.eligibility || '').slice(0, 600)}\n`
    : ''

  const prompt = `APPLICANT PROFILE — the ONLY source of truth. Every fact in your answer MUST come from here:
${evidence}

${funderLine}
APPLICATION FIELD TO ANSWER: "${label}"${freeText ? ' (a free-text / essay field)' : (isSelect ? ' (a drop-down: the answer MUST be one of the OPTIONS below, verbatim)' : ' (a short answer field)')}
${isSelect ? `OPTIONS: ${options.map((o) => JSON.stringify(o)).join(', ')}\n` : ''}${budgetLine}
RULES:
- Answer ONLY with facts present in the APPLICANT PROFILE above. NEVER invent, assume, guess, or embellish. Do not add numbers, dates, names, or achievements that are not in the profile.
- If the profile does not contain enough to answer this field truthfully, set "answer" to null and say what is missing in "reason".
- ${freeText
    ? 'Write a concise (2-5 sentences), specific, funder-tailored answer at the level of an experienced grant writer, grounded strictly in the profile.'
    : 'Return the exact value from the profile (no extra words).'}
- Output ONLY JSON: {"answer": "<text>" | null, "grounded_in": ["<profile field paths you used>"], "reason": "<why null, if null>"}`

  let llm
  try {
    llm = await invokeJson({
      openai: openaiFactory ? openaiFactory() : null,
      system: 'You are a meticulous grant-application assistant who NEVER fabricates. Output only valid JSON.',
      prompt,
      temperature: 0.2,
      maxTokens: freeText ? 700 : 200,
    })
  } catch { return null }

  if (!llm || !llm.ok || !llm.json || typeof llm.json !== 'object') return null
  const answer = typeof llm.json.answer === 'string' ? llm.json.answer.trim() : null
  if (!answer) return null // not answerable from the profile → ask the user
  if (PLACEHOLDER_RX.test(answer)) return null

  const groundedIn = Array.isArray(llm.json.grounded_in)
    ? llm.json.grounded_in.map(String).slice(0, 8)
    : []
  if (isSelect) {
    // The choice must be one of the portal's own options, and the model must
    // point at a profile field that actually exists in the evidence — a bare
    // "No" to "Are you a client?" with nothing to stand on is an ask, not an
    // answer.
    const chosen = options.find((o) => o.toLowerCase() === answer.toLowerCase())
    if (!chosen) return null
    const anchored = groundedIn.some((p) => p && evidence.includes(String(p).split('.').pop()))
    if (!anchored) return null
    return { value: chosen, free_text: false, grounded_in: groundedIn }
  }
  if (!freeText) {
    // Hard grounding gate for extracted values.
    if (!isGroundedInProfile(answer, evidence)) return null
  }
  return {
    value: answer.slice(0, effectiveLimit),
    free_text: freeText,
    grounded_in: groundedIn,
    // Surfaced so a run can be audited for silent truncation: if these differ,
    // the model overran the portal's stated budget and the answer was cut.
    char_limit: effectiveLimit,
    char_limit_source: declaredLimit ? 'portal' : 'default',
    truncated: answer.length > effectiveLimit,
  }
}
