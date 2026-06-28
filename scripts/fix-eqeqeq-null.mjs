#!/usr/bin/env node
/**
 * Targeted codemod: convert the `x == null` / `x != null` patterns that
 * remain as eqeqeq violations under backend/** + src/** + shared/** into
 * strict equivalents that preserve the "null or undefined" intent.
 *
 *   foo == null          ->  (foo === null || foo === undefined)
 *   foo != null          ->  (foo !== null && foo !== undefined)
 *
 * IMPORTANT — recurrence guard:
 *   The earlier regex-based implementation rewrote anywhere in the source,
 *   including comments and string/template literals. That mangled SQL
 *   inside template literals (`SELECT ... WHERE x != null` would become
 *   nonsense) and corrupted human-written code comments. This rewrite uses
 *   a minimal hand-rolled JS lexer that skips:
 *     - // line comments
 *     - /* block comments *\/
 *     - 'single-quoted strings'
 *     - "double-quoted strings"
 *     - `template literals` (and balanced ${...} interpolations inside them)
 *
 *   so the rewrite only ever touches real JavaScript expressions.
 *
 * Usage:
 *   node scripts/fix-eqeqeq-null.mjs                      (rewrites the whole repo)
 *   node scripts/fix-eqeqeq-null.mjs <file> [<file>…]     (rewrites just those files)
 *
 * Exit code is always 0 — this is a pre-lint normalizer, not a check.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  'coverage',
  'backend_prev',
  '.next',
])

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(js|jsx|mjs|cjs)$/.test(entry) && !entry.endsWith('.min.js')) out.push(full)
  }
  return out
}

// Match the lhs of `<lhs> == null` / `<lhs> != null`. Conservative: only
// identifiers, member access, optional chaining, and bracket index.
// Anything more complex (function calls, ternaries, etc.) is left alone so
// the human reviewer can decide.
//
// The chain is matched from its ROOT identifier through every `.`/`?.` hop
// and `[index]` access. This MUST cover the full member expression: an
// earlier version allowed only a single `.`/`?.` hop, so on a 3+ segment
// optional chain (`adapter.completion?.resultCount`) it could not anchor at
// the root and the regexp engine instead matched mid-chain
// (`completion?.resultCount`), orphaning the `adapter.` prefix into the
// syntactically-invalid `adapter.(…)`. Matching the whole chain greedily
// from the root makes the leftmost match consume the entire LHS, so a
// mid-chain match can never occur. The bracket body forbids nested brackets
// (`[^\][]`) so a computed key such as `[formData.payment_terms]` is handled
// while we still bail out of anything genuinely nested.
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.)[A-Za-z_$][A-Za-z0-9_$]*|\[[^\][]*\])*/.source
const EXPRESSION_RX = new RegExp(`(${IDENT})\\s*(==|!=)\\s*null\\b`)

/**
 * Rewrite a single source file while preserving string/template/comment
 * content. Mirrors scripts/codemod/eqeqeq-fix.mjs's lexer.
 *
 * Returns { src, changes }.
 *
 * Exported so the regression suite (backend/tests/fixEqeqeqNull.test.mjs) can
 * exercise the operator rewrite directly without shelling out or walking the
 * repo.
 */
export function rewriteSource(src) {
  let out = ''
  let i = 0
  const n = src.length
  let changes = 0

  // Buffer of "real code" we accumulate between string/comment regions.
  // We apply the regex on the buffer when we hit a non-code region or EOF.
  let codeBuf = ''
  const flushCode = () => {
    if (codeBuf.length === 0) return
    let scanned = ''
    let rest = codeBuf
    while (rest.length > 0) {
      const m = EXPRESSION_RX.exec(rest)
      if (!m) {
        scanned += rest
        break
      }
      const idx = m.index
      const lhs = m[1]
      const op = m[2]
      scanned += rest.slice(0, idx)
      scanned +=
        op === '=='
          ? `(${lhs} === null || ${lhs} === undefined)`
          : `(${lhs} !== null && ${lhs} !== undefined)`
      changes += 1
      rest = rest.slice(idx + m[0].length)
    }
    out += scanned
    codeBuf = ''
  }

  while (i < n) {
    const c = src[i]
    const c2 = src.substr(i, 2)

    // Line comment.
    if (c2 === '//') {
      flushCode()
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? n : nl + 1
      out += src.slice(i, end)
      i = end
      continue
    }

    // Block comment.
    if (c2 === '/*') {
      flushCode()
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out += src.slice(i, end)
      i = end
      continue
    }

    // Single/double quoted string.
    if (c === "'" || c === '"') {
      flushCode()
      const quote = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === quote) {
          j += 1
          break
        }
        if (src[j] === '\n') {
          j += 1
          break
        } // unterminated — bail safely
        j += 1
      }
      out += src.slice(i, j)
      i = j
      continue
    }

    // Template literal (with balanced ${ ... } interpolations).
    if (c === '`') {
      flushCode()
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '`') {
          j += 1
          break
        }
        if (src[j] === '$' && src[j + 1] === '{') {
          let depth = 1
          j += 2
          while (j < n && depth > 0) {
            if (src[j] === '{') depth += 1
            else if (src[j] === '}') depth -= 1
            else if (src[j] === '`') {
              let k = j + 1
              while (k < n && src[k] !== '`') {
                if (src[k] === '\\') k += 2
                else k += 1
              }
              j = k
            }
            j += 1
          }
          continue
        }
        j += 1
      }
      out += src.slice(i, j)
      i = j
      continue
    }

    codeBuf += c
    i += 1
  }
  flushCode()

  return { src: out, changes }
}

function runCli() {
  let files = process.argv.slice(2).filter(Boolean).map((f) => path.resolve(f))
  if (files.length === 0) {
    files = [
      ...walk(path.join(repoRoot, 'backend')),
      ...walk(path.join(repoRoot, 'src')),
      ...walk(path.join(repoRoot, 'shared')),
      ...walk(path.join(repoRoot, 'scripts')),
    ]
  }

  let totalFixed = 0
  let filesTouched = 0
  for (const full of files) {
    let before
    try {
      before = readFileSync(full, 'utf8')
    } catch (err) {
      console.error(`skip ${full}: ${err.message}`)
      continue
    }
    const { src: after, changes } = rewriteSource(before)
    if (changes > 0 && after !== before) {
      writeFileSync(full, after, 'utf8')
      totalFixed += changes
      filesTouched += 1
      console.log(`${path.relative(repoRoot, full)}: ${changes} replacement(s)`)
    }
  }

  console.log(
    `[codemod/eqeqeq-null] rewrote ${totalFixed} operator(s) across ${filesTouched} file(s) (string/template/comment-safe).`,
  )
}

// Only walk + rewrite the repo when invoked as a script. Importing the module
// (e.g. from the regression test) must have no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli()
}
