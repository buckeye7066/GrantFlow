/**
 * Direct-to-main landing for the adversarial-repair capability.
 *
 * The build gate (release:gates) is NEVER removed — only the human-approval
 * step is, for landMode:'direct'. These tests inject the gate outcome + merge
 * seam so a RED gate provably lands NOTHING, without touching GitHub.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  landVerifiedPatch,
  resolveDirectLanding,
  landPatchDirectToMain,
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

const ENV = { GITHUB_TOKEN: 't', GITHUB_REPO: 'buckeye7066/GrantFlow' }

describe('resolveDirectLanding (pure routing)', () => {
  it("keeps a 'pr' request on the PR path", () => {
    const d = resolveDirectLanding({ paths: ['backend/services/x.js'], landMode: 'pr', env: {} })
    expect(d.landMode).toBe('pr')
    expect(d.downgraded).toBe(false)
  })
  it("routes a non-critical 'direct' request direct", () => {
    const d = resolveDirectLanding({ paths: ['backend/services/x.js'], landMode: 'direct', env: {} })
    expect(d.landMode).toBe('direct')
  })
  it('downgrades a critical-path direct request to PR (no override)', () => {
    const d = resolveDirectLanding({ paths: ['backend/db/migrations/9.sql'], landMode: 'direct', env: {} })
    expect(d.landMode).toBe('pr')
    expect(d.downgraded).toBe(true)
    expect(d.note).toMatch(/critical path/i)
  })
  it('allows a critical-path direct request when ADVERSARIAL_DIRECT_ALLOW_CRITICAL=true', () => {
    const d = resolveDirectLanding({ paths: ['backend/db/migrations/9.sql'], landMode: 'direct', env: { ADVERSARIAL_DIRECT_ALLOW_CRITICAL: 'true' } })
    expect(d.landMode).toBe('direct')
    expect(d.downgraded).toBe(false)
  })
})

describe('landPatchDirectToMain — gate before merge', () => {
  it('gates GREEN → admin-merge to main is invoked; landed', async () => {
    const merges = []
    const res = await landPatchDirectToMain({
      patch: goodDiff(),
      env: ENV,
      triggerGateRun: async () => ({ ok: true }),
      pollGateConclusion: async () => 'success',
      mergeToMain: async (a) => { merges.push(a); return { ok: true, merged: true, pr_number: 7 } },
    })
    expect(res.ok).toBe(true)
    expect(res.landed).toBe(true)
    expect(res.gate_conclusion).toBe('success')
    expect(merges.length).toBe(1)
  })

  it('gates RED → NOTHING lands on main (merge never called), gate failure reported', async () => {
    let merged = false
    const res = await landPatchDirectToMain({
      patch: goodDiff(),
      env: ENV,
      triggerGateRun: async () => ({ ok: true }),
      pollGateConclusion: async () => 'failure',
      mergeToMain: async () => { merged = true; return { ok: true } },
    })
    expect(merged).toBe(false)
    expect(res.landed).toBe(false)
    expect(res.ok).toBe(false)
    expect(res.gate_conclusion).toBe('failure')
    expect(res.error).toMatch(/release:gates/i)
  })

  it('a failed gate-run dispatch lands nothing', async () => {
    let merged = false
    const res = await landPatchDirectToMain({
      patch: goodDiff(),
      env: ENV,
      triggerGateRun: async () => ({ ok: false, error: 'boom' }),
      pollGateConclusion: async () => 'success',
      mergeToMain: async () => { merged = true; return { ok: true } },
    })
    expect(merged).toBe(false)
    expect(res.landed).toBe(false)
    expect(res.step).toBe('gate_dispatch')
  })
})

describe('landVerifiedPatch — mode routing', () => {
  it("landMode 'pr' dispatches the PR workflow with land_mode:'pr'", async () => {
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
  })

  it("landMode 'direct' + clean + gates GREEN → auto-merge (NOT a PR-open)", async () => {
    let merged = false
    let prFetch = false
    const res = await landVerifiedPatch({
      patch: goodDiff(),
      landMode: 'direct',
      env: ENV,
      fetchImpl: async () => { prFetch = true; return { status: 204 } }, // would be the PR dispatch
      triggerGateRun: async () => ({ ok: true }),
      pollGateConclusion: async () => 'success',
      mergeToMain: async () => { merged = true; return { ok: true, merged: true } },
    })
    expect(res.land_mode).toBe('direct')
    expect(res.landed).toBe(true)
    expect(merged).toBe(true)
    expect(prFetch).toBe(false) // never opened a PR
  })

  it("landMode 'direct' + gates RED → nothing lands", async () => {
    let merged = false
    const res = await landVerifiedPatch({
      patch: goodDiff(),
      landMode: 'direct',
      env: ENV,
      triggerGateRun: async () => ({ ok: true }),
      pollGateConclusion: async () => 'failure',
      mergeToMain: async () => { merged = true; return { ok: true } },
    })
    expect(merged).toBe(false)
    expect(res.landed).toBe(false)
    expect(res.error).toMatch(/release:gates/i)
  })

  it("landMode 'direct' + CRITICAL path → routed to PR, NOT direct-merged", async () => {
    let merged = false
    const res = await landVerifiedPatch({
      patch: goodDiff('backend/db/migrations/9_x.sql'),
      landMode: 'direct',
      env: ENV, // ADVERSARIAL_DIRECT_ALLOW_CRITICAL not set
      fetchImpl: async () => ({ status: 204 }),
      triggerGateRun: async () => ({ ok: true }),
      pollGateConclusion: async () => 'success',
      mergeToMain: async () => { merged = true; return { ok: true } },
    })
    expect(res.land_mode).toBe('pr')
    expect(res.downgraded_to_pr).toBe(true)
    expect(res.land_note).toMatch(/critical path/i)
    expect(merged).toBe(false)
  })

  it('CRITICAL path + ADVERSARIAL_DIRECT_ALLOW_CRITICAL=true → allowed direct', async () => {
    let merged = false
    const res = await landVerifiedPatch({
      patch: goodDiff('backend/db/migrations/9_x.sql'),
      landMode: 'direct',
      env: { ...ENV, ADVERSARIAL_DIRECT_ALLOW_CRITICAL: 'true' },
      triggerGateRun: async () => ({ ok: true }),
      pollGateConclusion: async () => 'success',
      mergeToMain: async () => { merged = true; return { ok: true, merged: true } },
    })
    expect(res.land_mode).toBe('direct')
    expect(res.downgraded_to_pr).toBe(false)
    expect(merged).toBe(true)
    expect(res.landed).toBe(true)
  })
})

describe('defaultTriggerGateRun dispatches gate_only', () => {
  it("sends land_mode:'gate_only' + the branch to the workflow", async () => {
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
  })
})

describe('owner.adversarial_repair — unverified verdict + direct lands NOTHING (fail-closed)', () => {
  it('a throwing verifier yields "unverified" and never dispatches, even in direct mode', async () => {
    // Guard: skip if a real edit-lock happens to be present (would short-circuit earlier).
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
    if (lockPresent) {
      // With a lock the verdict would still be unverified — either way nothing lands.
      expect(out.applied).toBe(false)
    } else {
      expect(out.status).toBe('unverified')
    }
    expect(out.applied).toBe(false)
    expect(out.landed).toBeFalsy()
    expect(fetchCalled).toBe(false)
  })
})

// Structural guarantee: the workflow runs release:gates BEFORE any merge step,
// and direct uses --admin. This is what makes "gates RED → nothing lands" hold
// in CI (the gate step failing aborts the job before the branch is pushed).
describe('anya-code-fix-pr.yml structural gate-before-merge', () => {
  const wfPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.github',
    'workflows',
    'anya-code-fix-pr.yml',
  )
  const yaml = fs.readFileSync(wfPath, 'utf8')

  it('runs release:gates before the land/merge step', () => {
    const gatesIdx = yaml.indexOf('release:gates')
    const mergeIdx = yaml.indexOf('gh pr merge')
    expect(gatesIdx).toBeGreaterThan(-1)
    expect(mergeIdx).toBeGreaterThan(-1)
    expect(gatesIdx).toBeLessThan(mergeIdx)
  })

  it('direct mode uses an admin merge and gate_only exits before opening a PR', () => {
    expect(yaml).toMatch(/gh pr merge "\$BRANCH_NAME" --squash --admin/)
    expect(yaml).toMatch(/land_mode/)
    // gate_only short-circuits (exit 0) before `gh pr create`
    const gateOnlyExit = yaml.indexOf('gate_only')
    const prCreate = yaml.indexOf('gh pr create')
    expect(gateOnlyExit).toBeGreaterThan(-1)
    expect(gateOnlyExit).toBeLessThan(prCreate)
  })
})
