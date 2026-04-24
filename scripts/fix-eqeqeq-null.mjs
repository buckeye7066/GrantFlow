#!/usr/bin/env node
/**
 * Targeted codemod: convert the `x == null` / `x != null` patterns that
 * remain as eqeqeq violations under backend/** into strict equivalents that
 * preserve the "null or undefined" intent.
 *
 *   foo == null          ->  (foo === null || foo === undefined)
 *   foo != null          ->  (foo !== null && foo !== undefined)
 *
 * The lhs is matched conservatively: we only rewrite when it is a chain of
 * identifiers / member access / optional chaining. Anything else is left
 * alone so the human reviewer can decide.
 */
import fs from 'node:fs'
import path from 'node:path'

// lhs: identifier, optional chain of `.foo` / `?.foo` / `[123]`
const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*(?:\?\.|\.)?(?:[A-Za-z0-9_$]|\[[0-9]+\])*/.source
const EXPRESSION_RX = new RegExp(`(${IDENT})\\s*(==|!=)\\s*null\\b`, 'g')

function transform(src) {
  let changed = 0
  const out = src.replace(EXPRESSION_RX, (match, lhs, op) => {
    changed++
    if (op === '==') return `(${lhs} === null || ${lhs} === undefined)`
    return `(${lhs} !== null && ${lhs} !== undefined)`
  })
  return { out, changed }
}

const files = process.argv.slice(2).filter(Boolean)
if (files.length === 0) {
  console.error('usage: fix-eqeqeq-null.mjs <file> [<file>…]')
  process.exit(1)
}

let total = 0
for (const relPath of files) {
  const full = path.resolve(relPath)
  let src
  try {
    src = fs.readFileSync(full, 'utf8')
  } catch (err) {
    console.error(`skip ${relPath}: ${err.message}`)
    continue
  }
  const { out, changed } = transform(src)
  if (changed > 0 && out !== src) {
    fs.writeFileSync(full, out, 'utf8')
    total += changed
    console.log(`${relPath}: ${changed} replacement(s)`)
  }
}

console.log(`done. total replacements: ${total}`)
