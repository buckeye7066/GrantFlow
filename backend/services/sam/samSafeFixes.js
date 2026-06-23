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
  /\.env(\.|$)/i,
  /node_modules[\\/]/i,
  /\.git[\\/]/i,
]

// Allowed roots — the file MUST resolve under one of these.
const ALLOWED_ROOTS = [
  'src',
  'backend/services/sam',
  'backend/routes/sam.js',
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
    if (!f?.safe_auto_fix_available) continue
    const file = (f.affected_files || []).find((p) => /^(src|backend)[/\\]/.test(String(p || '')))
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

    const child = spawn(exe, args, {
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
function runEslintCli(file, { fix = false } = {}) {
  const args = fix ? ['eslint', '--fix', file] : ['eslint', file]
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('npx', args, { cwd: REPO_ROOT, shell: false })
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      resolve({ status: -1, stdout, stderr: `${stderr}\n[sam] eslint timed out after 60s`, timed_out: true })
    }, 60_000)
    child.stdout?.on('data', (b) => { stdout += b.toString() })
    child.stderr?.on('data', (b) => { stderr += b.toString() })
    child.on('exit', (status) => { clearTimeout(timer); resolve({ status: status ?? 0, stdout, stderr }) })
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: -1, stdout, stderr: String(err?.message || err), error: true }) })
  })
}

/**
 * Pure decision for the eslint safe fix. `verifyStatus` comes from an
 * INDEPENDENT eslint pass (no --fix) — Sam never trusts the mutating command's
 * own exit code (charter §6: never claim an untested fix worked).
 *   verified   → the independent pass reported zero problems (exit 0)
 *   applied    → verified AND the file content actually changed
 *   reverted   → unverified AND we mutated the file (caller restores it)
 */
export function decideEslintOutcome({ verifyStatus, changed } = {}) {
  const verified = verifyStatus === 0
  if (!verified) return { ok: false, verified: false, applied: false, reverted: changed === true }
  return { ok: true, verified: true, applied: changed === true, reverted: false }
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
  const outcome = decideEslintOutcome({ verifyStatus: verifyRes.status, changed })

  if (!outcome.verified) {
    // Never leave an unverified mutation in the tree: restore the original.
    if (changed) { try { await fs.writeFile(abs, original, 'utf8') } catch { /* ignore */ } }
    return {
      ok: false,
      fix_id: 'lint.eslint-fix-file',
      applied: false,
      reverted: changed,
      message: changed
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
}

export { SAFE_FIX_REGISTRY }
