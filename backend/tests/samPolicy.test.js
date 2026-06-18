/**
 * Unit tests for Sam's charter §6 automation policy and the test-gated
 * eslint safe fix (backend/services/sam/samPolicy.js + samSafeFixes.js).
 *
 * Proves:
 *   1. Policy defaults match the charter (auto_fix_safe on; commit/main off).
 *   2. isSafeFixAllowed / assertCommitAllowed gate correctly.
 *   3. decideEslintOutcome only reports success on INDEPENDENT verification.
 *   4. eslintFixFile reverts an unverified mutation and never claims it worked.
 *   5. applySafeFix refuses a safe fix when auto_fix_safe policy is disabled.
 */

import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  getSamPolicy,
  isSafeFixAllowed,
  assertCommitAllowed,
} from '../services/sam/samPolicy.js'
import {
  decideEslintOutcome,
  applySafeFix,
  __testing__,
} from '../services/sam/samSafeFixes.js'

const REPO_ROOT = __testing__.REPO_ROOT
const TMP_REL = 'backend/services/sam/__sam_safefix_tmp_test.js'
const TMP_ABS = path.join(REPO_ROOT, TMP_REL)

afterEach(async () => {
  try { await fs.rm(TMP_ABS, { force: true }) } catch { /* ignore */ }
})

describe('getSamPolicy', () => {
  it('uses charter defaults when env is empty', () => {
    const p = getSamPolicy({})
    expect(p).toEqual({
      auto_fix_safe: true,
      auto_branch_risky: true,
      auto_commit_allowed: false,
      direct_main_commit: false,
    })
  })

  it('honors env overrides', () => {
    const p = getSamPolicy({ SAM_AUTO_FIX_SAFE: 'false', SAM_DIRECT_MAIN_COMMIT: 'true' })
    expect(p.auto_fix_safe).toBe(false)
    expect(p.direct_main_commit).toBe(true)
  })
})

describe('isSafeFixAllowed', () => {
  it('allows safe fixes only when auto_fix_safe is on', () => {
    expect(isSafeFixAllowed('safe', { auto_fix_safe: true })).toBe(true)
    expect(isSafeFixAllowed('safe', { auto_fix_safe: false })).toBe(false)
  })
  it('never allows non-safe risk levels', () => {
    expect(isSafeFixAllowed('risky', { auto_fix_safe: true })).toBe(false)
    expect(isSafeFixAllowed(undefined, { auto_fix_safe: true })).toBe(false)
  })
})

describe('assertCommitAllowed', () => {
  it('refuses any commit when auto_commit_allowed is off (default)', () => {
    expect(assertCommitAllowed({ branch: 'feature' }, getSamPolicy({})).allowed).toBe(false)
  })
  it('refuses a main commit unless direct_main_commit is on', () => {
    const policy = { auto_commit_allowed: true, direct_main_commit: false }
    expect(assertCommitAllowed({ branch: 'main' }, policy).allowed).toBe(false)
    expect(assertCommitAllowed({ branch: 'feature' }, policy).allowed).toBe(true)
  })
  it('allows a main commit only when both flags are on', () => {
    const policy = { auto_commit_allowed: true, direct_main_commit: true }
    expect(assertCommitAllowed({ branch: 'main' }, policy).allowed).toBe(true)
  })
})

describe('decideEslintOutcome', () => {
  it('reports success only on a clean independent verify (exit 0)', () => {
    expect(decideEslintOutcome({ verifyStatus: 0, changed: true })).toMatchObject({ ok: true, verified: true, applied: true })
    expect(decideEslintOutcome({ verifyStatus: 0, changed: false })).toMatchObject({ ok: true, verified: true, applied: false })
  })
  it('marks unverified + flags revert when the file was changed but verify failed', () => {
    expect(decideEslintOutcome({ verifyStatus: 1, changed: true })).toMatchObject({ ok: false, verified: false, reverted: true })
    expect(decideEslintOutcome({ verifyStatus: -1, changed: false })).toMatchObject({ ok: false, verified: false, reverted: false })
  })
})

describe('applySafeFix — auto_fix_safe gate', () => {
  it('refuses a safe fix when SAM_AUTO_FIX_SAFE is disabled', async () => {
    const prev = process.env.SAM_AUTO_FIX_SAFE
    process.env.SAM_AUTO_FIX_SAFE = 'false'
    try {
      const res = await applySafeFix({
        fixId: 'docs.regenerate-readiness-log',
        context: { authorisedByAdmin: true, mode: 'repair-safe' },
      })
      expect(res.refused).toBe(true)
      expect(res.message).toMatch(/auto_fix_safe/)
    } finally {
      if (prev === undefined) delete process.env.SAM_AUTO_FIX_SAFE
      else process.env.SAM_AUTO_FIX_SAFE = prev
    }
  })

  it('still refuses non-admin / wrong-mode callers', async () => {
    expect((await applySafeFix({ fixId: 'lint.eslint-fix-file', context: { authorisedByAdmin: false, mode: 'repair-safe' } })).refused).toBe(true)
    expect((await applySafeFix({ fixId: 'lint.eslint-fix-file', context: { authorisedByAdmin: true, mode: 'observe' } })).refused).toBe(true)
  })
})

describe('eslintFixFile — independent verification + revert', () => {
  // Drive the safe fix through applySafeFix with an injected eslint runner so we
  // exercise the real fs read/write/revert without depending on a live eslint.
  async function runFix({ onFixWrite, verifyStatus }) {
    const _runEslint = async (file, { fix } = {}) => {
      if (fix && typeof onFixWrite === 'function') await onFixWrite(TMP_ABS)
      return { status: fix ? 0 : verifyStatus }
    }
    return applySafeFix({
      fixId: 'lint.eslint-fix-file',
      context: { authorisedByAdmin: true, mode: 'repair-safe' },
      params: { file: TMP_REL, _runEslint },
    })
  }

  it('applies + reports verified when the independent pass is clean', async () => {
    await fs.writeFile(TMP_ABS, 'const a = 1\n', 'utf8')
    const res = await runFix({
      onFixWrite: (abs) => fs.writeFile(abs, 'const a = 1;\n', 'utf8'),
      verifyStatus: 0,
    })
    expect(res).toMatchObject({ ok: true, applied: true, verified: true })
    expect(await fs.readFile(TMP_ABS, 'utf8')).toBe('const a = 1;\n')
  })

  it('reverts the mutation when the independent verify fails', async () => {
    const original = 'const a = 1\n'
    await fs.writeFile(TMP_ABS, original, 'utf8')
    const res = await runFix({
      onFixWrite: (abs) => fs.writeFile(abs, 'BROKEN <<<\n', 'utf8'),
      verifyStatus: 1,
    })
    expect(res).toMatchObject({ ok: false, applied: false, reverted: true })
    // The unverified mutation must NOT survive in the tree.
    expect(await fs.readFile(TMP_ABS, 'utf8')).toBe(original)
  })
})
