import { describe, it, expect } from 'vitest'
import { rewriteSource } from '../../scripts/fix-eqeqeq-null.mjs'

// Guards the CI "Auto-fix lint issues" codemod (scripts/fix-eqeqeq-null.mjs).
// This script runs on every CI push BEFORE the corruption detector, so a bug
// in its rewrite breaks CI for the whole repo. Two real corruptions slipped
// through once (AnyaChat optional chain → `adapter.(…)` parse error; computed
// member `PAYMENT_TERMS_DAYS[key] == null` silently skipped) — both are
// pinned below so the codemod can never re-introduce them.

const rewrite = (src) => rewriteSource(src).src

// Eval-free structural check: a `.(` artifact is the exact signature of the
// mid-chain orphan bug, and unbalanced parens would mean the rewrite split an
// expression. Counting ignores the framework-free fixtures' lack of strings.
const isStructurallySound = (code) => {
  if (code.includes('.(') || code.includes('?.(')) return false
  let depth = 0
  for (const ch of code) {
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    if (depth < 0) return false
  }
  return depth === 0
}

describe('fix-eqeqeq-null codemod', () => {
  it('rewrites a bare identifier', () => {
    expect(rewrite('if (x == null) {}')).toBe(
      'if ((x === null || x === undefined)) {}',
    )
    expect(rewrite('if (x != null) {}')).toBe(
      'if ((x !== null && x !== undefined)) {}',
    )
  })

  it('matches the FULL optional chain from its root (no mid-chain orphan)', () => {
    const out = rewrite('if (adapter.completion?.resultCount != null) f()')
    // Regression: the old IDENT matched mid-chain, producing `adapter.(…)`.
    expect(out).not.toContain('adapter.(')
    expect(out).toBe(
      'if ((adapter.completion?.resultCount !== null && adapter.completion?.resultCount !== undefined)) f()',
    )
  })

  it('handles a computed member key (bracket with an expression)', () => {
    // Regression: the old IDENT only allowed `[<number>]`, so this `== null`
    // survived the codemod and tripped the strict eqeqeq lint rule.
    const out = rewrite('if (TERMS[form.payment_terms] == null) f()')
    expect(out).toBe(
      'if ((TERMS[form.payment_terms] === null || TERMS[form.payment_terms] === undefined)) f()',
    )
  })

  it('still handles numeric index access', () => {
    expect(rewrite('if (arr[0] != null) {}')).toBe(
      'if ((arr[0] !== null && arr[0] !== undefined)) {}',
    )
  })

  it('produces structurally sound output for the regressed patterns', () => {
    expect(isStructurallySound(rewrite('const ok = adapter.completion?.resultCount != null'))).toBe(true)
    expect(isStructurallySound(rewrite('const ok = TERMS[form.payment_terms] == null'))).toBe(true)
  })

  it('never touches strings, template literals, or comments', () => {
    const str = 'const sql = "WHERE x != null"'
    expect(rewrite(str)).toBe(str)

    const tmpl = 'const sql = `WHERE x == null AND y != null`'
    expect(rewrite(tmpl)).toBe(tmpl)

    const comment = '// note: x == null means missing'
    expect(rewrite(comment)).toBe(comment)
  })

  it('leaves complex left-hand sides (calls/ternaries) alone', () => {
    const call = 'if (getValue() == null) {}'
    // A function call is not a simple member chain — left for human review.
    expect(rewrite(call)).toBe(call)
  })
})
