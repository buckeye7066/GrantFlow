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
import {
  captureGitState,
  staleTreeReasons,
  maybeFastForward,
  annotateAppResultWithGitState,
  describeGitState,
  isMainBranch,
} from '../src/gitState.mjs'

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
  ['rev-parse --short=12 HEAD', { stdout: over.sha ?? 'abc123def456' }],
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
  assert.equal(state.sha, 'abc123def456')
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

test('a stale tree stamps stale_tree + the annotation into failed/blocked journey text', () => {
  const state = { available: true, branch: 'feat/hub-harvester', sha: 'abc123', dirty: true, behind: 4, ahead: 1, main_ref: 'origin/main' }
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
  assert.equal(result.stale_tree, true)
  assert.equal(result.git_state.branch, 'feat/hub-harvester')
  assert.match(result.journeys[0].observed_behavior, /stale_tree/)
  assert.match(result.journeys[0].observed_behavior, /feat\/hub-harvester/)
  assert.match(result.journeys[0].observed_behavior, /NOT origin\/main/)
  assert.match(result.journeys[0].observed_behavior, /^timeout waiting for \/login/, 'the original evidence is preserved, not replaced')
  assert.equal(result.journeys[1].observed_behavior, undefined, 'a passed journey is untouched')
  assert.match(result.journeys[2].observed_behavior, /stale_tree/)
})

test('a clean current tree attaches git_state evidence and changes NOTHING else', () => {
  const state = { available: true, branch: 'main', sha: 'abc123', dirty: false, behind: 0, ahead: 0, main_ref: 'origin/main' }
  const result = {
    app_id: 'grantflow',
    app_status: 'tested',
    journeys: [{ journey_id: 'login', status: 'failed', observed_behavior: 'timeout' }],
  }
  annotateAppResultWithGitState(result, state, { attempted: false, ok: false, reason: 'not behind origin/main' })
  assert.equal(result.stale_tree, undefined)
  assert.equal(result.journeys[0].observed_behavior, 'timeout')
  assert.equal(result.git_state.sha, 'abc123')
  assert.equal(result.git_state.auto_sync.reason, 'not behind origin/main')
})

test('describeGitState is a one-liner that names the divergence', () => {
  const s = describeGitState({ available: true, branch: 'feat/x', sha: 'abc', dirty: true, behind: 3, ahead: 0, main_ref: 'origin/main' })
  assert.match(s, /feat\/x@abc/)
  assert.match(s, /dirty/)
  assert.match(s, /behind origin\/main by 3/)
  assert.match(describeGitState({ available: false, reason: 'not a git work tree' }), /unavailable/)
})
