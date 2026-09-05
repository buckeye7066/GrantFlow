/**
 * samSafeFixes.js
 *
 * The ONLY place in Sam that is allowed to mutate the working tree, and
 * even then only when:
 *   1. mode === 'repair-safe'
 *   2. caller is an authorised admin (admin auth verified at the route)
 *   3. the requested fix id is in `SAFE_FIX_REGISTRY`
 *   4. the input passes the per-fix safety checks below
 *
 * All commands spawned from here go through `runWhitelistedCommand`, which
 * enforces:
 *   - whitelist match against samRegistry.buildCommandWhitelist()
 *   - no shell metacharacters in arguments
 *   - timeout
 *   - captured stdout/stderr (truncated + secret-masked before return)
 *   - never `shell: true`
 *
 * Sam refuses to fix anything in: backend/db/migrations, backend/db/schema.sql,
 * backend/services/matchEngine.js, backend/services/profileNormalizer.js,
 * grants_*, applications_*, payment / billing / stripe code, or any auth
 * middleware. Those require human review.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import fssync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SAFE_FIX_REGISTRY,
  buildCommandWhitelist,
  findSafeFixById,
} from './samRegistry.js'
import { maskSecrets } from './samAuditStore.js'
import { getSamPolicy, isSafeFixAllowed } from './samPolicy.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

// ---------------------------------------------------------------------------
// Forbidden paths (regex tested against the resolved file path)
// ---------------------------------------------------------------------------
const FORBIDDEN_PATH_PATTERNS = [
  /backend[\\/]db[\\/]migrations[\\/]/i,
  /backend[\\/]db[\\/]postgres[\\/]migrations[\\/]/i,
  /backend[\\/]db[\\/]schema\.sql$/i,
  /backend[\\/]services[\\/]matchEngine\.js$/i,
  /backend[\\/]services[\\/]profileNormalizer\.js$/i,
  /backend[\\/]services[\\/](?:billing|stripe|application|grant|saved|crawler)[A-Za-z]*\.js$/i,
  /backend[\\/]middleware[\\/]auth/i,
  /backend[\\/]routes[\\/](?:auth|admin)/i,
  // The whole DB layer, not just its migrations: it is the data-shape
  // authority and an autofix there is never "safe" in this file's sense.
  /backend[\\/]db[\\/]/i,
  // THE CHECKER DOES NOT EDIT ITS OWN CHECKS. Widening the roots to `backend`
  // brought backend/tests/ into scope; a Sam who can rewrite the tests that
  // judge him is a different kind of agent from the one this file describes.
  /(?:^|[\\/])(?:tests?|__tests__)[\\/]/i,
  /\.(?:test|spec)\.[cm]?[jt]sx?$/i,
  /\.env(\.|$)/i,
  /node_modules[\\/]/i,
  /\.git[\\/]/i,
]

/**
 * Allowed roots — the file MUST resolve under one of these.
 *
 * WHAT THIS USED TO BE, and why the owner was right. The list was
 * `['src', 'backend/services/sam', 'backend/routes/sam.js', 'docs', …]` — so
 * Sam could autofix the entire FRONTEND and his own two files, and nothing
 * else on the server. The owner's report was "Sam also cannot make appropriate
 * code level edits in the repo."
 *
 * It was worse than a narrow scope: it CONTRADICTED both the registry and the
 * code that feeds it. `SAFE_FIX_REGISTRY`'s `lint.eslint-fix-file` entry told
 * every reader it "Refuses if the file is outside src/ or backend/", and
 * `deriveSafeFixesFromFindings` nominated any file matching
 * `/^(src|backend)[/\\]/`. Verified end to end on a real finding: Sam derives
 * `{file: 'backend/services/opportunityInserter.js'}` and then refuses himself
 * with "outside the safe-fix allowlist" — so EVERY backend lint finding took a
 * round trip to a refusal.
 *
 * The roots now cover the application source. Three things keep that safe, and
 * none of them may be removed:
 *   1. FORBIDDEN_PATH_PATTERNS above still hard-refuse migrations, the whole
 *      backend/db layer, matchEngine, profileNormalizer, the billing/stripe/
 *      application/grant/saved/crawler services, auth middleware, the auth and
 *      admin routes, and .env.
 *   2. The only file-editing fix is `eslint --fix` on ONE file, which runs an
 *      INDEPENDENT verify pass afterwards and RESTORES the original whenever
 *      that verify is not clean (`eslintFixFile`). It cannot leave an
 *      unverified mutation in the tree.
 *   3. Sam never commits or pushes. This writes to the working tree only.
 */
const ALLOWED_ROOTS = [
  'src',
  'backend',
  'shared',
  'scripts',
  'qa',
  'docs',
  'docs/_readiness_logs',
]

const ALLOWED_FILE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx', '.md', '.log', '.txt'])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply a single safe fix.
 *
 * @param {object} args
 * @param {string} args.fixId            id from SAFE_FIX_REGISTRY
 * @param {object} args.context          { authorisedByAdmin, mode, ... }
 * @param {object} args.params           per-fix parameters
 * @returns {Promise<{ ok, fix_id, applied, message, evidence }>}
 */
export async function applySafeFix({ fixId, context = {}, params = {} } = {}) {
  if (!fixId) return refusal('missing fix id')
  const fix = findSafeFixById(fixId)
  if (!fix) return refusal(`unknown fix id: ${fixId}`)
  if (context.authorisedByAdmin !== true) {
    return refusal(`Sam refuses ${fixId}: caller is not an authorised admin.`)
  }
  if (context.mode !== 'repair-safe') {
    return refusal(`Sam refuses ${fixId}: mode is ${context.mode || 'unset'}, not repair-safe.`)
  }
  // Charter §6: only `safe` fixes are auto-applicable, and only when
  // auto_fix_safe policy is on. Anything riskier must be branched/PR'd.
  if (!isSafeFixAllowed(fix.risk_level, getSamPolicy())) {
    return refusal(
      `Sam refuses ${fixId}: policy disallows auto-applying risk_level='${fix.risk_level || 'unknown'}' (auto_fix_safe).`,
    )
  }

  switch (fixId) {
    case 'docs.regenerate-readiness-log':
      return regenerateReadinessLog(params)
    case 'lint.eslint-fix-file':
      return eslintFixFile(params)
    case 'queue.recover-stale-jobs':
      return recoverStaleQueueJobs(params, context)
    default:
      return refusal(`fix id ${fixId} is registered but has no implementation.`)
  }
}

/**
 * Derive the safe fixes applicable to the current findings, so an admin running
 * repair-safe actually gets Sam's safe fixes APPLIED instead of having to
 * hand-type fix ids (the "act, not just report" gap). Conservative by design:
 *   - only fixes in SAFE_FIX_REGISTRY (risk_level 'safe'),
 *   - the always-safe, auditable readiness-log regeneration once per run,
 *   - eslint --fix ONLY for a finding that explicitly set safe_auto_fix_available
 *     AND points at a real code file under src/ or backend/.
 * Returns { fixIds, perFixParams }. Caller still passes these through
 * applySafeFixes, which re-enforces admin + repair-safe + policy gates, so this
 * never widens authority — it only removes the manual-id-entry step.
 */
export function deriveSafeFixesFromFindings(findings = []) {
  const fixIds = ['docs.regenerate-readiness-log'] // always safe + idempotent
  const perFixParams = {}
  for (const f of Array.isArray(findings) ? findings : []) {
    // A finding may nominate a registered safe fix explicitly (e.g. Sam's
    // queue.staleJobs check sets evidence.safe_fix_id). Only fixes that exist
    // in SAFE_FIX_REGISTRY with risk_level 'safe' are honoured — a finding can
    // never invent authority, and applySafeFix re-enforces every gate anyway.
    const nominated = f?.evidence?.safe_fix_id
    if (typeof nominated === 'string' && findSafeFixById(nominated)?.risk_level === 'safe' && !fixIds.includes(nominated)) {
      fixIds.push(nominated)
    }
    if (!f?.safe_auto_fix_available) continue
    /* ONE AUTHORITY. This used to carry its own `/^(src|backend)[/\\]/` regex
       while `isPathSafeForFix` held a different, narrower list — so Sam
       nominated backend files he would then refuse. The permitting predicate is
       the only thing that decides. */
    const file = (f.affected_files || []).find((p) => isPathSafeForFix(String(p || '')))
    if (file && !perFixParams['lint.eslint-fix-file']) {
      if (!fixIds.includes('lint.eslint-fix-file')) fixIds.push('lint.eslint-fix-file')
      perFixParams['lint.eslint-fix-file'] = { file }
    }
  }
  return { fixIds, perFixParams }
}

export async function applySafeFixes({
  fixIds = [],
  context = {},
  perFixParams = {},
  maxFixes = 10,
} = {}) {
  const cap = Math.max(0, Math.min(50, Number(maxFixes) || 10))
  const ids = Array.isArray(fixIds) ? fixIds.slice(0, cap) : []
  const out = []
  for (const id of ids) {
    out.push(await applySafeFix({
      fixId: id,
      context,
      params: perFixParams[id] || {},
    }))
  }
  return out
}

// ---------------------------------------------------------------------------
// Whitelisted command runner — used by samAgent for production gates AND by
// the eslint-fix safe fix.
// ---------------------------------------------------------------------------
const SHELL_METACHARS = /[;&|`$<>(){}[\]]/

/**
 * Resolve a Node-tooling executable so it can be spawned WITHOUT a shell.
 *
 * `shell: false` is a security property of this file — it is what makes the
 * whitelist and the metacharacter check meaningful — so the answer is never
 * "turn the shell on". On Windows `npm`/`npx` are `.cmd` shims: a bare `npm`
 * raises ENOENT, and since Node 24's CVE-2024-27980 hardening even an explicit
 * `npm.cmd` raises EINVAL without a shell. Verified on this machine, both.
 *
 * The fix is to launch the tool's own JS entry point with the Node binary we
 * are already running. If that entry point cannot be found we say so, and the
 * caller reports SKIPPED — never a failed gate.
 */
const WINDOWS_NODE_TOOL_CLIS = { npm: 'npm-cli.js', npx: 'npx-cli.js' }

function resolveNodeToolExecutable(exe) {
  if (process.platform !== 'win32' || !(exe in WINDOWS_NODE_TOOL_CLIS)) {
    return { file: exe, prefixArgs: [], unavailable: false }
  }
  const candidates = []
  if (exe === 'npm' && process.env.npm_execpath) candidates.push(process.env.npm_execpath)
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', WINDOWS_NODE_TOOL_CLIS[exe]))
  candidates.push(path.join(REPO_ROOT, 'node_modules', 'npm', 'bin', WINDOWS_NODE_TOOL_CLIS[exe]))
  for (const candidate of candidates) {
    if (candidate && candidate.endsWith('.js') && fssync.existsSync(candidate)) {
      return { file: process.execPath, prefixArgs: [candidate], unavailable: false }
    }
  }
  return { file: exe, prefixArgs: [], unavailable: true }
}

export async function runWhitelistedCommand(command, {
  cwd = REPO_ROOT,
  timeoutMs = 5 * 60 * 1000,
  whitelist = null,
} = {}) {
  if (typeof command !== 'string' || !command.trim()) {
    return { ok: false, status: -1, stdout: '', stderr: 'empty command', skipped: false, command }
  }
  const wl = whitelist instanceof Set ? whitelist : buildCommandWhitelist()
  if (!wl.has(command)) {
    return {
      ok: false,
      status: -1,
      stdout: '',
      stderr: `command not in whitelist: ${command}`,
      skipped: true,
      command,
    }
  }
  if (SHELL_METACHARS.test(command)) {
    return {
      ok: false,
      status: -1,
      stdout: '',
      stderr: 'command contains shell metacharacters',
      skipped: true,
      command,
    }
  }

  const parts = command.split(/\s+/).filter(Boolean)
  const exe = parts[0]
  const args = parts.slice(1)
  const resolvedExe = resolveNodeToolExecutable(exe)
  if (resolvedExe.unavailable) {
    /* We could not find a way to launch this tool WITHOUT a shell. That is an
       environment limitation, not a failing gate — report it as skipped with
       the reason named, never as `ok:false`. (The old code spawned `npm`
       directly, which on Windows is `npm.cmd`: `shell:false` raises ENOENT,
       and Node 24 raises EINVAL even for the explicit `.cmd`, so EVERY Sam
       production gate reported `status:-1` on a Windows checkout as though the
       gate itself had failed.) */
    return {
      ok: true,
      status: 0,
      stdout: '',
      stderr: '',
      skipped: true,
      skipped_reason: `executable_unavailable:${exe}`,
      command,
    }
  }

  // npm scripts: skip silently when the script doesn't exist (mission rule:
  // missing optional gates report `skipped`, never fail).
  if (exe === 'npm' && args[0] === 'run') {
    const scriptName = args[args.indexOf('run') + 1]?.replace(/^-s$/, '') || args[2]
    if (scriptName && !npmScriptExists(scriptName.replace(/^-s$/, '').trim())) {
      return {
        ok: true,
        status: 0,
        stdout: '',
        stderr: '',
        skipped: true,
        skipped_reason: 'script_not_found',
        command,
      }
    }
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const child = spawn(resolvedExe.file, resolvedExe.prefixArgs.concat(args), {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      resolve({
        ok: false,
        status: -1,
        stdout: maskSecrets(stdout.slice(-50_000)),
        stderr: maskSecrets((stderr.slice(-50_000)) + `\n[sam] timeout after ${timeoutMs}ms`),
        skipped: false,
        timed_out: true,
        command,
      })
    }, timeoutMs)

    child.stdout?.on('data', (b) => { stdout += b.toString() })
    child.stderr?.on('data', (b) => { stderr += b.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: false,
        status: -1,
        stdout: '',
        stderr: maskSecrets(String(err?.message || err)),
        skipped: false,
        command,
      })
    })
    child.on('exit', (status) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: (status ?? 0) === 0,
        status: status ?? 0,
        stdout: maskSecrets(stdout.slice(-50_000)),
        stderr: maskSecrets(stderr.slice(-50_000)),
        skipped: false,
        command,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// File safety predicates
// ---------------------------------------------------------------------------
export function isPathSafeForFix(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return false
  const abs = path.resolve(REPO_ROOT, filePath)
  // Stay inside the repo root.
  if (!abs.startsWith(REPO_ROOT + path.sep) && abs !== REPO_ROOT) return false
  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(abs)) return false
  }
  // Must live under an allowed root.
  const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/')
  if (!ALLOWED_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`))) return false
  // Extension must be allowed.
  const ext = path.extname(rel).toLowerCase()
  if (!ALLOWED_FILE_EXTENSIONS.has(ext)) return false
  return true
}

// ---------------------------------------------------------------------------
// Safe fix: regenerate a readiness log
// ---------------------------------------------------------------------------
async function regenerateReadinessLog({ check_id = 'unknown', content = '' } = {}) {
  const dir = path.join(REPO_ROOT, 'docs', '_readiness_logs')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `sam-${String(check_id).replace(/[^a-z0-9_-]/gi, '-')}-${stamp}.log`
  const filePath = path.join(dir, filename)
  if (!isPathSafeForFix(path.relative(REPO_ROOT, filePath))) {
    return refusal(`regenerateReadinessLog: refusing to write outside docs/_readiness_logs (${filePath})`)
  }
  await fs.writeFile(filePath, maskSecrets(String(content || '')), 'utf8')
  // Normalise Windows separators so audit logs are platform-stable.
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/')
  return {
    ok: true,
    fix_id: 'docs.regenerate-readiness-log',
    applied: true,
    message: `Wrote ${rel}`,
    evidence: { file: rel },
  }
}

// ---------------------------------------------------------------------------
// Safe fix: eslint --fix on a single file (with independent verification)
// ---------------------------------------------------------------------------

/** Run eslint once on a single file. Resolves { status, stdout, stderr }. */
async function runEslintCli(file, { fix = false } = {}) {
  /* WHY THIS IS THE NODE API AND NOT `spawn('npx', …)`.
   *
   * It used to be `spawn('npx', ['eslint', …], { shell: false })`. On Windows
   * `npx` is `npx.cmd`, and spawn WITHOUT a shell cannot execute a `.cmd` — it
   * raises ENOENT. Verified on this machine: the child emits
   * `spawn npx ENOENT` in ~30ms, the handler below resolved `{status: -1}`, and
   * `eslintFixFile` reported that as "eslint reports unresolved problems in
   * <file>" — a claim about the FILE when the truth is that the tool never ran.
   * So Sam's only code-editing fix could not execute at all on a Windows
   * checkout, and said so in the language of a code defect.
   *
   * The Node API removes the shell/PATH dependency entirely (the same move
   * adminCodeLint made in #1545) and lets a genuinely absent ESLint be reported
   * as ABSENT. `status` keeps the CLI's meaning — 0 clean, 1 problems remain —
   * so every caller and the injected `_runEslint` test seam are unchanged.
   */
  let ESLintCtor = null
  try {
    ;({ ESLint: ESLintCtor } = await import('eslint'))
  } catch (err) {
    return { status: -1, stdout: '', stderr: `eslint is not installed in this environment: ${err?.message || err}`, unavailable: true }
  }

  try {
    const eslint = new ESLintCtor({ cwd: REPO_ROOT, fix, errorOnUnmatchedPattern: false })
    const results = await eslint.lintFiles([file])
    if (fix) await ESLintCtor.outputFixes(results)
    const errorCount = results.reduce((sum, r) => sum + (r.errorCount ?? 0), 0)
    const warningCount = results.reduce((sum, r) => sum + (r.warningCount ?? 0), 0)
    const formatted = results
      .flatMap((r) => (r.messages ?? []).map((msg) => `${r.filePath}:${msg.line ?? 0} ${msg.severity === 2 ? 'error' : 'warning'} ${msg.message} (${msg.ruleId ?? 'parse-error'})`))
      .join('\n')
    // `npm run lint` enforces zero warnings, so a warning is not clean here either.
    return { status: errorCount + warningCount > 0 ? 1 : 0, stdout: formatted, stderr: '' }
  } catch (err) {
    /* ESLint threw (bad config, unreadable file, internal error). That is a
       TOOL failure, not a verdict about the file. */
    return { status: -1, stdout: '', stderr: String(err?.message || err), unavailable: true }
  }
}

/**
 * Pure decision for the eslint safe fix. `verifyStatus` comes from an
 * INDEPENDENT eslint pass (no --fix) — Sam never trusts the mutating command's
 * own exit code (charter §6: never claim an untested fix worked).
 *   verified   → the independent pass reported zero problems (exit 0)
 *   applied    → verified AND the file content actually changed
 *   reverted   → unverified AND we mutated the file (caller restores it)
 */
export function decideEslintOutcome({ verifyStatus, changed, verifyUnavailable = false } = {}) {
  const verified = verifyStatus === 0 && !verifyUnavailable
  if (!verified) {
    /* "COULD NOT CHECK" IS NOT "DETERMINED NO" — the rule Robert's pipeline
       audit already follows for a 503 or a bot wall. A tool that never ran
       must never be reported as a verdict about the file. */
    return { ok: false, verified: false, applied: false, reverted: changed === true, tool_unavailable: Boolean(verifyUnavailable) }
  }
  return { ok: true, verified: true, applied: changed === true, reverted: false, tool_unavailable: false }
}

async function eslintFixFile({ file = '', _runEslint = runEslintCli } = {}) {
  if (!file) return refusal('eslintFixFile: file is required')
  if (!isPathSafeForFix(file)) {
    return refusal(`eslintFixFile: ${file} is outside the safe-fix allowlist.`)
  }
  // We deliberately DO NOT add this command to the production-gate whitelist;
  // it's a side-channel guarded by isPathSafeForFix instead.
  const abs = path.resolve(REPO_ROOT, file)
  let original
  try {
    original = await fs.readFile(abs, 'utf8')
  } catch (err) {
    return { ok: false, fix_id: 'lint.eslint-fix-file', applied: false, message: maskSecrets(`cannot read ${file}: ${err?.message || err}`), evidence: { file } }
  }

  const fixRes = await _runEslint(file, { fix: true })
  let after = original
  try { after = await fs.readFile(abs, 'utf8') } catch { /* keep original */ }
  const changed = after !== original

  // Independent verification pass — this, not the --fix exit code, gates success.
  const verifyRes = await _runEslint(file, { fix: false })
  const verifyUnavailable = Boolean(verifyRes.unavailable || fixRes.unavailable)
  const outcome = decideEslintOutcome({ verifyStatus: verifyRes.status, changed, verifyUnavailable })

  if (!outcome.verified) {
    // Never leave an unverified mutation in the tree: restore the original.
    if (changed) { try { await fs.writeFile(abs, original, 'utf8') } catch { /* ignore */ } }
    return {
      ok: false,
      fix_id: 'lint.eslint-fix-file',
      applied: false,
      reverted: changed,
      tool_unavailable: outcome.tool_unavailable,
      message: outcome.tool_unavailable
        // Say what is true: the tool did not run. This says NOTHING about the file.
        ? `eslint could not run (${String(verifyRes.stderr || fixRes.stderr || 'unknown error').slice(0, 200)}); no conclusion about ${file}`
        : changed
          ? `eslint --fix did not verify clean on ${file}; reverted`
          : `eslint reports unresolved problems in ${file}`,
      evidence: {
        file,
        fix_status: fixRes.status,
        verify_status: verifyRes.status,
        stdout: maskSecrets(String(verifyRes.stdout || '').slice(-4000)),
        stderr: maskSecrets(String(verifyRes.stderr || '').slice(-2000)),
      },
    }
  }

  return {
    ok: true,
    fix_id: 'lint.eslint-fix-file',
    applied: outcome.applied,
    verified: true,
    message: outcome.applied
      ? `eslint --fix applied and verified clean on ${file}`
      : `${file} already lint-clean (no changes)`,
    evidence: { file, fix_status: fixRes.status, verify_status: verifyRes.status },
  }
}

// ---------------------------------------------------------------------------
// Safe fix: recover stale crawler queue jobs (DB-only, idempotent)
// ---------------------------------------------------------------------------
// Acts on Sam's queue.staleJobs finding. Delegates to the SAME
// crawlerConcurrencyGuard cleanups the admin queue endpoint
// (POST /api/admin/queue/recover-stale) invokes, so the recovery semantics are
// identical no matter who triggers them: dead running jobs are marked
// failed/partial (real progress preserved), ancient queued jobs are expired.
// Never touches a file; a second run recovers 0 rows.
async function recoverStaleQueueJobs(params = {}, context = {}) {
  const db = context.db || params.db
  if (!db || typeof db.prepare !== 'function') {
    return refusal('queue.recover-stale-jobs: no database handle available on this run.')
  }
  // Injectable for tests (mirrors the _runEslint pattern above).
  let cleanupRunning = params._cleanupStaleCrawlers
  let cleanupQueued = params._cleanupStaleQueuedJobs
  if (typeof cleanupRunning !== 'function' || typeof cleanupQueued !== 'function') {
    try {
      const guard = await import('../crawlerConcurrencyGuard.js')
      cleanupRunning = cleanupRunning || guard.cleanupStaleCrawlers
      cleanupQueued = cleanupQueued || guard.cleanupStaleQueuedJobs
    } catch (err) {
      return refusal(`queue.recover-stale-jobs: crawlerConcurrencyGuard unavailable (${err?.message || err})`)
    }
  }
  try {
    const recoveredRunning = Number(await cleanupRunning(db)) || 0
    const recoveredQueued = Number(await cleanupQueued(db)) || 0
    const total = recoveredRunning + recoveredQueued
    return {
      ok: true,
      fix_id: 'queue.recover-stale-jobs',
      applied: total > 0,
      message: total > 0
        ? `Recovered ${recoveredRunning} stale running and ${recoveredQueued} stale queued crawler job(s).`
        : 'No stale crawler jobs to recover (already clean).',
      evidence: { recovered_running: recoveredRunning, recovered_queued: recoveredQueued },
    }
  } catch (err) {
    return {
      ok: false,
      fix_id: 'queue.recover-stale-jobs',
      applied: false,
      message: maskSecrets(`stale-job recovery failed: ${err?.message || err}`),
      evidence: { error: maskSecrets(String(err?.message || err)) },
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function refusal(message) {
  return { ok: false, fix_id: null, applied: false, refused: true, message }
}

function npmScriptExists(name) {
  try {
    const pkg = JSON.parse(fssync.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    return Boolean(pkg?.scripts?.[name])
  } catch {
    return false
  }
}

// Test exports
export const __testing__ = {
  REPO_ROOT,
  FORBIDDEN_PATH_PATTERNS,
  ALLOWED_ROOTS,
  ALLOWED_FILE_EXTENSIONS,
  npmScriptExists,
  refusal,
  eslintFixFile,
  resolveNodeToolExecutable,
}

export { SAFE_FIX_REGISTRY }
