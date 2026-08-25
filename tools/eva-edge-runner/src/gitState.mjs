// Git truth for the nightly fleet run.
//
// WHY THIS EXISTS
// The runner spawns each app from its LOCAL working tree (registry local_path)
// and, before this module, did NO git operations at all — while the owner's
// policy is "done means merged to origin/main". So a fix merged on GitHub was
// never what the nightly actually tested: ~/GrantFlow sat checked out on a
// feature branch, ~/incognito was behind origin/main with uncommitted changes,
// and findings like "login page timeout, seen 9x, last pass never" recurred
// because the TESTED tree ≠ the SHIPPED tree — a mystery Anya's email could
// never explain because nothing recorded what code ran.
//
// Two responsibilities, deliberately separated:
//
//   CAPTURE (always) — before each app starts, fetch origin (offline is
//   tolerated and reported, never fatal) and record {branch, sha, dirty,
//   ahead/behind origin/main}. The state is attached to the app result so
//   every finding can show WHAT CODE was tested, and a tree that is not
//   main/clean/current gets a visible `stale_tree` annotation in the finding
//   text — persistence is EXPLAINED instead of mysterious.
//
//   SAFE AUTO-SYNC (narrow) — if and ONLY if the tree is CLEAN, on
//   main/master, and merely BEHIND origin/main, fast-forward pull before the
//   app starts, so the nightly tests the shipped tree. A dirty tree or a
//   non-main branch is another agent's live WIP: NEVER touched, only reported.
//   `--ff-only` means a diverged tree can never be rewritten — the pull fails
//   and the state stays honestly stale.
import { spawnSync } from 'node:child_process'

/** Run one git command in a repo. Never throws; timeouts/missing git are results. */
export function runGit(cwd, gitArgs, { timeoutMs = 30000, exec = spawnSync } = {}) {
  try {
    const res = exec('git', ['-C', cwd, ...gitArgs], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    })
    return {
      ok: res.status === 0,
      status: res.status ?? null,
      stdout: String(res.stdout || '').trim(),
      stderr: String(res.stderr || '').trim(),
    }
  } catch (err) {
    return { ok: false, status: null, stdout: '', stderr: String(err?.message || err) }
  }
}

export function isMainBranch(branch) {
  return branch === 'main' || branch === 'master'
}

/**
 * Capture the git state of an app's working tree.
 *
 * Returns `{ available:false, reason }` for a non-repo path (some apps live
 * outside git — that is a fact to report, not an error). For a repo:
 * `{ available:true, branch, sha, dirty, ahead, behind, main_ref, fetched,
 *    fetch_error }` where ahead/behind are counted against origin/main (or
 * origin/master). A fetch failure (offline runner) is tolerated: the counts
 * are then against the last-known remote state and `fetch_error` says so.
 */
export function captureGitState(localPath, { exec, fetch = true, remote = 'origin', timeoutMs } = {}) {
  const opts = { ...(exec ? { exec } : {}), ...(timeoutMs ? { timeoutMs } : {}) }
  if (!localPath || typeof localPath !== 'string') {
    return { available: false, reason: 'no local_path' }
  }
  const inside = runGit(localPath, ['rev-parse', '--is-inside-work-tree'], opts)
  if (!inside.ok || inside.stdout !== 'true') {
    return { available: false, reason: 'not a git work tree' }
  }

  let fetched = false
  let fetchError = null
  if (fetch) {
    const f = runGit(localPath, ['fetch', '--quiet', remote], { ...opts, timeoutMs: opts.timeoutMs || 90000 })
    fetched = f.ok
    if (!f.ok) fetchError = (f.stderr || f.stdout || 'git fetch failed').slice(0, 200)
  }

  const branchRes = runGit(localPath, ['rev-parse', '--abbrev-ref', 'HEAD'], opts)
  const shaRes = runGit(localPath, ['rev-parse', '--short=12', 'HEAD'], opts)
  const porcelain = runGit(localPath, ['status', '--porcelain'], opts)

  let mainRef = null
  for (const cand of [`${remote}/main`, `${remote}/master`]) {
    const v = runGit(localPath, ['rev-parse', '--verify', '--quiet', cand], opts)
    if (v.ok) {
      mainRef = cand
      break
    }
  }

  let ahead = null
  let behind = null
  if (mainRef) {
    // left = commits only on origin/main (we are BEHIND by these),
    // right = commits only on HEAD (we are AHEAD by these).
    const lr = runGit(localPath, ['rev-list', '--left-right', '--count', `${mainRef}...HEAD`], opts)
    if (lr.ok) {
      const parts = lr.stdout.split(/\s+/).map((n) => Number(n))
      if (Number.isFinite(parts[0])) behind = parts[0]
      if (Number.isFinite(parts[1])) ahead = parts[1]
    }
  }

  return {
    available: true,
    branch: branchRes.ok ? branchRes.stdout : null,
    sha: shaRes.ok ? shaRes.stdout : null,
    // `dirty` is tri-state: true/false when porcelain answered, null when it
    // could not — an unknown must never read as "clean".
    dirty: porcelain.ok ? porcelain.stdout.length > 0 : null,
    ahead,
    behind,
    main_ref: mainRef,
    fetched,
    fetch_error: fetchError,
  }
}

/**
 * Why this tree is NOT the shipped origin/main tree. Empty array = not stale.
 * An unavailable state is never stale — absence of evidence is not drift.
 */
export function staleTreeReasons(state) {
  if (!state || state.available !== true) return []
  const reasons = []
  if (state.branch && state.branch !== 'HEAD' && !isMainBranch(state.branch)) {
    reasons.push(`checked out on branch "${state.branch}", not main`)
  }
  if (state.branch === 'HEAD') reasons.push('detached HEAD')
  if (state.dirty === true) reasons.push('uncommitted local changes (dirty tree)')
  if (Number.isFinite(state.behind) && state.behind > 0) {
    reasons.push(`behind ${state.main_ref || 'origin/main'} by ${state.behind} commit(s)`)
  }
  return reasons
}

/**
 * SAFE auto-sync: fast-forward pull, only when every condition holds —
 * clean tree (dirty === false, an UNKNOWN dirty state refuses), on
 * main/master, and behind origin/main. Anything else is refused with the
 * reason named; a refusal never mutates the tree.
 */
export function maybeFastForward(localPath, state, { exec, timeoutMs = 180000 } = {}) {
  if (!state || state.available !== true) {
    return { attempted: false, ok: false, reason: 'git state unavailable' }
  }
  if (!isMainBranch(state.branch)) {
    return { attempted: false, ok: false, reason: `non-main branch (${state.branch || 'unknown'}) — another agent's WIP, never touched` }
  }
  if (state.dirty !== false) {
    return {
      attempted: false,
      ok: false,
      reason: state.dirty === true ? 'dirty tree — never touched' : 'dirty state unknown — never touched',
    }
  }
  if (!(Number.isFinite(state.behind) && state.behind > 0)) {
    return { attempted: false, ok: false, reason: 'not behind origin/main' }
  }
  const opts = { ...(exec ? { exec } : {}), timeoutMs }
  const res = runGit(localPath, ['pull', '--ff-only', '--quiet'], opts)
  return {
    attempted: true,
    ok: res.ok,
    reason: res.ok ? 'fast-forwarded to origin/main' : null,
    error: res.ok ? null : (res.stderr || res.stdout || 'git pull --ff-only failed').slice(0, 200),
  }
}

/** One-line human description for logs and finding text. */
export function describeGitState(state) {
  if (!state) return 'git state not captured'
  if (state.available !== true) return `git state unavailable (${state.reason || 'unknown'})`
  const bits = [`${state.branch || 'unknown-branch'}@${state.sha || 'unknown-sha'}`]
  if (state.dirty === true) bits.push('dirty')
  if (Number.isFinite(state.behind) && state.behind > 0) bits.push(`behind ${state.main_ref || 'origin/main'} by ${state.behind}`)
  if (Number.isFinite(state.ahead) && state.ahead > 0) bits.push(`ahead by ${state.ahead}`)
  if (state.fetch_error) bits.push('fetch failed (offline?)')
  return bits.join(', ')
}

const NOTE_CAP = 600

/**
 * Attach the captured git state (+ auto-sync outcome) to an app result and,
 * when the tree is stale, stamp a VISIBLE `stale_tree` annotation onto the
 * result and into every failed/blocked journey's observed_behavior — that is
 * the text Anya's morning email renders for a finding, so persistence is
 * explained where the owner reads it. A clean/current tree only gains the
 * `git_state` evidence; nothing else changes. Mutates and returns `result`.
 */
export function annotateAppResultWithGitState(result, state, sync = null) {
  if (!result || typeof result !== 'object' || !state) return result
  result.git_state = { ...state, ...(sync ? { auto_sync: sync } : {}) }
  const reasons = staleTreeReasons(state)
  if (!reasons.length) return result

  result.stale_tree = true
  const note = `[stale_tree: tested ${state.branch || 'unknown'}@${state.sha || 'unknown'} — ${reasons.join('; ')} — the tested tree is NOT origin/main, so a fix merged on GitHub may not be the code that ran]`
  if (result.blocker_reason) {
    result.blocker_reason = `${result.blocker_reason} ${note}`.slice(0, NOTE_CAP)
  }
  for (const j of result.journeys || []) {
    if (j && (j.status === 'failed' || j.status === 'blocked')) {
      j.observed_behavior = `${j.observed_behavior || ''} ${note}`.trim().slice(0, NOTE_CAP)
      j.stale_tree = true
    }
  }
  return result
}
