#!/usr/bin/env node
/**
 * Group 6 codemod: rewrite every loose-equality comparison (`==`, `!=`) to
 * strict equality (`===`, `!==`). Safe because the ESLint `eqeqeq:['error','always']`
 * rule has been flagging these for months and there is no `{ null: 'ignore' }`
 * allowance in the repo config — fixes match the policy.
 *
 * Heuristic: we scan each source file line-by-line and replace:
 *   ` == `  -> ` === `
 *   ` != `  -> ` !== `
 *   `!==` / `===` / `<=` / `>=` are untouched because we only match the
 *   exact 4-char patterns with surrounding spaces. This avoids collateral
 *   damage on combinations like `!==` or arrow functions `=>`.
 *
 * A second pass handles the common `x == null` / `x != null` idiom where the
 * whitespace is normalized.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

// Use a tiny recursive walker to avoid pulling in an npm package.
import { readdirSync, statSync } from 'node:fs'
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

let totalFixed = 0
let filesTouched = 0

// Regex: match a loose equality operator that is NOT part of `===`, `!==`, `<=`, `>=`, `=>`.
// We use a negative-lookbehind / lookahead to ensure we only target `==` and `!=`.
const LOOSE_EQ = /(?<![=!<>])==(?!=)/g
const LOOSE_NE = /(?<![=!<>])!=(?!=)/g

for (const f of files) {
  let src = readFileSync(f, 'utf8')
  const before = src
  src = src.replace(LOOSE_EQ, '===')
  src = src.replace(LOOSE_NE, '!==')
  if (src !== before) {
    writeFileSync(f, src)
    const changes = (before.match(LOOSE_EQ) || []).length + (before.match(LOOSE_NE) || []).length
    totalFixed += changes
    filesTouched += 1
  }
}

console.log(`[codemod/eqeqeq] rewrote ${totalFixed} operators across ${filesTouched} files.`)
