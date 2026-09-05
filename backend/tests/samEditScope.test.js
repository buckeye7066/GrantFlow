import { describe, it, expect } from 'vitest'

import {
  isPathSafeForFix,
  deriveSafeFixesFromFindings,
  decideEslintOutcome,
  applySafeFix,
  runWhitelistedCommand,
  __testing__,
} from '../services/sam/samSafeFixes.js'
import { SAFE_FIX_REGISTRY, findSafeFixById } from '../services/sam/samRegistry.js'

/**
 * "Sam also cannot make appropriate code level edits in the repo." — owner.
 *
 * Three separate things made that true, all in samSafeFixes.js:
 *
 *  1. THE SCOPE CONTRADICTED ITSELF. `ALLOWED_ROOTS` permitted `src`,
 *     `backend/services/sam`, `backend/routes/sam.js` and `docs` — the whole
 *     frontend and Sam's own two files. Meanwhile the registry entry told every
 *     reader the fix "Refuses if the file is outside src/ or backend/", and
 *     `deriveSafeFixesFromFindings` nominated any file matching
 *     `/^(src|backend)[/\\]/`. Verified end to end before the change: Sam
 *     derived `{file: 'backend/services/opportunityInserter.js'}` and then
 *     refused himself with "outside the safe-fix allowlist", so every backend
 *     lint finding took a round trip to a refusal.
 *
 *  2. ON WINDOWS THE FIX COULD NOT RUN AT ALL. `runEslintCli` used
 *     `spawn('npx', …, { shell: false })`; `npx` is `npx.cmd` there, so spawn
 *     raised ENOENT in ~30ms and `eslintFixFile` reported it as "eslint reports
 *     unresolved problems in <file>" — a claim about the FILE when the tool
 *     never ran. The same root cause hit `runWhitelistedCommand`: `spawn npm
 *     ENOENT` made EVERY Sam production gate report `status:-1` as a failing
 *     gate. (Node 24 raises EINVAL even for an explicit `npm.cmd` without a
 *     shell — and `shell: true` is exactly what this file must not do.)
 *
 *  3. "COULD NOT CHECK" WAS REPORTED AS "DETERMINED NO" — the rule Robert's
 *     pipeline audit already follows for a 503 or a bot wall.
 */

describe('the path authority is one predicate, and it covers the application', () => {
  const ALLOWED = [
    'src/pages/Admin.jsx',
    'backend/services/opportunityInserter.js',
    'backend/services/hamilton/hamiltonAttestationStore.js',
    'backend/routes/profiles.js',
    'backend/crawler-os/planner.js',
    'backend/services/sam/samAgent.js',
    'shared/pipelineStages.js',
    'scripts/generate-env-examples.mjs',
    'qa/build-coverage-matrix.mjs',
    'docs/README.md',
  ]

  const REFUSED = [
    // data-shape authority
    'backend/db/migrations/138_x.sql',
    'backend/db/index.js',
    'backend/db/schema.sql',
    // decision authorities
    'backend/services/matchEngine.js',
    'backend/services/profileNormalizer.js',
    // money + auth
    'backend/services/billingService.js',
    'backend/services/stripeWebhook.js',
    'backend/middleware/auth.js',
    'backend/routes/auth.js',
    'backend/routes/admin.js',
    '.env',
    'node_modules/left-pad/index.js',
    // the checker does not edit its own checks
    'backend/tests/foo.test.js',
    'backend/tests/helper.js',
    'backend/crawler-os/tests/storage.test.mjs',
    'src/components/__tests__/x.jsx',
    'src/pages/ItemFunding.helpers.test.js',
  ]

  it.each(ALLOWED)('allows %s', (p) => {
    expect(isPathSafeForFix(p)).toBe(true)
  })

  it.each(REFUSED)('refuses %s', (p) => {
    expect(isPathSafeForFix(p)).toBe(false)
  })

  it('refuses an escape from the repository root', () => {
    expect(isPathSafeForFix('../../../etc/passwd')).toBe(false)
    expect(isPathSafeForFix('')).toBe(false)
    expect(isPathSafeForFix(null)).toBe(false)
  })
})

describe('what Sam NOMINATES is what Sam is PERMITTED to touch', () => {
  /**
   * The drift itself. These two lived in different modules with different
   * rules, so the nomination step selected files the permit step refused.
   */
  it('never nominates a file the permitting predicate refuses', () => {
    const findings = [
      { safe_auto_fix_available: true, affected_files: ['backend/services/matchEngine.js'] },
      { safe_auto_fix_available: true, affected_files: ['backend/db/index.js'] },
      { safe_auto_fix_available: true, affected_files: ['backend/tests/foo.test.js'] },
      { safe_auto_fix_available: true, affected_files: ['.env'] },
    ]
    for (const finding of findings) {
      const { perFixParams } = deriveSafeFixesFromFindings([finding])
      expect(perFixParams['lint.eslint-fix-file'], `nominated a refused path: ${finding.affected_files[0]}`).toBeUndefined()
    }
  })

  it('DOES nominate an ordinary backend service file', () => {
    const { fixIds, perFixParams } = deriveSafeFixesFromFindings([
      { safe_auto_fix_available: true, affected_files: ['backend/services/opportunityInserter.js'] },
    ])
    expect(fixIds).toContain('lint.eslint-fix-file')
    expect(perFixParams['lint.eslint-fix-file']).toEqual({ file: 'backend/services/opportunityInserter.js' })
    // and the permitter agrees — that is the whole point
    expect(isPathSafeForFix(perFixParams['lint.eslint-fix-file'].file)).toBe(true)
  })

  it('the registry names the single authority instead of restating a scope that can drift', () => {
    const entry = findSafeFixById('lint.eslint-fix-file')
    expect(entry, 'the eslint safe fix must still exist').toBeTruthy()
    expect(entry.description).toMatch(/isPathSafeForFix/)
    expect(SAFE_FIX_REGISTRY.some((f) => f.id === 'lint.eslint-fix-file')).toBe(true)
  })
})

describe('a tool that did not run is never reported as a verdict about the file', () => {
  it('decideEslintOutcome separates "could not check" from "not clean"', () => {
    expect(decideEslintOutcome({ verifyStatus: 0, changed: true })).toMatchObject({ ok: true, verified: true, applied: true, tool_unavailable: false })
    expect(decideEslintOutcome({ verifyStatus: 1, changed: true })).toMatchObject({ ok: false, verified: false, reverted: true, tool_unavailable: false })
    expect(decideEslintOutcome({ verifyStatus: 0, changed: false, verifyUnavailable: true }))
      .toMatchObject({ ok: false, verified: false, tool_unavailable: true })
  })

  it('eslintFixFile says the TOOL failed, not that the file has problems', async () => {
    const unavailable = async () => ({ status: -1, stdout: '', stderr: 'eslint is not installed in this environment', unavailable: true })
    const res = await __testing__.eslintFixFile({ file: 'backend/services/opportunityInserter.js', _runEslint: unavailable })
    expect(res.ok).toBe(false)
    expect(res.tool_unavailable).toBe(true)
    expect(res.message).toMatch(/could not run/i)
    expect(res.message).toMatch(/no conclusion about/i)
    // The old message asserted a defect in the file. It must not come back.
    expect(res.message).not.toMatch(/reports unresolved problems/i)
  })

  it('a real backend service file passes the gate and is left untouched when already clean', async () => {
    const res = await applySafeFix({
      fixId: 'lint.eslint-fix-file',
      context: { authorisedByAdmin: true, mode: 'repair-safe' },
      params: { file: 'backend/services/pipelinePrecision.js' },
    })
    // Before the change this returned: "…is outside the safe-fix allowlist."
    expect(String(res.message)).not.toMatch(/outside the safe-fix allowlist/i)
    expect(res.ok).toBe(true)
    expect(res.applied).toBe(false)
  }, 180_000)
})

describe('a gate that cannot be launched is SKIPPED, never failed', () => {
  it('reports an unavailable executable as skipped with the reason named', async () => {
    const res = await runWhitelistedCommand('npm run -s crawler:doctor', {
      whitelist: ['npm run -s crawler:doctor'],
      timeoutMs: 90_000,
    })
    // On any platform this must NOT be the old `{ok:false, status:-1, stderr:'spawn npm ENOENT'}`.
    expect(String(res.stderr || '')).not.toMatch(/ENOENT|EINVAL/)
    if (res.skipped) {
      expect(res.ok).toBe(true)
      expect(String(res.skipped_reason)).toMatch(/executable_unavailable|script_not_found/)
    } else {
      expect(res.status).toBe(0)
    }
  }, 180_000)
})
