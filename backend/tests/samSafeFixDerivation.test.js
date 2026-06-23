/**
 * Sam "act, not just report": deriveSafeFixesFromFindings turns a run's findings
 * into the safe fixes an admin-authorized repair-safe run will APPLY (no more
 * hand-typing fix ids). It is conservative + idempotent and must never widen
 * authority — applySafeFixes re-enforces admin + repair-safe + policy gates.
 */
import { describe, it, expect } from 'vitest'
import { deriveSafeFixesFromFindings, applySafeFix } from '../services/sam/samSafeFixes.js'

describe('deriveSafeFixesFromFindings', () => {
  it('always derives the always-safe readiness-log regeneration', () => {
    const { fixIds } = deriveSafeFixesFromFindings([])
    expect(fixIds).toContain('docs.regenerate-readiness-log')
  })

  it('derives eslint --fix only for a code-file finding flagged safe_auto_fix_available', () => {
    const { fixIds, perFixParams } = deriveSafeFixesFromFindings([
      { safe_auto_fix_available: true, affected_files: ['backend/services/x.js'] },
      { safe_auto_fix_available: false, affected_files: ['backend/services/y.js'] }, // not flagged → ignored
      { safe_auto_fix_available: true, affected_files: ['/etc/passwd'] }, // not under src|backend → ignored
    ])
    expect(fixIds).toContain('lint.eslint-fix-file')
    expect(perFixParams['lint.eslint-fix-file']).toEqual({ file: 'backend/services/x.js' })
  })

  it('does NOT derive eslint-fix when no finding is flagged', () => {
    const { fixIds } = deriveSafeFixesFromFindings([
      { safe_auto_fix_available: false, affected_files: ['src/a.js'] },
    ])
    expect(fixIds).not.toContain('lint.eslint-fix-file')
  })

  it('is idempotent — same findings yield the same derivation', () => {
    const findings = [{ safe_auto_fix_available: true, affected_files: ['src/a.js'] }]
    const a = deriveSafeFixesFromFindings(findings)
    const b = deriveSafeFixesFromFindings(findings)
    expect(a).toEqual(b)
  })

  it('the derivation never widens authority — applySafeFix still refuses a non-admin / non-repair-safe caller', async () => {
    const { fixIds } = deriveSafeFixesFromFindings([])
    const res = await applySafeFix({ fixId: fixIds[0], context: { authorisedByAdmin: false, mode: 'observe' } })
    expect(res.applied).not.toBe(true)
    expect(String(res.message || '')).toMatch(/refuses|not an authorised admin|not repair-safe/i)
  })
})
