/**
 * anyaAdversarialRepairLoop.js
 *
 * A two-model "author ↔ verifier" adversarial code-repair loop that Anya and
 * Sam use when they propose a repair.
 *
 *   AUTHOR   = "fable" = Claude (Anthropic, called DIRECTLY as the author role,
 *              not the OpenAI fallback backstop). Given a finding + the current
 *              file text, it returns a unified diff.
 *   VERIFIER = "sol"   = OpenAI, called DIRECTLY with an ADVERSARIAL system
 *              prompt: assume the diff is wrong/incomplete and hunt for what it
 *              leaves open, what it breaks, and its edge cases. Returns a
 *              structured JSON verdict.
 *
 * The core discipline is FAIL CLOSED:
 *   - The loop NEVER returns 'clean' without a passing adversarial verdict.
 *   - A verifier TRANSPORT failure (exception / timeout / missing OpenAI key) is
 *     NOT a pass — it retries once, then returns 'unverified'. "Verifier
 *     unavailable" and "verifier found issues" are different outcomes and only
 *     the latter keeps iterating.
 *   - This module is PURE: it never writes the working tree. It only PRODUCES a
 *     verified diff. Applying it is the caller's job, and every apply path
 *     routes through an existing gated mechanism (dispatchCodeFixWorkflow /
 *     gitProposeFixes), never a raw fs.write to main.
 *   - Before returning 'clean', the diff is run through
 *     validatePatchForDispatch (the same shape + forbidden-path gate the CI/PR
 *     dispatcher uses); a malformed or forbidden-path diff becomes 'rejected'.
 *
 * authorFn / verifierFn are INJECTABLE (defaulting to the real provider calls)
 * so tests exercise the loop deterministically, key-free, never touching a
 * provider.
 */

import { getAnthropicOptional, getOpenAIOptional } from '../utils/aiProviders.js'
import { withLLMTimeout } from '../utils/llmTimeout.js'
import { safeParseJSON } from '../utils/safeJson.js'
import { validatePatchForDispatch } from './anyaCodeFixDispatch.js'
import { createLogger } from '../utils/logger.js'

const defaultLogger = createLogger('services:anyaAdversarialRepairLoop')

// Cap the diff we hand the verifier. The verifier judges ONLY the DIFF (never
// two full file copies), so this bounds token cost while keeping the whole
// change visible for a normal repair.
const MAX_VERIFY_DIFF_CHARS = Number(process.env.ADVERSARIAL_MAX_VERIFY_DIFF_CHARS) || 40_000
// How much of the target file the author is shown (mirrors code.suggestPatch).
const MAX_AUTHOR_FILE_CHARS = Number(process.env.ADVERSARIAL_MAX_AUTHOR_FILE_CHARS) || 16_000

// ---------------------------------------------------------------------------
// Prompt builders (pure) — exported for tests + reuse.
// ---------------------------------------------------------------------------

export function buildAuthorSystemPrompt(filePath) {
  return [
    'You are a senior engineer repairing a bug in an existing codebase.',
    'Return ONLY a unified diff patch (no markdown fences, no prose, no explanation).',
    'The diff MUST apply cleanly to the provided file and use correct `a/`+`b/` file paths.',
    'Make the SMALLEST change that fully resolves the finding; do not refactor unrelated code.',
    'If a reviewer previously found the fix incomplete, address every point they raised.',
    filePath ? `Target file: ${filePath}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildAuthorUserPrompt({ finding, fileText, filePath, residualFeedback } = {}) {
  const findingText =
    typeof finding === 'string' ? finding : JSON.stringify(finding ?? {}, null, 2)
  const file = String(fileText ?? '')
  const shownFile =
    file.length > MAX_AUTHOR_FILE_CHARS
      ? `${file.slice(0, MAX_AUTHOR_FILE_CHARS)}\n/* ... truncated ... */\n`
      : file
  return [
    'FINDING TO FIX:',
    findingText,
    '',
    residualFeedback
      ? [
          'A previous attempt was REJECTED by an adversarial reviewer. Your new diff',
          'must resolve ALL of the following unresolved points and introduce none of',
          'the listed regressions:',
          residualFeedback,
          '',
        ].join('\n')
      : '',
    filePath ? `FILE (${filePath}):` : 'FILE:',
    shownFile,
  ]
    .filter((chunk) => chunk !== '')
    .join('\n')
}

export function buildVerifierSystemPrompt() {
  return [
    'You are an ADVERSARIAL code reviewer. Your job is to try to BREAK a proposed',
    'fix, not to approve it. Assume the diff is wrong or incomplete until proven',
    'otherwise. Judge ONLY the unified diff you are given against the stated finding.',
    'Look hard for:',
    '  (a) parts of the finding the diff leaves UNRESOLVED,',
    '  (b) NEW bugs or regressions the diff introduces,',
    '  (c) other variants of the SAME bug class the diff leaves open,',
    '  (d) edge cases the diff mishandles (null/empty/error/async/boundary).',
    'Only return verdict "clean" when you cannot find a single real problem.',
    'Return ONLY JSON of the exact shape:',
    '{"verdict":"clean"|"needs_work",',
    ' "residual":[{"severity":"low"|"medium"|"high","title":string,"problem":string}],',
    ' "regressions":[string]}',
    'residual and regressions MUST be empty when verdict is "clean".',
  ].join('\n')
}

export function buildVerifierUserPrompt({ finding, diff, filePath } = {}) {
  const findingText =
    typeof finding === 'string' ? finding : JSON.stringify(finding ?? {}, null, 2)
  return [
    'FINDING THE DIFF CLAIMS TO FIX:',
    findingText,
    '',
    filePath ? `TARGET FILE: ${filePath}` : '',
    '',
    'PROPOSED UNIFIED DIFF (judge only this):',
    capForVerifier(diff),
  ]
    .filter((chunk) => chunk !== '')
    .join('\n')
}

/** Cap the diff handed to the verifier so a huge patch cannot blow the budget. */
export function capForVerifier(diff) {
  const text = String(diff ?? '')
  if (text.length <= MAX_VERIFY_DIFF_CHARS) return text
  return `${text.slice(0, MAX_VERIFY_DIFF_CHARS)}\n/* ... diff truncated for review ... */\n`
}

// ---------------------------------------------------------------------------
// Normalizers (pure)
// ---------------------------------------------------------------------------

/** Coerce whatever authorFn returned into a trimmed diff string (or ''). */
function normalizeDiff(result) {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result.trim()
  if (typeof result === 'object') {
    const candidate = result.diff ?? result.patch ?? result.text ?? ''
    return String(candidate || '').trim()
  }
  return String(result).trim()
}

/** Coerce a verifier response into a canonical verdict object. */
export function normalizeVerdict(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {}
  const verdict = String(obj.verdict || '').toLowerCase() === 'clean' ? 'clean' : 'needs_work'
  const residual = Array.isArray(obj.residual)
    ? obj.residual
        .map((r) => ({
          severity: String(r?.severity || 'medium').toLowerCase(),
          title: String(r?.title || '').slice(0, 200),
          problem: String(r?.problem || '').slice(0, 1000),
        }))
        .filter((r) => r.title || r.problem)
    : []
  const regressions = Array.isArray(obj.regressions)
    ? obj.regressions.map((r) => String(r || '').slice(0, 500)).filter(Boolean)
    : []
  // Defense: a "clean" verdict that still lists problems is NOT clean. Only an
  // empty-problem clean verdict passes — a model cannot approve while flagging.
  if (verdict === 'clean' && (residual.length > 0 || regressions.length > 0)) {
    return { verdict: 'needs_work', residual, regressions }
  }
  return { verdict, residual, regressions }
}

/** Render a verdict's residual/regressions into feedback text for the author. */
export function buildResidualFeedback(verdict) {
  const v = verdict || {}
  const lines = []
  for (const r of v.residual || []) {
    lines.push(`- [${r.severity}] ${r.title}${r.problem ? `: ${r.problem}` : ''}`)
  }
  for (const reg of v.regressions || []) {
    lines.push(`- [regression] ${reg}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Default provider-backed author (fable / Claude) + verifier (sol / OpenAI).
// Both accept an injectable `deps` so their fail-closed behavior can be tested
// key-free. Missing provider throws a typed error the loop interprets.
// ---------------------------------------------------------------------------

function extractAnthropicText(response) {
  const parts = Array.isArray(response?.content) ? response.content : []
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
    .filter(Boolean)
    .join('\n')
    .trim()
}

export async function defaultAuthorFn(
  { finding, fileText, filePath, residualFeedback } = {},
  deps = {},
) {
  const getAnthropic = deps.getAnthropicOptional || getAnthropicOptional
  const anthropic = await getAnthropic()
  if (!anthropic) {
    const err = new Error('ANTHROPIC_API_KEY not configured — code author (fable/Claude) unavailable')
    err.code = 'AUTHOR_UNAVAILABLE'
    throw err
  }
  const model =
    deps.anthropicModel ||
    process.env.ADVERSARIAL_AUTHOR_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    'claude-haiku-4-5'
  const response = await withLLMTimeout(
    anthropic.messages.create({
      model,
      max_tokens: Number(process.env.ADVERSARIAL_AUTHOR_MAX_TOKENS) || 2000,
      temperature: 0.2,
      system: buildAuthorSystemPrompt(filePath),
      messages: [
        { role: 'user', content: buildAuthorUserPrompt({ finding, fileText, filePath, residualFeedback }) },
      ],
    }),
    { label: 'Adversarial repair author (Claude)' },
  )
  return extractAnthropicText(response)
}

export async function defaultVerifierFn({ finding, diff, filePath } = {}, deps = {}) {
  const getOpenAI = deps.getOpenAIOptional || getOpenAIOptional
  const openai = getOpenAI()
  if (!openai) {
    const err = new Error('OPENAI_API_KEY not configured — adversarial verifier (sol/OpenAI) unavailable')
    err.code = 'VERIFIER_UNAVAILABLE'
    throw err
  }
  const model =
    deps.openaiModel ||
    process.env.ADVERSARIAL_VERIFIER_MODEL ||
    process.env.OPENAI_MODEL ||
    process.env.ANYA_OPENAI_MODEL ||
    'gpt-4o-mini'
  const completion = await withLLMTimeout(
    openai.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: Number(process.env.ADVERSARIAL_VERIFIER_MAX_TOKENS) || 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildVerifierSystemPrompt() },
        { role: 'user', content: buildVerifierUserPrompt({ finding, diff, filePath }) },
      ],
    }),
    { label: 'Adversarial repair verifier (OpenAI)' },
  )
  const raw = String(completion?.choices?.[0]?.message?.content ?? '').trim()
  const parsed = safeParseJSON(raw, null)
  if (!parsed || typeof parsed !== 'object') {
    // No parseable verdict = we did NOT get an adversarial judgment. Treat as a
    // transport-class failure so the loop fails CLOSED (never claims clean).
    const err = new Error('adversarial verifier returned unparseable JSON')
    err.code = 'VERIFIER_BAD_RESPONSE'
    throw err
  }
  return parsed
}

// ---------------------------------------------------------------------------
// The pure loop.
// ---------------------------------------------------------------------------

async function verifyWithRetry(args, { verifierFn, logger, retries = 1 }) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await verifierFn(args)
    } catch (err) {
      lastErr = err
      logger?.warn?.('[adversarialRepair] verifier transport failure', {
        attempt,
        code: err?.code || null,
        error: err?.message || String(err),
      })
    }
  }
  throw lastErr || new Error('verifier failed')
}

/**
 * Produce a verified repair for `finding` against `fileText`.
 *
 * NEVER writes the tree — returns the verified diff for a gated apply path.
 *
 * @param {object} args
 * @param {object|string} args.finding    the bug/instructions to repair
 * @param {string} args.fileText          current contents of the target file
 * @param {string} [args.filePath]        repo-relative path of the target file
 * @param {Function} [args.authorFn]      ({finding,fileText,filePath,residualFeedback,round}) => diff-string
 * @param {Function} [args.verifierFn]    ({finding,diff,filePath}) => {verdict,residual,regressions}
 * @param {number} [args.maxRounds=3]
 * @param {object} [args.logger]
 * @returns {Promise<{status:'clean'|'unverified'|'no_fix'|'rejected',
 *                    diff:string|null, rounds:number, trail:object[],
 *                    reason:string|null, paths?:string[]}>}
 */
export async function generateVerifiedRepair({
  finding,
  fileText,
  filePath = null,
  authorFn = (a) => defaultAuthorFn(a),
  verifierFn = (a) => defaultVerifierFn(a),
  maxRounds = 3,
  logger = defaultLogger,
} = {}) {
  const trail = []
  const rounds = Math.max(1, Number(maxRounds) || 1)
  let residualFeedback = null
  let lastVerdict = null

  for (let round = 1; round <= rounds; round++) {
    // ---- AUTHOR (fable / Claude) ----
    let rawDiff
    try {
      rawDiff = await authorFn({ finding, fileText, filePath, residualFeedback, round })
    } catch (err) {
      // Missing Anthropic key / author call failure → no_fix (NOT a silent pass,
      // NOT unverified — we simply could not produce a candidate).
      trail.push({ round, phase: 'author', outcome: 'unavailable', error: err?.message || String(err) })
      return {
        status: 'no_fix',
        diff: null,
        rounds: round,
        trail,
        reason: `author unavailable: ${err?.message || String(err)}`,
      }
    }

    const diff = normalizeDiff(rawDiff)
    if (!diff) {
      trail.push({ round, phase: 'author', outcome: 'empty' })
      return { status: 'no_fix', diff: null, rounds: round, trail, reason: 'author produced no diff' }
    }
    trail.push({ round, phase: 'author', outcome: 'diff', diff_chars: diff.length })

    // ---- VERIFY (sol / OpenAI, adversarial) ----
    let rawVerdict
    try {
      rawVerdict = await verifyWithRetry({ finding, diff, filePath }, { verifierFn, logger })
    } catch (err) {
      // Transport failure after one retry → FAIL CLOSED. Never 'clean'.
      trail.push({ round, phase: 'verify', outcome: 'transport_failure', error: err?.message || String(err) })
      return {
        status: 'unverified',
        diff: null,
        rounds: round,
        trail,
        reason: `verifier unavailable — cannot confirm the fix is correct: ${err?.message || String(err)}`,
      }
    }

    const verdict = normalizeVerdict(rawVerdict)
    lastVerdict = verdict
    trail.push({
      round,
      phase: 'verify',
      verdict: verdict.verdict,
      residual: verdict.residual,
      regressions: verdict.regressions,
    })

    if (verdict.verdict === 'clean') {
      // Even a clean verdict does not authorize a forbidden/malformed patch.
      // Reuse the SAME gate the CI/PR dispatcher enforces.
      const validation = validatePatchForDispatch(diff)
      if (!validation.ok) {
        trail.push({ round, phase: 'validate', outcome: 'rejected', reason: validation.reason })
        return {
          status: 'rejected',
          diff: null,
          rounds: round,
          trail,
          reason: `verified diff rejected by dispatch gate: ${validation.reason}`,
        }
      }
      return {
        status: 'clean',
        diff,
        rounds: round,
        trail,
        reason: null,
        paths: validation.paths,
      }
    }

    // needs_work → feed the residual back to the author for the next round.
    residualFeedback = buildResidualFeedback(verdict)
  }

  // Exhausted maxRounds without a clean verdict.
  return {
    status: 'rejected',
    diff: null,
    rounds,
    trail,
    reason: `verifier still found problems after ${rounds} round(s): ${
      buildResidualFeedback(lastVerdict) || 'unresolved issues'
    }`,
  }
}

export const __testHelpers = {
  generateVerifiedRepair,
  normalizeVerdict,
  normalizeDiff,
  buildResidualFeedback,
  buildAuthorSystemPrompt,
  buildAuthorUserPrompt,
  buildVerifierSystemPrompt,
  buildVerifierUserPrompt,
  capForVerifier,
  defaultAuthorFn,
  defaultVerifierFn,
  MAX_VERIFY_DIFF_CHARS,
  MAX_AUTHOR_FILE_CHARS,
}
