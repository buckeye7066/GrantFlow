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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, lstatSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { baseLaunchEnv } from './prereq.mjs'

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
  // Store the complete object id. Abbreviated SHAs are useful in human logs,
  // but are not durable provenance: their uniqueness depends on repository
  // size and they cannot be joined reliably to coordinator/GitHub records.
  const shaRes = runGit(localPath, ['rev-parse', 'HEAD'], opts)
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
  if (state.isolated === true && state.dirty === false && (!Number.isFinite(state.behind) || state.behind === 0)) {
    return []
  }
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

// ---------------------------------------------------------------------------
// AUTHORITATIVE TEST WORKSPACES
//
// Merely DESCRIBING a stale local tree did not solve the fleet defect: EVA
// continued to test that stale tree and filed its failures as application
// defects. A developer branch could therefore keep a fixed app red forever.
//
// EVA now prepares a persistent, independent git clone at the authoritative
// main ref and launches the app there. The developer checkout is never reset,
// cleaned, switched, stashed, pulled, or fetched. Reusing the dedicated clone
// keeps dependencies warm. A hard reset plus `git clean -fdx` is safe because
// the clone carries an EVA ownership marker under EVA's data directory; only
// lockfile-validated node_modules caches are explicitly preserved.
// ---------------------------------------------------------------------------

const DEPENDENCY_DIR_NAMES = new Set(['node_modules', '.venv', 'venv'])
const DISCOVERY_SKIP_NAMES = new Set(['.git', '.next', 'dist', 'build', 'coverage', '.cache', '.turbo'])

export function isolatedWorkspacePath(dataDir, appId) {
  if (!dataDir || typeof dataDir !== 'string') return null
  const slug = String(appId || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app'
  const root = resolve(dataDir, 'repositories')
  const candidate = resolve(root, slug)
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (candidate !== root && !candidate.startsWith(rootPrefix)) return null
  return candidate
}

function isRealDirectoryContained(target, root) {
  try {
    // A junction/symlink at either boundary can redirect reset/clean outside
    // EVA's data directory even when Git reports the expected common dir.
    if (lstatSync(root).isSymbolicLink() || lstatSync(target).isSymbolicLink()) return false
    const realRoot = realpathSync(root)
    const realTarget = realpathSync(target)
    const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`
    return realTarget.startsWith(prefix)
  } catch {
    return false
  }
}

export function githubRepoFromRemote(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(?:https:\/\/github[.]com\/|git@github[.]com:|ssh:\/\/git@github[.]com\/)([^/\s]+)\/([^/\s]+?)(?:[.]git)?\/?$/i)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

function canonicalExpectedRepo(value) {
  const text = String(value || '').trim()
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text) ? text.toLowerCase() : null
}

function runGitProcess(cwd, args, { exec = spawnSync, timeoutMs = 180000 } = {}) {
  try {
    const res = exec('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
    return { ok: res?.status === 0, status: res?.status ?? null, stdout: String(res?.stdout || '').trim(), stderr: String(res?.stderr || '').trim() }
  } catch (err) {
    return { ok: false, status: null, stdout: '', stderr: String(err?.message || err) }
  }
}

function sameCloneSource(a, b) {
  const ga = githubRepoFromRemote(a)
  const gb = githubRepoFromRemote(b)
  if (ga || gb) return Boolean(ga && gb && ga === gb)
  try {
    const ra = realpathSync(a)
    const rb = realpathSync(b)
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb
  } catch {
    return String(a) === String(b)
  }
}

/** Remove junctions created by runner versions that linked developer deps. */
export function removeLegacyDependencyLinks(root, { maxDepth = 3, remove = rmSync } = {}) {
  const removed = []
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (DEPENDENCY_DIR_NAMES.has(entry.name)) {
        let linked = entry.isSymbolicLink?.() === true
        try { linked ||= lstatSync(full).isSymbolicLink() } catch { /* raced away */ }
        if (linked) {
          remove(full, { recursive: true, force: true })
          removed.push(full.slice(resolve(root).length).replace(/^[\\/]+/, '').replace(/\\/g, '/'))
        }
        continue
      }
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue
      if (DISCOVERY_SKIP_NAMES.has(entry.name)) continue
      visit(full, depth + 1)
    }
  }
  visit(root, 0)
  return removed
}

export function discoverFrozenDependencyPlans(root, { maxDepth = 3 } = {}) {
  const plans = []
  const visit = (dir, depth) => {
    if (depth > maxDepth) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    const names = new Set(entries.map((entry) => entry.name))
    const relative = dir === resolve(root) ? '.' : dir.slice(resolve(root).length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    if (names.has('package-lock.json') || names.has('npm-shrinkwrap.json')) {
      const lock = names.has('npm-shrinkwrap.json') ? 'npm-shrinkwrap.json' : 'package-lock.json'
      plans.push({ cwd: dir, relative, lockfile: join(dir, lock), dependencyDir: join(dir, 'node_modules'), command: 'npm', args: ['ci', '--no-audit', '--no-fund'] })
    } else if (names.has('pnpm-lock.yaml')) {
      plans.push({ cwd: dir, relative, lockfile: join(dir, 'pnpm-lock.yaml'), dependencyDir: join(dir, 'node_modules'), command: 'corepack', args: ['pnpm', 'install', '--frozen-lockfile'] })
    } else if (names.has('yarn.lock')) {
      let classic = false
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        classic = /^yarn@1[.]/.test(String(pkg?.packageManager || ''))
      } catch { /* default to modern immutable install */ }
      plans.push({ cwd: dir, relative, lockfile: join(dir, 'yarn.lock'), dependencyDir: join(dir, 'node_modules'), command: 'corepack', args: ['yarn', 'install', classic ? '--frozen-lockfile' : '--immutable'] })
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue
      if (DEPENDENCY_DIR_NAMES.has(entry.name) || DISCOVERY_SKIP_NAMES.has(entry.name)) continue
      visit(join(dir, entry.name), depth + 1)
    }
  }
  visit(resolve(root), 0)
  return plans
}

/** Install dependencies in the EVA clone, keyed by its exact lockfile. */
export function ensureWorkspaceDependencies(workspaceRoot, {
  dataDir,
  appId,
  exec = spawnSync,
  timeoutMs = 15 * 60 * 1000,
} = {}) {
  const removedLinks = removeLegacyDependencyLinks(workspaceRoot)
  const result = { installed: [], reused: [], removed_links: removedLinks, failed: [] }
  for (const plan of discoverFrozenDependencyPlans(workspaceRoot)) {
    const lockHash = createHash('sha256').update(readFileSync(plan.lockfile)).digest('hex')
    const markerKey = createHash('sha256').update(`${plan.relative}\n${lockHash}`).digest('hex')
    const marker = join(dataDir, 'dependency-state', String(appId || 'app'), `${markerKey}.ready`)
    if (existsSync(plan.dependencyDir) && existsSync(marker)) {
      result.reused.push(plan.relative)
      continue
    }
    const run = exec(plan.command, plan.args, {
      cwd: plan.cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: baseLaunchEnv(process.env),
    })
    if (!run || run.status !== 0) {
      result.failed.push({
        path: plan.relative,
        command: `${plan.command} ${plan.args.join(' ')}`,
        error: String(run?.stderr || run?.stdout || `exit ${run?.status ?? 'unknown'}`).slice(0, 500),
      })
      continue
    }
    mkdirSync(dirname(marker), { recursive: true })
    writeFileSync(marker, lockHash, 'utf8')
    result.installed.push(plan.relative)
  }
  return result
}

function resolveAuthoritativeRef(repository, opts) {
  for (const branch of ['main', 'master']) {
    const ref = `origin/${branch}`
    if (runGit(repository, ['rev-parse', '--verify', '--quiet', ref], opts).ok) {
      return { ref, authority: ref }
    }
  }
  return null
}

function workspaceFailure(localPath, sourceState, reason, details = {}) {
  const dependencySetup = details.dependency_setup || { installed: [], reused: [], removed_links: [], failed: [] }
  const syncDetails = { ...details }
  delete syncDetails.dependency_setup
  return {
    ok: false,
    isolated: false,
    cwd: localPath,
    state: sourceState,
    reason,
    sync: { attempted: true, ok: false, reason, ...syncDetails },
    dependency_setup: dependencySetup,
  }
}

/**
 * Prepare a clean, exact test snapshot without modifying the source checkout.
 * Returns `{ok, cwd, state, sync, dependency_setup}`. When `ok` is false the
 * caller must not turn results from a stale source tree into app defects.
 */
export function prepareTestWorkspace(localPath, appId, {
  dataDir,
  exec,
  timeoutMs = 180000,
  installDependencies = true,
  expectedRepo = null,
} = {}) {
  const opts = { ...(exec ? { exec } : {}), timeoutMs }
  // Read the developer clone for location/diagnostics only. Fetching and every
  // mutable Git operation happen in EVA's independent clone below.
  const sourceState = captureGitState(localPath, { ...(exec ? { exec } : {}), timeoutMs, fetch: false })
  if (!sourceState.available) {
    if (canonicalExpectedRepo(expectedRepo)) {
      return workspaceFailure(localPath, sourceState, `canonical repository ${expectedRepo} is not available as a local Git clone`)
    }
    // Non-git/local-only apps retain their historical behavior. There is no
    // competing branch/main claim to make their results misleading.
    return {
      ok: true,
      isolated: false,
      cwd: localPath,
      state: sourceState,
      sync: { attempted: false, ok: true, reason: 'non-git app; tested declared local path' },
      dependency_setup: { installed: [], reused: [], removed_links: [], failed: [] },
    }
  }

  const sourceRemote = runGit(localPath, ['remote', 'get-url', 'origin'], opts)
  const expected = canonicalExpectedRepo(expectedRepo)
  if (expected && (!sourceRemote.ok || githubRepoFromRemote(sourceRemote.stdout) !== expected)) {
    return workspaceFailure(localPath, sourceState, `origin identity mismatch: expected ${expectedRepo}, found ${sourceRemote.stdout || 'no origin'}`)
  }
  const cloneSource = sourceRemote.ok && sourceRemote.stdout ? sourceRemote.stdout : localPath

  const target = isolatedWorkspacePath(dataDir, appId)
  if (!target) return workspaceFailure(localPath, sourceState, 'EVA data directory is missing or unsafe')
  mkdirSync(dirname(target), { recursive: true })

  let created = false
  if (existsSync(target)) {
    if (!isRealDirectoryContained(target, dirname(target))) {
      return workspaceFailure(
        localPath,
        sourceState,
        `refused to reuse ${target}: target or repository root is a reparse point or escapes EVA ownership`,
      )
    }
    let marker = null
    try { marker = JSON.parse(readFileSync(join(target, '.git', 'eva-owned.json'), 'utf8')) } catch { /* invalid owner */ }
    const targetRemote = runGit(target, ['remote', 'get-url', 'origin'], opts)
    if (!marker || marker.app_id !== String(appId) || !targetRemote.ok || !sameCloneSource(targetRemote.stdout, cloneSource)) {
      return workspaceFailure(
        localPath,
        sourceState,
        `refused to reuse ${target}: it is not the independently cloned EVA repository for this app`,
      )
    }
  } else {
    const cloned = runGitProcess(dirname(target), ['clone', '--no-checkout', '--no-hardlinks', cloneSource, target], { exec: exec || spawnSync, timeoutMs })
    if (!cloned.ok) {
      return workspaceFailure(
        localPath,
        sourceState,
        `could not create independent EVA clone: ${cloned.stderr || cloned.stdout || 'git clone failed'}`,
      )
    }
    created = true
    if (!isRealDirectoryContained(target, dirname(target))) {
      return workspaceFailure(localPath, sourceState, `new clone did not resolve inside EVA's owned repository root: ${target}`)
    }
    writeFileSync(join(target, '.git', 'eva-owned.json'), JSON.stringify({ app_id: String(appId), expected_repo: expected, clone_source: cloneSource }), 'utf8')
  }

  const fetched = runGit(target, ['fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'], opts)
  if (!fetched.ok) {
    return workspaceFailure(localPath, sourceState, `origin freshness could not be verified in EVA clone: ${fetched.stderr || fetched.stdout || 'git fetch failed'}`)
  }
  const authoritative = resolveAuthoritativeRef(target, opts)
  if (!authoritative) return workspaceFailure(localPath, sourceState, 'no authoritative origin/main or origin/master commit is available')

  const checkout = runGit(target, ['checkout', '--force', '--detach', authoritative.ref], opts)
  if (!checkout.ok) return workspaceFailure(localPath, sourceState, `could not check out ${authoritative.ref}: ${checkout.stderr || checkout.stdout}`)
  const reset = runGit(target, ['reset', '--hard', '--quiet', authoritative.ref], opts)
  if (!reset.ok) {
    return workspaceFailure(localPath, sourceState, `could not reset isolated clone: ${reset.stderr || reset.stdout}`)
  }
  // Remove every ignored/untracked input except the one cache class validated
  // below against the current lockfile. In particular, old .env/database/test
  // state cannot silently survive into a new authoritative run.
  const clean = runGit(target, ['clean', '-fdx', '--quiet', '-e', 'node_modules', '-e', 'node_modules/**'], opts)
  if (!clean.ok) {
    return workspaceFailure(localPath, sourceState, `could not clean isolated clone: ${clean.stderr || clean.stdout}`)
  }
  const trackedStatus = runGit(target, ['status', '--porcelain', '--untracked-files=no'], opts)
  if (!trackedStatus.ok || trackedStatus.stdout) {
    return workspaceFailure(localPath, sourceState, 'isolated clone is not clean after reset')
  }
  const sha = runGit(target, ['rev-parse', 'HEAD'], opts)
  if (!sha.ok || !sha.stdout) {
    return workspaceFailure(localPath, sourceState, 'could not identify isolated clone commit')
  }

  const dependencySetup = installDependencies
    ? ensureWorkspaceDependencies(target, { dataDir, appId, exec: exec || spawnSync, timeoutMs })
    : { installed: [], reused: [], removed_links: [], failed: [] }
  if (dependencySetup.failed.length) {
    const first = dependencySetup.failed[0]
    return workspaceFailure(
      localPath,
      sourceState,
      `frozen dependency install failed at ${first.path}: ${first.error}`,
      { dependency_setup: dependencySetup },
    )
  }
  const state = {
    available: true,
    branch: authoritative.authority,
    sha: sha.stdout,
    dirty: false,
    ahead: 0,
    behind: 0,
    main_ref: authoritative.ref,
    fetched: true,
    fetch_error: null,
    isolated: true,
    source_state: sourceState,
    workspace: target,
  }
  return {
    ok: true,
    isolated: true,
    cwd: target,
    state,
    sync: {
      attempted: true,
      ok: true,
      reason: `prepared independent clean clone of ${authoritative.authority}`,
      created,
      source_path: localPath,
      workspace_path: target,
    },
    dependency_setup: dependencySetup,
  }
}

/** One-line human description for logs and finding text. */
export function describeGitState(state) {
  if (!state) return 'git state not captured'
  if (state.available !== true) return `git state unavailable (${state.reason || 'unknown'})`
  const bits = [`${state.branch || 'unknown-branch'}@${state.sha || 'unknown-sha'}`]
  if (state.isolated) bits.push('isolated clean snapshot')
  if (state.dirty === true) bits.push('dirty')
  if (Number.isFinite(state.behind) && state.behind > 0) bits.push(`behind ${state.main_ref || 'origin/main'} by ${state.behind}`)
  if (Number.isFinite(state.ahead) && state.ahead > 0) bits.push(`ahead by ${state.ahead}`)
  if (state.fetch_error) bits.push('fetch failed (offline?)')
  return bits.join(', ')
}

const BLOCKER_REASON_CAP = 500
const OBSERVED_BEHAVIOR_CAP = 1000

export function isFullCommitSha(value) {
  // SHA-1 repositories use 40 hex characters; Git's SHA-256 repository format
  // uses 64. Both fit the v1 result schema's commit_sha maxLength of 64.
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
}

/**
 * Stamp schema-valid provenance onto an app result. `commit_sha` is the only
 * git-provenance property in eva-result-v1; the former `git_state` and
 * `stale_tree` object properties made otherwise-valid uploads fail because the
 * schema has additionalProperties:false. Stale diagnostics remain visible in
 * the schema-supported blocker/observed text. Mutates and returns `result`.
 */
export function annotateAppResultWithGitState(result, state, sync = null) {
  if (!result || typeof result !== 'object' || !state) return result

  // Scrub legacy fields even if an older caller supplied them. Journey objects
  // also reject unknown properties, so stale_tree must never survive there.
  delete result.git_state
  delete result.stale_tree
  for (const journey of result.journeys || []) {
    if (journey && typeof journey === 'object') delete journey.stale_tree
  }

  // A source checkout SHA is not necessarily what ran. Only the verified
  // isolated snapshot is canonical execution provenance. If snapshot creation
  // failed, omit commit_sha instead of falsely attributing a blocked run to the
  // developer's feature-branch HEAD.
  if (state.isolated === true && isFullCommitSha(state.sha)) result.commit_sha = state.sha.toLowerCase()
  else delete result.commit_sha

  const reasons = staleTreeReasons(state)
  if (!reasons.length) return result

  const note = `[stale_tree: tested ${state.branch || 'unknown'}@${state.sha || 'unknown'} — ${reasons.join('; ')} — the tested tree is NOT origin/main, so a fix merged on GitHub may not be the code that ran]`
  if (result.blocker_reason) {
    result.blocker_reason = `${result.blocker_reason} ${note}`.slice(0, BLOCKER_REASON_CAP)
  }
  for (const j of result.journeys || []) {
    if (j && (j.status === 'failed' || j.status === 'blocked')) {
      j.observed_behavior = `${j.observed_behavior || ''} ${note}`.trim().slice(0, OBSERVED_BEHAVIOR_CAP)
    }
  }
  return result
}
