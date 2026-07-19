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

/**
 * The statuses a caller may LAND (dispatch a PR / merge). Both a fully clean fix
 * and a fix accepted-with-documented-low-impact-residuals are landable; the
 * residuals are surfaced (never hidden) so the owner sees exactly what was
 * accepted. Everything else (unverified/no_fix/rejected) applies NOTHING.
 */
export const LANDABLE_STATUSES = Object.freeze(['clean', 'accepted_with_residuals'])
export function isLandableStatus(status) {
  return LANDABLE_STATUSES.includes(String(status))
}

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
    '',
    'For EACH residual you report, ALSO classify its MATERIALITY with two booleans',
    'so the loop does not burn rounds fixing things that do not matter:',
    '  "realistic_input": true if a REALISTIC input would trigger it — a real user,',
    '    or normal (NON-adversarial, non-hand-crafted) app/LLM output; false if ONLY',
    '    a deliberately-crafted exotic/pathological payload would reach it.',
    '  "affects_goal": true if it affects a CORE goal — security / auth / payment /',
    '    data-integrity, or correctness a user actually experiences; false if it is',
    '    cosmetic, purely theoretical, or goal-irrelevant.',
    'Do NOT inflate materiality: a theoretical edge case that no realistic input',
    'hits AND that touches no core goal must be marked realistic_input:false AND',
    'affects_goal:false. Be honest — over-marking wastes effort, under-marking ships bugs.',
    'Return ONLY JSON of the exact shape:',
    '{"verdict":"clean"|"needs_work",',
    ' "residual":[{"severity":"low"|"medium"|"high","title":string,"problem":string,',
    '   "realistic_input":boolean,"affects_goal":boolean}],',
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

/** Normalize a repo-relative path for a set-equality comparison. Pure. */
export function normalizeRepoPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .trim()
}

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
          // Materiality classification. FAIL CLOSED: a field is only treated as
          // "not material" when the verifier says so EXPLICITLY (=== false). An
          // omitted/unknown classification stays material, so an unclassified
          // residual still blocks/iterates exactly as before this gate existed.
          realistic_input: r?.realistic_input !== false,
          affects_goal: r?.affects_goal !== false,
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

/**
 * Supported materiality thresholds — how strict the "keep iterating" bar is:
 *   'any'      → every residual is material (never accept-with-residuals; the
 *                pre-gate behavior — tighten to this to require a fully clean fix)
 *   'material' → (default) material if a realistic input WOULD trigger it OR it
 *                affects a core goal (security/auth/payment/data-integrity/
 *                user-visible correctness)
 *   'both'     → material only if realistic_input AND affects_goal (loosest)
 */
export const MATERIALITY_THRESHOLDS = Object.freeze(['any', 'material', 'both'])
export const DEFAULT_MATERIALITY = 'material'

/**
 * Is a single residual MATERIAL under the given threshold? A residual is treated
 * as material unless the verifier EXPLICITLY marked both dimensions sub-threshold
 * (normalizeVerdict already fails closed on omitted fields). Pure.
 */
export function isResidualMaterial(residual, threshold = DEFAULT_MATERIALITY) {
  const realistic = residual?.realistic_input !== false
  const goal = residual?.affects_goal !== false
  if (threshold === 'any') return true
  if (threshold === 'both') return realistic && goal
  return realistic || goal // 'material' (default)
}

/**
 * Split a verdict's residuals into material vs minor, and decide whether the
 * loop must keep iterating. Regressions (introduced bugs) are ALWAYS material —
 * a fix that introduces a new bug is never shipped. Pure.
 */
export function assessMateriality(verdict, threshold = DEFAULT_MATERIALITY) {
  const residuals = Array.isArray(verdict?.residual) ? verdict.residual : []
  const regressions = Array.isArray(verdict?.regressions) ? verdict.regressions : []
  const material = residuals.filter((r) => isResidualMaterial(r, threshold))
  const minor = residuals.filter((r) => !isResidualMaterial(r, threshold))
  const hasMaterial = material.length > 0 || regressions.length > 0
  return { material, minor, regressions, hasMaterial }
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
 * @param {string[]} [args.allowedPaths]  TRUSTED target path set. When provided,
 *        a clean diff whose extracted paths are NOT a subset of this set is
 *        REJECTED — a clean verdict cannot authorize edits to a file the caller
 *        never targeted (prompt-injection / author-or-verifier drift). The
 *        caller derives the workflow expected_paths from THIS set, not the diff.
 * @param {'any'|'material'|'both'} [args.materiality='material']  the MATERIALITY
 *        threshold. The loop re-iterates only while a MATERIAL residual remains
 *        (a realistic input WOULD trigger it, or it affects a core goal); when
 *        the only remaining residuals are provably low-impact AND goal-irrelevant
 *        it ACCEPTS the fix and documents them (status 'accepted_with_residuals')
 *        rather than burning rounds. 'any' restores the strict pre-gate behavior.
 * @param {object} [args.logger]
 * @returns {Promise<{status:'clean'|'accepted_with_residuals'|'unverified'|'no_fix'|'rejected',
 *                    diff:string|null, rounds:number, trail:object[],
 *                    reason:string|null, residuals?:object[], paths?:string[]}>}
 */
export async function generateVerifiedRepair({
  finding,
  fileText,
  filePath = null,
  authorFn = (a) => defaultAuthorFn(a),
  verifierFn = (a) => defaultVerifierFn(a),
  maxRounds = 3,
  allowedPaths = null,
  materiality = DEFAULT_MATERIALITY,
  logger = defaultLogger,
} = {}) {
  const trustedSet =
    Array.isArray(allowedPaths) && allowedPaths.length > 0
      ? new Set(allowedPaths.map(normalizeRepoPath))
      : null
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

    // Shared accept-gate: before accepting ANY diff (clean OR
    // accepted-with-residuals) it must pass the SAME dispatch gate (shape +
    // forbidden-path denylist) AND the trusted-target guard. Returns
    // { rejected } to short-circuit, or { paths } when the diff may be accepted.
    const gateDiffForAccept = () => {
      const validation = validatePatchForDispatch(diff)
      if (!validation.ok) {
        trail.push({ round, phase: 'validate', outcome: 'rejected', reason: validation.reason })
        return { rejected: { status: 'rejected', diff: null, rounds: round, trail, reason: `verified diff rejected by dispatch gate: ${validation.reason}` } }
      }
      // Trusted-target guard: the model-authored diff may touch ONLY the paths
      // the caller pre-validated (prompt-injection / author drift).
      if (trustedSet) {
        const outside = validation.paths.map(normalizeRepoPath).filter((p) => !trustedSet.has(p))
        if (outside.length > 0) {
          const uniqueOutside = [...new Set(outside)]
          trail.push({ round, phase: 'validate', outcome: 'rejected', reason: `paths outside trusted set: ${uniqueOutside.join(', ')}` })
          return { rejected: { status: 'rejected', diff: null, rounds: round, trail, reason: `verified diff touches path(s) outside the trusted target set: ${uniqueOutside.join(', ')}` } }
        }
      }
      return { paths: validation.paths }
    }

    if (verdict.verdict === 'clean') {
      const gated = gateDiffForAccept()
      if (gated.rejected) return gated.rejected
      return { status: 'clean', diff, rounds: round, trail, reason: null, residuals: [], paths: gated.paths }
    }

    // ---- MATERIALITY GATE ----
    // Re-iterate ONLY while a MATERIAL residual remains. If the sole remaining
    // residuals are provably low-impact (no realistic input) AND goal-irrelevant,
    // accept the fix and DOCUMENT them — never burn another round on them.
    const { material, minor, regressions, hasMaterial } = assessMateriality(verdict, materiality)
    trail.push({ round, phase: 'materiality', material: material.length, minor: minor.length, regressions: regressions.length, threshold: materiality })

    if (!hasMaterial) {
      const gated = gateDiffForAccept()
      if (gated.rejected) return gated.rejected
      return {
        status: 'accepted_with_residuals',
        diff,
        rounds: round,
        trail,
        reason: `accepted with ${minor.length} documented low-impact residual(s): no realistic input triggers them and they touch no core goal`,
        residuals: minor,
        paths: gated.paths,
      }
    }

    // A MATERIAL issue remains. On the FINAL round this is a real 'rejected'
    // (a material problem is still open); otherwise iterate, feeding ONLY the
    // material issues (+ regressions) back to the author.
    if (round === rounds) {
      return {
        status: 'rejected',
        diff: null,
        rounds,
        trail,
        residuals: minor,
        reason: `verifier still found MATERIAL problem(s) after ${rounds} round(s): ${buildResidualFeedback({ residual: material, regressions }) || 'unresolved material issues'}`,
      }
    }
    residualFeedback = buildResidualFeedback({ residual: material, regressions })
  }

  // Fail-closed net (the final round already returns above for both branches).
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
  normalizeRepoPath,
  isResidualMaterial,
  assessMateriality,
  isLandableStatus,
  MATERIALITY_THRESHOLDS,
  DEFAULT_MATERIALITY,
  defaultAuthorFn,
  defaultVerifierFn,
  MAX_VERIFY_DIFF_CHARS,
  MAX_AUTHOR_FILE_CHARS,
}
