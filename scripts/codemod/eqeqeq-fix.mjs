#!/usr/bin/env node
/**
 * Group 6 codemod: rewrite every loose-equality comparison (`==`, `!=`) to
 * strict equality (`===`, `!==`).
 *
 * IMPORTANT — recurrence guard:
 *   The earlier naive implementation applied the regex to the entire file,
 *   which also rewrote SQL operators inside template literals. SQLite/Postgres
 *   do not recognize `!==` / `===`, so queries like
 *     `WHERE state != ''`
 *   silently became
 *     `WHERE state !== ''`
 *   and returned zero rows at runtime. Two pre-existing unit failures
 *   (regional-purge, geo-crawl state summary) were caused by that.
 *
 *   This version ONLY rewrites operators that live in real JavaScript code,
 *   i.e. outside of:
 *     - single-quoted strings
 *     - double-quoted strings
 *     - backtick/template literals (SQL lives here in this repo)
 *     - // line comments
 *     - /* block comments *\/
 *
 *   The walker is a minimal hand-rolled lexer; it is intentionally conservative
 *   (expression interpolations `${ ... }` inside template literals are also
 *   skipped, which is safe because interpolated subexpressions are short and
 *   the operators inside them were already `===`/`!==` after the first pass).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'backend_prev'])
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (/\.(js|jsx|mjs|cjs)$/.test(entry) && !entry.endsWith('.min.js')) out.push(full)
  }
  return out
}

const files = [
  ...walk(path.join(repoRoot, 'backend')),
  ...walk(path.join(repoRoot, 'src')),
]

/**
 * Rewrite a single source file while preserving string/template/comment content.
 * Returns { src, changes }.
 */
function rewriteSource(src) {
  let out = ''
  let i = 0
  const n = src.length
  let changes = 0

  const isIdentPrev = (idx) => /[=!<>]/.test(src[idx] || '')

  while (i < n) {
    const c = src[i]
    const c2 = src.substr(i, 2)

    // Line comment: copy through end of line.
    if (c2 === '//') {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? n : nl + 1
      out += src.slice(i, end)
      i = end
      continue
    }

    // Block comment.
    if (c2 === '/*') {
      const close = src.indexOf('*/', i + 2)
      const end = close === -1 ? n : close + 2
      out += src.slice(i, end)
      i = end
      continue
    }

    // Single/double quoted string.
    if (c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === quote) { j += 1; break }
        if (src[j] === '\n') { j += 1; break } // unterminated — bail safely
        j += 1
      }
      out += src.slice(i, j)
      i = j
      continue
    }

    // Template literal.
    if (c === '`') {
      let j = i + 1
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue }
        if (src[j] === '`') { j += 1; break }
        if (src[j] === '$' && src[j + 1] === '{') {
          // Skip balanced ${ ... }
          let depth = 1
          j += 2
          while (j < n && depth > 0) {
            if (src[j] === '{') depth += 1
            else if (src[j] === '}') depth -= 1
            else if (src[j] === '`') {
              // Nested template — skip conservatively.
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

    // Real code: apply `==` → `===` and `!=` → `!==`.
    if (c === '=' && src[i + 1] === '=' && src[i + 2] !== '=' && !isIdentPrev(i - 1)) {
      out += '==='
      i += 2
      changes += 1
      continue
    }
    if (c === '!' && src[i + 1] === '=' && src[i + 2] !== '=' && !isIdentPrev(i - 1)) {
      out += '!=='
      i += 2
      changes += 1
      continue
    }

    out += c
    i += 1
  }

  return { src: out, changes }
}

let totalFixed = 0
let filesTouched = 0

for (const f of files) {
  const before = readFileSync(f, 'utf8')
  const { src: after, changes } = rewriteSource(before)
  if (changes > 0 && after !== before) {
    writeFileSync(f, after)
    totalFixed += changes
    filesTouched += 1
  }
}

console.log(`[codemod/eqeqeq] rewrote ${totalFixed} operators across ${filesTouched} files (string/template/comment-safe).`)
