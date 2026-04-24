/**
 * Regression tests for the admin.code.scan / admin.code.crawl false positives
 * called out in the Anya admin audit sweep:
 *
 *   - "debugger" mentioned only inside JSDoc / block comments must not trigger
 *     the debugger-statement rule.
 *   - "TODO"/"console.log" mentioned only inside comments still counts for
 *     TODO markers (intentional) but no longer for console-statement rules.
 *   - Hardcoded-secret heuristic must NOT flag user-facing error strings that
 *     merely contain the word "key" (routes/admin.js:812 regression).
 *   - Lines carrying `audit:allow <category>` tags must be skipped.
 */
import { describe, it, expect } from 'vitest'
import {
  stripCommentsPreservingLayout,
  hasAuditAllowTag,
  looksLikeRealSecret,
} from '../services/anyaAdminTools.js'

describe('stripCommentsPreservingLayout', () => {
  it('replaces line comments with spaces but preserves newlines', () => {
    const src = 'const x = 1 // hello\nconst y = 2'
    const out = stripCommentsPreservingLayout(src)
    expect(out.split('\n').length).toBe(2)
    expect(out).not.toContain('hello')
    expect(out.startsWith('const x = 1')).toBe(true)
  })

  it('replaces block comments across multiple lines', () => {
    const src = 'const a = 1\n/* multi\n * line\n */\nconst b = 2'
    const out = stripCommentsPreservingLayout(src)
    expect(out.split('\n').length).toBe(5)
    expect(out).not.toMatch(/multi/)
    expect(out).not.toMatch(/line/)
  })

  it('strips JSDoc while preserving declarations intact', () => {
    const src = [
      '/**',
      ' * @param {string} x — mention of debugger should not leak out',
      ' */',
      'function foo(x) { return x }',
    ].join('\n')
    const out = stripCommentsPreservingLayout(src)
    const codeLines = out.split('\n')
    // The JSDoc lines have no tokens left to scan against.
    expect(codeLines[1]).not.toMatch(/debugger/)
    // The declaration survives unchanged.
    expect(codeLines[3]).toContain('function foo(x)')
  })

  it('does not touch content inside string literals', () => {
    const src = 'const msg = "has // inside"; // real comment'
    const out = stripCommentsPreservingLayout(src)
    expect(out).toContain('"has // inside"')
    expect(out).not.toContain('real comment')
  })

  it('does not touch content inside template literals', () => {
    const src = 'const tpl = `keep // me`'
    const out = stripCommentsPreservingLayout(src)
    expect(out).toContain('`keep // me`')
  })
})

describe('debugger-rule regression (audit false positive)', () => {
  it('a file whose only "debugger" mention is inside JSDoc produces zero code-level hits', () => {
    const src = [
      '/**',
      ' * This scanner detects debugger statements; docs mention "debugger"',
      ' * intentionally.',
      ' */',
      'export function ok() { return 1 }',
    ].join('\n')
    const codeOnly = stripCommentsPreservingLayout(src).split('\n')
    const hits = codeOnly.filter((ln) => /\bdebugger\b/.test(ln))
    expect(hits).toHaveLength(0)
  })

  it('a real debugger statement is still detected', () => {
    const src = ['function halt() {', '  debugger', '}'].join('\n')
    const codeOnly = stripCommentsPreservingLayout(src).split('\n')
    const hits = codeOnly.filter((ln) => /\bdebugger\b/.test(ln))
    expect(hits).toHaveLength(1)
  })
})

describe('hasAuditAllowTag', () => {
  it('detects generic audit:allow markers', () => {
    expect(hasAuditAllowTag('/localhost/, // audit:allow placeholder')).toBe(true)
    expect(hasAuditAllowTag('foo // audit:allow')).toBe(true)
  })

  it('respects the optional category parameter', () => {
    expect(hasAuditAllowTag('// audit:allow placeholder', 'placeholder')).toBe(true)
    expect(hasAuditAllowTag('// audit:allow secret', 'placeholder')).toBe(false)
  })

  it('returns false when the tag is absent', () => {
    expect(hasAuditAllowTag('just a regular line')).toBe(false)
    expect(hasAuditAllowTag('')).toBe(false)
    expect(hasAuditAllowTag(null)).toBe(false)
  })
})

describe('looksLikeRealSecret (hardcoded-secret heuristic)', () => {
  it('accepts real-looking credentials', () => {
    expect(looksLikeRealSecret('sk_live_abcdef1234567890XYZ')).toBe(true)
    expect(looksLikeRealSecret('AKIAIOSFODNN7EXAMPLE')).toBe(true)
    expect(
      looksLikeRealSecret(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'
      )
    ).toBe(true)
  })

  it('rejects user-facing error strings that merely contain the word "key"', () => {
    expect(looksLikeRealSecret('Provided key failed authentication.')).toBe(false)
    expect(looksLikeRealSecret('The api key is missing from the request headers.')).toBe(false)
    expect(looksLikeRealSecret('Please enter your token to continue')).toBe(false)
  })

  it('rejects empty / short / null inputs', () => {
    expect(looksLikeRealSecret('')).toBe(false)
    expect(looksLikeRealSecret('abc')).toBe(false)
    expect(looksLikeRealSecret(null)).toBe(false)
    expect(looksLikeRealSecret(undefined)).toBe(false)
  })
})
