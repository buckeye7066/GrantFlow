/**
 * samGit.js
 *
 * Git integration for Sam (charter §6). Lets Sam put applied safe fixes on a
 * dedicated branch + PR instead of mutating main. This is the *mechanism*; the
 * *policy* already lives in samPolicy.js — every commit goes through
 * assertCommitAllowed(), so the charter defaults govern it:
 *
 *   auto_commit_allowed = false  → Sam never commits (default; this whole path
 *                                  is inert until an admin opts in).
 *   direct_main_commit  = false  → Sam never commits to main; it always uses a
 *                                  dedicated `sam/auto-fix-*` branch.
 *
 * Hard safety rules enforced here regardless of policy:
 *   - Only files that pass isPathSafeForFix() are ever staged. NEVER `git add -A`
 *     / `git add .` — Sam stages an explicit, validated pathspec only.
 *   - Branch names are validated (no metacharacters, no `..`).
 *   - Push + PR are a SEPARATE opt-in (SAM_AUTO_OPEN_PR) on top of commit, and a
 *     push/PR failure never invalidates the local commit.
 *   - Everything is injectable (runGit / openPr) so tests — and the default
 *     OFF posture — never touch real git or a real remote.
 *   - stdout/stderr are secret-masked before they appear in any audit.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getSamPolicy, assertCommitAllowed } from './samPolicy.js'
import { isPathSafeForFix } from './samSafeFixes.js'
import { maskSecrets } from './samAuditStore.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')

const SAFE_BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/

export function isSafeBranchName(name) {
  return typeof name === 'string'
    && SAFE_BRANCH_RE.test(name)
    && !name.includes('..')
    && !name.startsWith('-')
}

/** Deterministic, collision-resistant branch for a given run (no Date/random). */
export function buildFixBranchName(runId) {
  const short = String(runId || 'adhoc').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'adhoc'
  return `sam/auto-fix-${short}`
}

/**
 * From a list of applySafeFix results, collect the distinct repo-relative files
 * that were actually applied AND pass the safe-fix path allowlist. Pure.
 */
export function collectCommittableFiles(appliedFixes = []) {
  const seen = new Set()
  for (const f of appliedFixes || []) {
    if (!f || f.applied !== true) continue
    const file = f.evidence?.file
    if (typeof file !== 'string' || !file.trim()) continue
    if (!isPathSafeForFix(file)) continue
    seen.add(file)
  }
  return [...seen]
}

/** Low-level git runner. shell:false — args are passed literally, never a shell. */
function defaultRunGit(args, { cwd = REPO_ROOT, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      resolve({ ok: false, status: -1, stdout: maskSecrets(stdout.slice(-20_000)), stderr: maskSecrets(`${stderr.slice(-20_000)}\n[sam] git timed out`), timed_out: true })
    }, timeoutMs)
    child.stdout?.on('data', (b) => { stdout += b.toString() })
    child.stderr?.on('data', (b) => { stderr += b.toString() })
    child.on('error', (err) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: false, status: -1, stdout: '', stderr: maskSecrets(String(err?.message || err)) }) })
    child.on('exit', (status) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ok: (status ?? 0) === 0, status: status ?? 0, stdout: maskSecrets(stdout.slice(-20_000)), stderr: maskSecrets(stderr.slice(-20_000)) }) })
  })
}

/** Default PR opener — `gh pr create`. Injectable; only called when opted in. */
function defaultOpenPr({ branch, title, body }, { cwd = REPO_ROOT, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('gh', ['pr', 'create', '--base', 'main', '--head', branch, '--title', title, '--body', body], { cwd, shell: false, windowsHide: true })
    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch { /* ignore */ }; resolve({ ok: false, url: null, stderr: 'gh pr create timed out' }) }, timeoutMs)
    child.stdout?.on('data', (b) => { stdout += b.toString() })
    child.stderr?.on('data', (b) => { stderr += b.toString() })
    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, url: null, stderr: maskSecrets(String(err?.message || err)) }) })
    child.on('exit', (status) => {
      clearTimeout(timer)
      const url = (stdout.match(/https?:\/\/\S+/) || [])[0] || null
      resolve({ ok: (status ?? 0) === 0, url, stderr: maskSecrets(stderr.slice(-4000)) })
    })
  })
}

/**
 * Put applied safe fixes on a dedicated branch (and optionally push + open a PR).
 * Returns an audit object; NEVER throws. All git/gh access is injectable.
 *
 * @returns {Promise<{ok:boolean, committed:boolean, skipped?:boolean, reason?:string,
 *                     step?:string, branch?:string, files?:string[], pushed?:boolean,
 *                     pr_url?:string|null, error?:string}>}
 */
export async function gitProposeFixes(db, {
  runId = null,
  appliedFixes = [],
  policy = getSamPolicy(),
  env = process.env,
  runGit = defaultRunGit,
  openPr = defaultOpenPr,
  logger = console,
} = {}) {
  const files = collectCommittableFiles(appliedFixes)
  if (files.length === 0) {
    return { ok: true, committed: false, skipped: true, reason: 'no_committable_files' }
  }

  const branch = buildFixBranchName(runId)
  if (!isSafeBranchName(branch)) {
    return { ok: false, committed: false, reason: 'unsafe_branch_name', branch }
  }

  // Charter gate: never commit unless policy allows; never to main.
  const gate = assertCommitAllowed({ branch }, policy)
  if (!gate.allowed) {
    return { ok: true, committed: false, skipped: true, reason: gate.reason, branch }
  }

  // checkout -b <branch>
  const co = await runGit(['checkout', '-b', branch])
  if (!co.ok) return { ok: false, committed: false, step: 'checkout', branch, error: co.stderr || `git checkout exited ${co.status}` }

  // add -- <validated files only> (NEVER add -A / add .)
  const add = await runGit(['add', '--', ...files])
  if (!add.ok) return { ok: false, committed: false, step: 'add', branch, files, error: add.stderr || `git add exited ${add.status}` }

  const title = `chore(sam): auto-apply ${files.length} safe fix${files.length === 1 ? '' : 'es'}`
  const body = `Sam applied ${files.length} verified safe fix${files.length === 1 ? '' : 'es'} from run ${String(runId || 'adhoc').slice(0, 8)}.\n\nFiles:\n${files.map((f) => `- ${f}`).join('\n')}\n\nEvery fix was independently verified before commit (charter §6). Review before merge.`

  const commit = await runGit(['commit', '-m', title, '-m', body])
  if (!commit.ok) return { ok: false, committed: false, step: 'commit', branch, files, error: commit.stderr || `git commit exited ${commit.status}` }

  logger?.info?.('sam.git.committed', { branch, file_count: files.length, run_id: runId })

  // Push + PR are a separate opt-in; failure here does NOT undo the local commit.
  let pushed = false
  let prUrl = null
  const openPrAllowed = /^(1|true|yes|on)$/i.test(String(env?.SAM_AUTO_OPEN_PR ?? '').trim())
  if (openPrAllowed) {
    const push = await runGit(['push', '-u', 'origin', branch])
    pushed = push.ok === true
    if (pushed) {
      try {
        const pr = await openPr({ branch, title, body })
        prUrl = pr?.url || null
        if (!pr?.ok) logger?.warn?.('sam.git.pr_failed', { branch, stderr: pr?.stderr })
      } catch (err) {
        logger?.warn?.('sam.git.pr_error', { branch, error: String(err?.message || err) })
      }
    } else {
      logger?.warn?.('sam.git.push_failed', { branch, stderr: push.stderr })
    }
  }

  return { ok: true, committed: true, branch, files, pushed, pr_url: prUrl }
}

export const __testing__ = { REPO_ROOT, defaultRunGit, defaultOpenPr }
