// Git-truth guards, 2026-08-24.
//
// The nightly runner tests each app's LOCAL working tree while the owner's
// policy is "done means merged to origin/main" — so a fix merged on GitHub was
// never what the nightly tested (~/GrantFlow sat on a feature branch,
// ~/incognito was behind main and dirty) and findings recurred with no
// explanation. These tests pin the two behaviors that fix that:
//
//   1. CAPTURE is honest: fetch failure is tolerated (offline runner), an
//      unknown dirty state never reads as clean, and stale reasons name the
//      exact divergence.
//   2. AUTO-SYNC is narrow: a fast-forward pull happens ONLY for a clean
//      main/master tree that is merely behind. A dirty tree or another branch
//      is another agent's live WIP and is NEVER touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  captureGitState,
  staleTreeReasons,
  maybeFastForward,
  annotateAppResultWithGitState,
  describeGitState,
  isMainBranch,
  prepareTestWorkspace,
  isolatedWorkspacePath,
  isFullCommitSha,
  githubRepoFromRemote,
  runGit,
  runGitProcess,
  ensureWorkspaceDependencies,
} from '../src/gitState.mjs'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

test('GitHub remote identity normalizes HTTPS and SSH spellings exactly', () => {
  assert.equal(githubRepoFromRemote('https://github.com/Buckeye7066/GrantFlow.git'), 'buckeye7066/grantflow')
  assert.equal(githubRepoFromRemote('git@github.com:buckeye7066/GrantFlow.git'), 'buckeye7066/grantflow')
  assert.equal(githubRepoFromRemote('ssh://git@github.com/buckeye7066/GrantFlow'), 'buckeye7066/grantflow')
  assert.equal(githubRepoFromRemote('https://evil.example/buckeye7066/GrantFlow'), null)
})

test('every git subprocess receives only the sanitized runner environment', () => {
  const previousSecret = process.env.EVA_RUNNER_SECRET
  const previousAppEnv = process.env.EVA_APP_ENV
  process.env.EVA_RUNNER_SECRET = 'coordinator-secret-that-must-not-reach-git'
  process.env.EVA_APP_ENV = '{"grantflow":{"DATABASE_URL":"postgres://prod"}}'
  const environments = []
  const exec = (_command, _args, options) => {
    environments.push(options.env)
    return { status: 0, stdout: '', stderr: '' }
  }
  try {
    runGit('C:/fake/repo', ['status'], { exec })
    runGitProcess('C:/fake', ['clone', 'source', 'target'], { exec })
    assert.equal(environments.length, 2)
    for (const env of environments) {
      assert.equal(env.EVA_RUNNER_SECRET, undefined)
      assert.equal(env.EVA_APP_ENV, undefined)
      const inheritedPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
      const processPath = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
      assert.equal(inheritedPath, processPath, 'git still inherits the OS path needed to run helpers')
    }
  } finally {
    if (previousSecret === undefined) delete process.env.EVA_RUNNER_SECRET
    else process.env.EVA_RUNNER_SECRET = previousSecret
    if (previousAppEnv === undefined) delete process.env.EVA_APP_ENV
    else process.env.EVA_APP_ENV = previousAppEnv
  }
})

test('dependency installs use the Windows command shell for fixed package-manager shims', () => {
  const root = mkdtempSync(join(tmpdir(), 'eva-dependency-windows-'))
  const workspace = join(root, 'workspace')
  const dataDir = join(root, 'eva-data')
  const calls = []
  try {
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'package-lock.json'), '{}\n')
    const result = ensureWorkspaceDependencies(workspace, {
      dataDir,
      appId: 'sample-app',
      platform: 'win32',
      exec: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout: '', stderr: '' }
      },
    })

    assert.deepEqual(result.failed, [])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, 'npm')
    assert.deepEqual(calls[0].args, ['ci', '--no-audit', '--no-fund'])
    assert.equal(calls[0].options.shell, true)

    ensureWorkspaceDependencies(workspace, {
      dataDir,
      appId: 'sample-app-posix',
      platform: 'linux',
      exec: (command, args, options) => {
        calls.push({ command, args, options })
        return { status: 0, stdout: '', stderr: '' }
      },
    })
    assert.equal(calls[1].options.shell, false, 'the shell remains disabled outside Windows')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// A fake spawnSync-shaped exec driven by a table of `git <args>` → result.
function fakeExec(table) {
  const calls = []
  const exec = (cmd, args) => {
    calls.push(args.slice(2)) // drop ['-C', cwd]
    const key = args.slice(2).join(' ')
    for (const [prefix, res] of table) {
      if (key === prefix || key.startsWith(prefix)) {
        return { status: res.status ?? 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
      }
    }
    return { status: 1, stdout: '', stderr: `no fake for: ${key}` }
  }
  exec.calls = calls
  return exec
}

const HAPPY_TABLE = (over = {}) => [
  ['rev-parse --is-inside-work-tree', { stdout: 'true' }],
  ['fetch --quiet origin', over.fetch || {}],
  ['rev-parse --abbrev-ref HEAD', { stdout: over.branch ?? 'main' }],
  ['rev-parse HEAD', { stdout: over.sha ?? SHA_A }],
  ['status --porcelain', { stdout: over.porcelain ?? '' }],
  ['rev-parse --verify --quiet origin/main', over.noMain ? { status: 1 } : { stdout: 'deadbeef' }],
  ['rev-parse --verify --quiet origin/master', over.master ? { stdout: 'deadbeef' } : { status: 1 }],
  ['rev-list --left-right --count', { stdout: over.leftRight ?? '0\t0' }],
]

test('captures branch, sha, dirty and behind/ahead against origin/main', () => {
  const exec = fakeExec(HAPPY_TABLE({ branch: 'feat/hub-harvester', porcelain: ' M src/x.js', leftRight: '3\t2' }))
  const state = captureGitState('C:/fake/repo', { exec })
  assert.equal(state.available, true)
  assert.equal(state.branch, 'feat/hub-harvester')
  assert.equal(state.sha, SHA_A)
  assert.equal(isFullCommitSha(state.sha), true)
  assert.equal(state.dirty, true)
  assert.equal(state.behind, 3, 'left count = commits only on origin/main = behind')
  assert.equal(state.ahead, 2)
  assert.equal(state.main_ref, 'origin/main')
  assert.equal(state.fetched, true)
})

test('a fetch failure (offline) is tolerated and reported, never fatal', () => {
  const exec = fakeExec(HAPPY_TABLE({ fetch: { status: 128, stderr: 'fatal: unable to access remote' } }))
  const state = captureGitState('C:/fake/repo', { exec })
  assert.equal(state.available, true, 'state is still captured from the last-known remote refs')
  assert.equal(state.fetched, false)
  assert.match(state.fetch_error, /unable to access/)
  assert.equal(state.behind, 0, 'counts still computed against last-known origin/main')
})

test('a non-repo path is unavailable, and unavailable is never stale', () => {
  const exec = fakeExec([['rev-parse --is-inside-work-tree', { status: 128, stderr: 'not a git repository' }]])
  const state = captureGitState('C:/fake/not-a-repo', { exec })
  assert.equal(state.available, false)
  assert.deepEqual(staleTreeReasons(state), [], 'absence of evidence is not drift')
  assert.deepEqual(staleTreeReasons(null), [])
})

test('stale reasons name non-main branch, dirty tree, and behind count', () => {
  const reasons = staleTreeReasons({
    available: true,
    branch: 'feat/hub-harvester',
    sha: 'abc',
    dirty: true,
    behind: 5,
    ahead: 0,
    main_ref: 'origin/main',
  })
  assert.equal(reasons.length, 3)
  assert.match(reasons[0], /feat\/hub-harvester/)
  assert.match(reasons[1], /uncommitted/)
  assert.match(reasons[2], /behind origin\/main by 5/)
  // A clean, current main tree is NOT stale.
  assert.deepEqual(
    staleTreeReasons({ available: true, branch: 'main', sha: 'abc', dirty: false, behind: 0, ahead: 0, main_ref: 'origin/main' }),
    [],
  )
  // Ahead-only on main is not stale either: local commits are the owner's own
  // unpushed work on the shipped branch, and ff-only can never remove them.
  assert.deepEqual(
    staleTreeReasons({ available: true, branch: 'main', sha: 'abc', dirty: false, behind: 0, ahead: 2, main_ref: 'origin/main' }),
    [],
  )
})

test('master counts as a main branch; origin/master is used when origin/main is absent', () => {
  assert.equal(isMainBranch('main'), true)
  assert.equal(isMainBranch('master'), true)
  assert.equal(isMainBranch('develop'), false)
  const exec = fakeExec(HAPPY_TABLE({ branch: 'master', noMain: true, master: true, leftRight: '1\t0' }))
  const state = captureGitState('C:/fake/repo', { exec })
  assert.equal(state.main_ref, 'origin/master')
  assert.equal(state.behind, 1)
})

test('AUTO-SYNC NEVER touches a dirty tree, a non-main branch, or an unknown dirty state', () => {
  const exec = fakeExec([]) // any git invocation would throw the "no fake" error
  const dirty = maybeFastForward('C:/r', { available: true, branch: 'main', dirty: true, behind: 3 }, { exec })
  assert.equal(dirty.attempted, false)
  assert.match(dirty.reason, /dirty tree/)

  const branch = maybeFastForward('C:/r', { available: true, branch: 'feat/x', dirty: false, behind: 3 }, { exec })
  assert.equal(branch.attempted, false)
  assert.match(branch.reason, /non-main branch \(feat\/x\)/)

  const unknown = maybeFastForward('C:/r', { available: true, branch: 'main', dirty: null, behind: 3 }, { exec })
  assert.equal(unknown.attempted, false, 'an UNKNOWN dirty state must refuse — unknown never reads as clean')

  const current = maybeFastForward('C:/r', { available: true, branch: 'main', dirty: false, behind: 0 }, { exec })
  assert.equal(current.attempted, false)

  assert.equal(exec.calls.length, 0, 'no git command ran for any refusal — a refusal never mutates the tree')
})

test('auto-sync fast-forwards ONLY a clean main tree that is behind, with --ff-only', () => {
  const exec = fakeExec([['pull --ff-only --quiet', { status: 0 }]])
  const res = maybeFastForward('C:/r', { available: true, branch: 'main', dirty: false, behind: 2 }, { exec })
  assert.equal(res.attempted, true)
  assert.equal(res.ok, true)
  assert.deepEqual(exec.calls, [['pull', '--ff-only', '--quiet']], 'ff-only is the only mutation ever issued')
})

test('a failed ff-only pull (diverged) is reported, not retried with anything stronger', () => {
  const exec = fakeExec([['pull --ff-only --quiet', { status: 128, stderr: 'fatal: Not possible to fast-forward, aborting.' }]])
  const res = maybeFastForward('C:/r', { available: true, branch: 'main', dirty: false, behind: 2 }, { exec })
  assert.equal(res.attempted, true)
  assert.equal(res.ok, false)
  assert.match(res.error, /Not possible to fast-forward/)
  assert.equal(exec.calls.length, 1, 'exactly one pull — no reset/merge fallback exists')
})

test('a stale source tree keeps its annotation without claiming that source SHA was tested', () => {
  const state = { available: true, branch: 'feat/hub-harvester', sha: SHA_A, dirty: true, behind: 4, ahead: 1, main_ref: 'origin/main' }
  const result = {
    app_id: 'grantflow',
    app_status: 'tested',
    journeys: [
      { journey_id: 'login', status: 'failed', observed_behavior: 'timeout waiting for /login' },
      { journey_id: 'startup', status: 'passed' },
      { journey_id: 'other', status: 'blocked', observed_behavior: 'no adapter' },
    ],
  }
  annotateAppResultWithGitState(result, state)
  assert.equal(result.commit_sha, undefined)
  assert.equal(result.stale_tree, undefined)
  assert.equal(result.git_state, undefined)
  assert.match(result.journeys[0].observed_behavior, /stale_tree/)
  assert.match(result.journeys[0].observed_behavior, /feat\/hub-harvester/)
  assert.match(result.journeys[0].observed_behavior, /NOT origin\/main/)
  assert.match(result.journeys[0].observed_behavior, /^timeout waiting for \/login/, 'the original evidence is preserved, not replaced')
  assert.equal(result.journeys[1].observed_behavior, undefined, 'a passed journey is untouched')
  assert.match(result.journeys[2].observed_behavior, /stale_tree/)
  assert.equal(result.journeys[0].stale_tree, undefined)
  assert.equal(result.journeys[2].stale_tree, undefined)
})

test('a clean isolated tree records only the full schema-supported commit_sha', () => {
  const state = { available: true, branch: 'origin/main', sha: SHA_B, dirty: false, behind: 0, ahead: 0, main_ref: 'origin/main', isolated: true }
  const result = {
    app_id: 'grantflow',
    app_status: 'tested',
    git_state: { legacy: true },
    stale_tree: true,
    journeys: [{ journey_id: 'login', status: 'failed', observed_behavior: 'timeout' }],
  }
  annotateAppResultWithGitState(result, state, { attempted: false, ok: false, reason: 'not behind origin/main' })
  assert.equal(result.stale_tree, undefined)
  assert.equal(result.git_state, undefined)
  assert.equal(result.journeys[0].observed_behavior, 'timeout')
  assert.equal(result.commit_sha, SHA_B)
})

test('an abbreviated or malformed object id is never misrepresented as canonical provenance', () => {
  for (const sha of ['abc123def456', '', null, 'g'.repeat(40)]) {
    const result = { commit_sha: SHA_A, journeys: [] }
    annotateAppResultWithGitState(result, { available: true, branch: 'origin/main', sha, dirty: false, behind: 0, isolated: true })
    assert.equal(result.commit_sha, undefined)
    assert.equal(isFullCommitSha(sha), false)
  }
  assert.equal(isFullCommitSha('c'.repeat(64)), true, 'Git SHA-256 object ids are also complete')
})

test('describeGitState is a one-liner that names the divergence', () => {
  const s = describeGitState({ available: true, branch: 'feat/x', sha: 'abc', dirty: true, behind: 3, ahead: 0, main_ref: 'origin/main' })
  assert.match(s, /feat\/x@abc/)
  assert.match(s, /dirty/)
  assert.match(s, /behind origin\/main by 3/)
  assert.match(describeGitState({ available: false, reason: 'not a git work tree' }), /unavailable/)
})

function realGit(cwd, args) {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr || res.stdout}`)
  return String(res.stdout || '').trim()
}

test('EVA tests an isolated origin/main snapshot while leaving dirty feature work untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'eva-worktree-'))
  const origin = join(root, 'origin.git')
  const source = join(root, 'source')
  const producer = join(root, 'producer')
  const dataDir = join(root, 'eva-data')
  try {
    mkdirSync(origin, { recursive: true })
    realGit(origin, ['init', '--bare'])
    mkdirSync(source, { recursive: true })
    realGit(source, ['init', '-b', 'main'])
    realGit(source, ['config', 'user.email', 'eva@example.test'])
    realGit(source, ['config', 'user.name', 'EVA Test'])
    writeFileSync(join(source, 'app.txt'), 'main-v1\n')
    realGit(source, ['add', 'app.txt'])
    realGit(source, ['commit', '-m', 'main v1'])
    realGit(source, ['remote', 'add', 'origin', origin])
    realGit(source, ['push', '-u', 'origin', 'main'])

    // A real dependency cache lives only in the developer checkout.
    const cacheFile = join(source, 'node_modules', 'fixture', 'index.js')
    mkdirSync(join(source, 'node_modules', 'fixture'), { recursive: true })
    writeFileSync(cacheFile, 'module.exports = 1\n')
    writeFileSync(join(source, '.gitignore'), 'node_modules/\n')
    realGit(source, ['add', '.gitignore'])
    realGit(source, ['commit', '-m', 'ignore dependencies'])
    realGit(source, ['push'])

    realGit(source, ['checkout', '-b', 'feat/live-work'])
    writeFileSync(join(source, 'app.txt'), 'uncommitted feature work\n')

    const dependencyCalls = []
    const first = prepareTestWorkspace(source, 'sample-app', {
      dataDir,
      timeoutMs: 20_000,
      ensureDependencies: (_workspace, options) => {
        dependencyCalls.push(options)
        return { installed: [], reused: [], removed_links: [], failed: [] }
      },
    })
    assert.equal(first.ok, true)
    assert.equal(first.isolated, true)
    assert.equal(first.state.isolated, true)
    assert.equal(first.state.dirty, false)
    assert.equal(dependencyCalls[0].timeoutMs, 15 * 60 * 1000, 'dependency installs keep their own 15-minute budget')
    assert.match(first.state.sha, /^[0-9a-f]{40}$/)
    assert.equal(first.state.sha, realGit(source, ['rev-parse', 'origin/main']))
    const provenance = annotateAppResultWithGitState({ journeys: [] }, first.state, first.sync)
    assert.equal(provenance.commit_sha, first.state.sha, 'the payload names the exact full commit that will run')
    assert.equal(provenance.git_state, undefined)
    assert.equal(provenance.stale_tree, undefined)
    assert.deepEqual(staleTreeReasons(first.state), [])
    assert.equal(readFileSync(join(first.cwd, 'app.txt'), 'utf8'), 'main-v1\n')
    assert.equal(existsSync(join(first.cwd, 'node_modules', 'fixture', 'index.js')), false, 'developer dependencies are never linked into EVA')
    assert.equal(readFileSync(cacheFile, 'utf8'), 'module.exports = 1\n')
    assert.equal(realGit(source, ['branch', '--show-current']), 'feat/live-work')
    assert.match(realGit(source, ['status', '--porcelain']), /app\.txt/, 'developer change remains dirty and untouched')

    // Advance origin/main elsewhere. Reusing the same EVA clone must move only
    // the isolated snapshot; the developer clone is not fetched or mutated.
    realGit(root, ['clone', origin, producer])
    realGit(producer, ['config', 'user.email', 'eva@example.test'])
    realGit(producer, ['config', 'user.name', 'EVA Test'])
    // Bare repositories initialized by older Git may not advertise main HEAD.
    if (realGit(producer, ['branch', '--show-current']) !== 'main') realGit(producer, ['checkout', 'main'])
    writeFileSync(join(producer, 'app.txt'), 'main-v2\n')
    realGit(producer, ['add', 'app.txt'])
    realGit(producer, ['commit', '-m', 'main v2'])
    realGit(producer, ['push', 'origin', 'main'])

    const second = prepareTestWorkspace(source, 'sample-app', { dataDir })
    assert.equal(second.ok, true)
    assert.equal(second.cwd, first.cwd, 'the dedicated clone is safely reused')
    assert.equal(second.state.sha, realGit(producer, ['rev-parse', 'HEAD']))
    assert.notEqual(second.state.sha, first.state.sha, 'a later origin/main commit gets distinct full provenance')
    assert.equal(readFileSync(join(second.cwd, 'app.txt'), 'utf8'), 'main-v2\n')
    assert.equal(existsSync(join(second.cwd, 'node_modules', 'fixture', 'index.js')), false)
    assert.notEqual(realGit(source, ['rev-parse', 'origin/main']), second.state.sha, 'EVA fetch did not update developer Git metadata')
    assert.equal(readFileSync(join(source, 'app.txt'), 'utf8'), 'uncommitted feature work\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('a foreign directory at the derived worktree path is refused, never deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'eva-worktree-collision-'))
  const source = join(root, 'source')
  const dataDir = join(root, 'eva-data')
  try {
    mkdirSync(source, { recursive: true })
    realGit(source, ['init', '-b', 'main'])
    realGit(source, ['config', 'user.email', 'eva@example.test'])
    realGit(source, ['config', 'user.name', 'EVA Test'])
    writeFileSync(join(source, 'app.txt'), 'main\n')
    realGit(source, ['add', 'app.txt'])
    realGit(source, ['commit', '-m', 'main'])
    const collision = isolatedWorkspacePath(dataDir, 'sample-app')
    mkdirSync(collision, { recursive: true })
    writeFileSync(join(collision, 'owner.txt'), 'not EVA\n')
    const result = prepareTestWorkspace(source, 'sample-app', { dataDir })
    assert.equal(result.ok, false)
    assert.match(result.reason, /refused to reuse/)
    assert.equal(existsSync(join(collision, 'owner.txt')), true, 'the foreign directory is untouched')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a junction at the derived worktree path is refused before reset or clean can touch its target', () => {
  const root = mkdtempSync(join(tmpdir(), 'eva-worktree-junction-'))
  const source = join(root, 'source')
  const dataDir = join(root, 'eva-data')
  try {
    mkdirSync(source, { recursive: true })
    realGit(source, ['init', '-b', 'main'])
    realGit(source, ['config', 'user.email', 'eva@example.test'])
    realGit(source, ['config', 'user.name', 'EVA Test'])
    writeFileSync(join(source, 'app.txt'), 'committed\n')
    realGit(source, ['add', 'app.txt'])
    realGit(source, ['commit', '-m', 'main'])
    writeFileSync(join(source, 'app.txt'), 'developer work\n')
    const target = isolatedWorkspacePath(dataDir, 'sample-app')
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir')

    const result = prepareTestWorkspace(source, 'sample-app', { dataDir })
    assert.equal(result.ok, false)
    assert.match(result.reason, /reparse point|escapes EVA ownership/)
    assert.equal(readFileSync(join(source, 'app.txt'), 'utf8'), 'developer work\n')
    assert.match(realGit(source, ['status', '--porcelain']), /app[.]txt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a repointed source origin is refused before an authoritative clone is created', () => {
  const root = mkdtempSync(join(tmpdir(), 'eva-origin-identity-'))
  const source = join(root, 'source')
  const wrongOrigin = join(root, 'wrong-origin.git')
  const dataDir = join(root, 'eva-data')
  try {
    mkdirSync(wrongOrigin, { recursive: true })
    realGit(wrongOrigin, ['init', '--bare'])
    mkdirSync(source, { recursive: true })
    realGit(source, ['init', '-b', 'main'])
    realGit(source, ['config', 'user.email', 'eva@example.test'])
    realGit(source, ['config', 'user.name', 'EVA Test'])
    writeFileSync(join(source, 'app.txt'), 'main\n')
    realGit(source, ['add', 'app.txt'])
    realGit(source, ['commit', '-m', 'main'])
    realGit(source, ['remote', 'add', 'origin', wrongOrigin])

    const result = prepareTestWorkspace(source, 'grantflow', {
      dataDir,
      expectedRepo: 'buckeye7066/GrantFlow',
    })
    assert.equal(result.ok, false)
    assert.match(result.reason, /origin identity mismatch/)
    assert.equal(existsSync(isolatedWorkspacePath(dataDir, 'grantflow')), false)
    assert.equal(readFileSync(join(source, 'app.txt'), 'utf8'), 'main\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
