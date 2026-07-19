/**
 * anyaAdversarialRepairLoop — the two-model author↔verifier repair loop.
 *
 * Every test injects authorFn/verifierFn (or the loop's default provider deps)
 * so NOTHING here touches Anthropic/OpenAI or the network. The whole point of
 * the suite is the FAIL-CLOSED discipline: the loop never returns 'clean'
 * without a passing adversarial verdict, and a missing/erroring verifier is
 * 'unverified', never a silent pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  generateVerifiedRepair,
  __testHelpers,
} from '../services/anyaAdversarialRepairLoop.js'
import { isOwnerCaller, invokeTool, listToolMetadata } from '../services/anyaToolRegistry.js'

const OWNER = 'buckeye7066@gmail.com'

/** A well-formed unified diff touching a NON-forbidden backend path. */
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

const FINDING = { title: 'off-by-one', description: 'x should be 2', category: 'logic' }

describe('generateVerifiedRepair — fail-closed loop', () => {
  it('(a) verifier clean on the first pass → status clean, diff returned', async () => {
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: 'const x = 1',
      filePath: 'backend/services/example.js',
      authorFn: async () => goodDiff(),
      verifierFn: async () => ({ verdict: 'clean', residual: [], regressions: [] }),
    })
    expect(res.status).toBe('clean')
    expect(res.diff).toContain('diff --git')
    expect(res.rounds).toBe(1)
    expect(res.paths).toContain('backend/services/example.js')
  })

  it('(b) needs_work then clean → author is re-prompted WITH the residual text', async () => {
    const feedbackSeen = []
    let verifyCall = 0
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: 'const x = 1',
      filePath: 'backend/services/example.js',
      authorFn: async ({ residualFeedback }) => {
        feedbackSeen.push(residualFeedback)
        return goodDiff()
      },
      verifierFn: async () => {
        if (verifyCall++ === 0) {
          return {
            verdict: 'needs_work',
            residual: [{ severity: 'high', title: 'NULL deref on x', problem: 'x may be null before use' }],
            regressions: ['drops the early-return guard'],
          }
        }
        return { verdict: 'clean', residual: [], regressions: [] }
      },
    })
    expect(res.status).toBe('clean')
    expect(res.rounds).toBe(2)
    // Round 1 had no feedback; round 2's author prompt carried the residual.
    expect(feedbackSeen[0]).toBeNull()
    expect(feedbackSeen[1]).toContain('NULL deref on x')
    expect(feedbackSeen[1]).toContain('drops the early-return guard')
  })

  it('(c) verifier throws twice → status unverified, NOT clean, nothing returned', async () => {
    let verifyCalls = 0
    let authorCalls = 0
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: 'const x = 1',
      filePath: 'backend/services/example.js',
      authorFn: async () => {
        authorCalls++
        return goodDiff()
      },
      verifierFn: async () => {
        verifyCalls++
        throw new Error('socket timeout')
      },
    })
    expect(res.status).toBe('unverified')
    expect(res.status).not.toBe('clean')
    expect(res.diff).toBeNull()
    // one round, verify attempted twice (initial + one transport retry)
    expect(verifyCalls).toBe(2)
    expect(authorCalls).toBe(1)
  })

  it('(d) verifier always needs_work → after maxRounds status rejected, no diff', async () => {
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: 'const x = 1',
      filePath: 'backend/services/example.js',
      maxRounds: 2,
      authorFn: async () => goodDiff(),
      verifierFn: async () => ({
        verdict: 'needs_work',
        residual: [{ severity: 'low', title: 'still off', problem: 'not fixed' }],
        regressions: [],
      }),
    })
    expect(res.status).toBe('rejected')
    expect(res.rounds).toBe(2)
    expect(res.diff).toBeNull()
    expect(res.reason).toMatch(/still off|unresolved|problem/i)
  })

  it('(e) missing OPENAI (default verifier unavailable) → unverified (fail closed)', async () => {
    // The default verifier throws a typed error when no OpenAI client exists.
    await expect(
      __testHelpers.defaultVerifierFn(
        { finding: FINDING, diff: goodDiff(), filePath: 'backend/services/example.js' },
        { getOpenAIOptional: () => null },
      ),
    ).rejects.toThrow(/OPENAI|verifier/i)

    // End-to-end: the loop must fail CLOSED to 'unverified', never 'clean'.
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: 'const x = 1',
      filePath: 'backend/services/example.js',
      authorFn: async () => goodDiff(),
      verifierFn: (a) => __testHelpers.defaultVerifierFn(a, { getOpenAIOptional: () => null }),
    })
    expect(res.status).toBe('unverified')
    expect(res.diff).toBeNull()
  })

  it('(f) author diff touches a FORBIDDEN path → rejected via validatePatchForDispatch', async () => {
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: '-- sql',
      filePath: 'backend/db/migrations/999_x.sql',
      authorFn: async () => goodDiff('backend/db/migrations/999_x.sql'),
      // Even a CLEAN adversarial verdict cannot authorize a forbidden path.
      verifierFn: async () => ({ verdict: 'clean', residual: [], regressions: [] }),
    })
    expect(res.status).toBe('rejected')
    expect(res.diff).toBeNull()
    expect(res.reason).toMatch(/protected path|dispatch gate/i)
  })

  it('missing ANTHROPIC (default author unavailable) → no_fix (not unverified, not clean)', async () => {
    const res = await generateVerifiedRepair({
      finding: FINDING,
      fileText: 'const x = 1',
      filePath: 'backend/services/example.js',
      authorFn: (a) => __testHelpers.defaultAuthorFn(a, { getAnthropicOptional: async () => null }),
      verifierFn: async () => ({ verdict: 'clean', residual: [], regressions: [] }),
    })
    expect(res.status).toBe('no_fix')
    expect(res.diff).toBeNull()
  })

  it('a "clean" verdict that still lists problems is treated as needs_work (no self-contradiction pass)', () => {
    const v = __testHelpers.normalizeVerdict({
      verdict: 'clean',
      residual: [{ severity: 'high', title: 't', problem: 'p' }],
      regressions: [],
    })
    expect(v.verdict).toBe('needs_work')
  })
})

describe('owner.adversarial_repair — owner gate (h)', () => {
  it('is hidden from a non-owner admin but shown to the owner', () => {
    const adminTools = listToolMetadata({ isAdmin: true, email: 'other-admin@example.com' }).map((t) => t.name)
    const ownerTools = listToolMetadata({ isAdmin: true, email: OWNER }).map((t) => t.name)
    expect(adminTools).not.toContain('owner.adversarial_repair')
    expect(ownerTools).toContain('owner.adversarial_repair')
    expect(isOwnerCaller({ ctx: { email: OWNER } })).toBe(true)
  })

  it('403s for a non-owner admin at invoke time (server-side gate, before the handler)', async () => {
    await expect(
      invokeTool(
        'owner.adversarial_repair',
        { filePath: 'backend/services/example.js', finding: 'fix it' },
        { ctx: { isAdmin: true, email: 'other-admin@example.com', userId: 'u2' }, user: { role: 'admin', email: 'other-admin@example.com' } },
      ),
    ).rejects.toThrow(/owner account/i)
  })
})

describe('owner.adversarial_repair — edit-lock (g)', () => {
  const REPO_ROOT = path.resolve(process.cwd())
  const LOCK = path.join(REPO_ROOT, '.agent-edit-lock')
  let preexisting = false

  beforeEach(() => {
    preexisting = fs.existsSync(LOCK)
    if (!preexisting) fs.writeFileSync(LOCK, 'test-lock')
  })
  afterEach(() => {
    // Only remove the lock if THIS test created it.
    if (!preexisting && fs.existsSync(LOCK)) fs.rmSync(LOCK)
  })

  async function invokeWithLock(landMode) {
    let fetchCalled = false
    const result = await invokeTool(
      'owner.adversarial_repair',
      {
        // repair a real, readable, non-forbidden file
        filePath: 'backend/services/anyaAdversarialRepairLoop.js',
        finding: 'trivial',
        dryRun: false, // force the land path so the lock check is reached
        landMode,
      },
      {
        ctx: { isAdmin: true, email: OWNER, userId: 'owner1' },
        user: { role: 'admin', email: OWNER },
        // clean author + verifier so the loop returns a verified diff
        authorFn: async () => goodDiff(),
        verifierFn: async () => ({ verdict: 'clean', residual: [], regressions: [] }),
        fetchImpl: async () => {
          fetchCalled = true
          return { status: 204 }
        },
      },
    )
    return { out: result.output, fetchCalled: () => fetchCalled }
  }

  it('refuses to land (PR mode) while `.agent-edit-lock` is held — asserts NO dispatch', async () => {
    const { out, fetchCalled } = await invokeWithLock('pr')
    expect(out.status).toBe('clean')
    expect(out.edit_lock_held).toBe(true)
    expect(out.applied).toBe(false)
    expect(out.dispatched).toBe(false)
    expect(fetchCalled()).toBe(false)
  })

  it('refuses to land (DIRECT mode) while `.agent-edit-lock` is held — asserts NO merge', async () => {
    const { out, fetchCalled } = await invokeWithLock('direct')
    expect(out.status).toBe('clean')
    expect(out.edit_lock_held).toBe(true)
    expect(out.applied).toBe(false)
    expect(out.landed).toBe(false)
    expect(fetchCalled()).toBe(false)
  })
})
