/**
 * Direct-to-main landing, hardened per Sol's review:
 *   - the merge is a BACKEND action gated by a single-use HMAC token + head_sha
 *     binding + fresh-branch requirement (the workflow can NEVER admin-merge),
 *   - only the exact declared patch files may land (assertTreeMatchesDeclared),
 *   - the build gate (release:gates) is never removed.
 * All seams injected; no network, no real DB.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  landVerifiedPatch,
  landPatchDirectToMain,
  resolveDirectLanding,
  assertTreeMatchesDeclared,
  parsePorcelainPaths,
  __testing__,
} from '../services/anyaCodeFixDispatch.js'
import { invokeTool } from '../services/anyaToolRegistry.js'

const OWNER = 'buckeye7066@gmail.com'
const REPO_ROOT = path.resolve(process.cwd())

function goodDiff(file = 'backend/services/example.js') {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1,3 +1,3 @@',
    '-const x = 1',
    '+const x = 2',
    '',
  ].join('\n')
}

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPO: 'buckeye7066/GrantFlow', DIRECT_LAND_TOKEN_SECRET: 's3cr3t' }
const HEAD = 'abc123abc123abc123abc123abc123abc123abcd'

/**
 * Injectable stubs for a happy direct land; override per-test.
 * The merge SHA is read from the PUSHED branch ref (getBranchSha), NOT the
 * poll — the gate run is dispatched on main so its head_sha is main's. Two
 * getBranchSha reads occur (bind, then pre-merge re-check); `shaSeq` supplies
 * them so a head_moved race can be simulated.
 */
function stubs(over = {}) {
  const calls = { merges: [], consumed: [], triggered: [] }
  const used = new Set()
  const shaSeq = over.shaSeq || [HEAD, HEAD]
  let shaReads = 0
  return {
    calls,
    triggerGateRun: over.triggerGateRun || (async (a) => { calls.triggered.push(a); return { ok: true } }),
    pollGateConclusion: over.pollGateConclusion || (async () => ({ conclusion: 'success', runId: 1 })),
    branchExists: over.branchExists || (async () => false),
    getBranchSha: over.getBranchSha || (async () => { const v = shaSeq[Math.min(shaReads, shaSeq.length - 1)]; shaReads += 1; return v }),
    mergeToMain: over.mergeToMain || (async (a) => { calls.merges.push(a); return { ok: true, merged: true, sha: a.sha } }),
    consumeNonce: over.consumeNonce || (async (_db, nonce) => { if (used.has(nonce)) return { ok: false, reason: 'reused' }; used.add(nonce); calls.consumed.push(nonce); return { ok: true } }),
    now: over.now || (() => 1000),
  }
}

describe('resolveDirectLanding (pure routing)', () => {
  it("keeps a 'pr' request on the PR path", () => {
    expect(resolveDirectLanding({ paths: ['backend/services/x.js'], landMode: 'pr', env: {} }).landMode).toBe('pr')
  })
  it("routes a non-critical 'direct' request direct", () => {
    expect(resolveDirectLanding({ paths: ['backend/services/x.js'], landMode: 'direct', env: {} }).landMode).toBe('direct')
  })
  it('downgrades a critical-path direct request to PR (no override)', () => {
    const d = resolveDirectLanding({ paths: ['backend/db/migrations/9.sql'], landMode: 'direct', env: {} })
    expect(d.landMode).toBe('pr')
    expect(d.downgraded).toBe(true)
  })
  it('allows critical direct with ADVERSARIAL_DIRECT_ALLOW_CRITICAL=true', () => {
    const d = resolveDirectLanding({ paths: ['backend/db/migrations/9.sql'], landMode: 'direct', env: { ADVERSARIAL_DIRECT_ALLOW_CRITICAL: 'true' } })
    expect(d.landMode).toBe('direct')
  })
})

describe('assertTreeMatchesDeclared (Sol HIGH #3 — only declared files land)', () => {
  it('passes when only declared files changed', () => {
    const porcelain = ' M backend/services/example.js\n'
    expect(assertTreeMatchesDeclared({ porcelain, expectedPaths: ['backend/services/example.js'] }).ok).toBe(true)
  })
  it('FAILS on an undeclared change (lockfile churn)', () => {
    const porcelain = ' M backend/services/example.js\n M package-lock.json\n'
    const r = assertTreeMatchesDeclared({ porcelain, expectedPaths: ['backend/services/example.js'] })
    expect(r.ok).toBe(false)
    expect(r.unexpected).toContain('package-lock.json')
  })
  it('FAILS when a declared path is itself a forbidden critical path', () => {
    const porcelain = ' M backend/db/migrations/9.sql\n'
    const r = assertTreeMatchesDeclared({ porcelain, expectedPaths: ['backend/db/migrations/9.sql'] })
    expect(r.ok).toBe(false)
    expect(r.forbidden).toContain('backend/db/migrations/9.sql')
  })
  it('parsePorcelainPaths handles renames', () => {
    expect(parsePorcelainPaths('R  a/old.js -> a/new.js\n')).toEqual(['a/old.js', 'a/new.js'])
  })
})

describe('landPatchDirectToMain — token + SHA binding (Sol CRITICAL + HIGH #2)', () => {
  it('happy path: fresh branch + green gate + valid token + matching head → merges with sha', async () => {
    const s = stubs()
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(true)
    expect(res.head_sha).toBe(HEAD)
    expect(s.calls.merges.length).toBe(1)
    expect(s.calls.merges[0].sha).toBe(HEAD) // sha passed so GitHub refuses a moved head
    expect(s.calls.consumed.length).toBe(1)
  })

  it('NO secret → inert (refuse), nothing merges', async () => {
    const s = stubs()
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: { ...ENV, DIRECT_LAND_TOKEN_SECRET: '' }, ...s })
    expect(res.landed).toBe(false)
    expect(res.step).toBe('secret')
    expect(s.calls.merges.length).toBe(0)
  })

  it('pre-existing / reused branch → rejected, nothing merges', async () => {
    const s = stubs({ branchExists: async () => true })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(res.step).toBe('branch')
    expect(s.calls.merges.length).toBe(0)
  })

  it('binds the merge to the PUSHED branch commit, not the dispatch/main sha', async () => {
    // The poll returns NO sha (dispatch run head = main); the pushed commit is
    // read from the branch ref. The merge must be bound to the pushed sha.
    const PUSHED = 'push99push99push99push99push99push99push9'
    const s = stubs({ shaSeq: [PUSHED, PUSHED] })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(true)
    expect(res.head_sha).toBe(PUSHED)
    expect(s.calls.merges[0].sha).toBe(PUSHED)
  })

  it('gates RED → nothing lands (merge never called)', async () => {
    const s = stubs({ pollGateConclusion: async () => ({ conclusion: 'failure', runId: 2 }) })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(res.gate_conclusion).toBe('failure')
    expect(res.error).toMatch(/release:gates/i)
    expect(s.calls.merges.length).toBe(0)
  })

  it('head MOVED between bind and merge → refused (no merge)', async () => {
    const s = stubs({ shaSeq: [HEAD, 'movedmovedmovedmovedmovedmovedmovedmoved'] })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(res.step).toBe('head_moved')
    expect(s.calls.merges.length).toBe(0)
  })

  it('green run but NO pushed commit (ref missing) → refused (cannot bind)', async () => {
    const s = stubs({ getBranchSha: async () => null })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(res.step).toBe('no_pushed_commit')
    expect(s.calls.merges.length).toBe(0)
  })

  it('reused nonce → refused (single-use enforced), no merge', async () => {
    const s = stubs({ consumeNonce: async () => ({ ok: false, reason: 'reused' }) })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(res.step).toBe('nonce')
    expect(s.calls.merges.length).toBe(0)
  })

  it('failed gate-run dispatch → nothing merges', async () => {
    const s = stubs({ triggerGateRun: async () => ({ ok: false, error: 'boom' }) })
    const res = await landPatchDirectToMain({ patch: goodDiff(), env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(res.step).toBe('gate_dispatch')
    expect(s.calls.merges.length).toBe(0)
  })
})

describe('landVerifiedPatch — mode routing', () => {
  it("landMode 'pr' dispatches the PR workflow with land_mode:'pr' + patch_sha256", async () => {
    let body = null
    const res = await landVerifiedPatch({
      patch: goodDiff(),
      landMode: 'pr',
      automerge: true,
      env: ENV,
      fetchImpl: async (_u, opts) => { body = JSON.parse(opts.body); return { status: 204 } },
    })
    expect(res.land_mode).toBe('pr')
    expect(body.inputs.land_mode).toBe('pr')
    expect(body.inputs.automerge).toBe('true')
    expect(typeof body.inputs.patch_sha256).toBe('string')
    expect(body.inputs.patch_sha256.length).toBe(64)
    expect(body.inputs.expected_paths).toContain('backend/services/example.js')
  })

  it("landMode 'direct' + green → merges (never opens a PR via fetch)", async () => {
    const s = stubs()
    let prFetch = false
    const res = await landVerifiedPatch({
      patch: goodDiff(),
      landMode: 'direct',
      env: ENV,
      fetchImpl: async () => { prFetch = true; return { status: 204 } },
      ...s,
    })
    expect(res.land_mode).toBe('direct')
    expect(res.landed).toBe(true)
    expect(s.calls.merges.length).toBe(1)
    expect(prFetch).toBe(false)
  })

  it("landMode 'direct' + gates RED → nothing lands", async () => {
    const s = stubs({ pollGateConclusion: async () => ({ conclusion: 'failure', runId: 9 }) })
    const res = await landVerifiedPatch({ patch: goodDiff(), landMode: 'direct', env: ENV, ...s })
    expect(res.landed).toBe(false)
    expect(s.calls.merges.length).toBe(0)
  })

  it('expected_paths passed to landVerifiedPatch derives the workflow guard set (not the diff)', async () => {
    let body = null
    await landVerifiedPatch({
      patch: goodDiff('backend/services/example.js'),
      landMode: 'pr',
      expectedPaths: ['backend/services/example.js'],
      env: ENV,
      fetchImpl: async (_u, opts) => { body = JSON.parse(opts.body); return { status: 204 } },
    })
    expect(body.inputs.expected_paths).toBe('backend/services/example.js')
  })

  it("landMode 'direct' + CRITICAL path → routed to PR (not direct)", async () => {
    const s = stubs()
    const res = await landVerifiedPatch({
      patch: goodDiff('backend/db/migrations/9_x.sql'),
      landMode: 'direct',
      env: ENV, // ALLOW_CRITICAL not set
      fetchImpl: async () => ({ status: 204 }),
      ...s,
    })
    expect(res.land_mode).toBe('pr')
    expect(res.downgraded_to_pr).toBe(true)
    expect(res.land_note).toMatch(/critical path/i)
    expect(s.calls.merges.length).toBe(0)
  })

  it('CRITICAL + ADVERSARIAL_DIRECT_ALLOW_CRITICAL=true → allowed direct', async () => {
    const s = stubs()
    const res = await landVerifiedPatch({
      patch: goodDiff('backend/db/migrations/9_x.sql'),
      landMode: 'direct',
      env: { ...ENV, ADVERSARIAL_DIRECT_ALLOW_CRITICAL: 'true' },
      ...s,
    })
    expect(res.land_mode).toBe('direct')
    expect(res.landed).toBe(true)
    expect(s.calls.merges.length).toBe(1)
  })
})

describe('defaultTriggerGateRun dispatches gate_only with the guard inputs', () => {
  it("sends land_mode:'gate_only' + branch + patch_sha256 + expected_paths", async () => {
    let body = null
    const r = await __testing__.defaultTriggerGateRun({
      patch: goodDiff(),
      title: 't',
      branch: 'anya-direct/b1',
      env: ENV,
      fetchImpl: async (_u, opts) => { body = JSON.parse(opts.body); return { status: 204 } },
    })
    expect(r.ok).toBe(true)
    expect(body.inputs.land_mode).toBe('gate_only')
    expect(body.inputs.branch).toBe('anya-direct/b1')
    expect(body.inputs.patch_sha256.length).toBe(64)
    expect(body.inputs.expected_paths).toContain('backend/services/example.js')
  })
})

describe('owner.adversarial_repair — unverified verdict + direct lands NOTHING', () => {
  it('a throwing verifier yields "unverified" and never dispatches, even in direct mode', async () => {
    const lock = path.join(REPO_ROOT, '.agent-edit-lock')
    const lockPresent = fs.existsSync(lock)
    let fetchCalled = false
    const result = await invokeTool(
      'owner.adversarial_repair',
      { filePath: 'backend/services/anyaAdversarialRepairLoop.js', finding: 'x', dryRun: false, landMode: 'direct' },
      {
        ctx: { isAdmin: true, email: OWNER, userId: 'o' },
        user: { role: 'admin', email: OWNER },
        authorFn: async () => goodDiff(),
        verifierFn: async () => { throw new Error('verifier down') },
        fetchImpl: async () => { fetchCalled = true; return { status: 204 } },
      },
    )
    const out = result.output
    if (!lockPresent) expect(out.status).toBe('unverified')
    expect(out.applied).toBe(false)
    expect(out.landed).toBeFalsy()
    expect(fetchCalled).toBe(false)
  })
})

// Structural: the workflow has NO admin-merge; gate_only enforces the guards.
describe('anya-code-fix-pr.yml structural safety', () => {
  const wfPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows', 'anya-code-fix-pr.yml')
  const yaml = fs.readFileSync(wfPath, 'utf8')

  it('contains NO admin merge anywhere (a raw dispatch can never admin-merge)', () => {
    expect(yaml).not.toMatch(/--admin/)
  })

  it('runs release:gates before any push, and gate_only requires expected_paths', () => {
    const gatesIdx = yaml.indexOf('release:gates')
    const pushIdx = yaml.indexOf('git push origin')
    expect(gatesIdx).toBeGreaterThan(-1)
    expect(gatesIdx).toBeLessThan(pushIdx)
    expect(yaml).toMatch(/gate_only requires expected_paths/i)
  })

  it('uses npm ci with NO npm install fallback, asserts declared files, binds patch sha', () => {
    expect(yaml).toMatch(/npm ci --include=optional\s*$/m)
    expect(yaml).not.toMatch(/npm ci.*\|\|\s*npm install/)
    expect(yaml).toMatch(/assert-direct-land-tree\.mjs/)
    expect(yaml).toMatch(/patch_sha256/)
  })

  it('sets a run-name embedding the branch so the backend can correlate the run', () => {
    expect(yaml).toMatch(/^run-name:.*inputs\.branch/m)
  })
})
