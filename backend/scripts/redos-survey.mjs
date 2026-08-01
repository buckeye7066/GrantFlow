#!/usr/bin/env node
/**
 * redos-survey.mjs — measure the whitespace-ReDoS class in this repo.
 *
 *   node backend/scripts/redos-survey.mjs            # whole repo
 *   node backend/scripts/redos-survey.mjs <file.js>  # one file
 *
 * ── READ THIS BEFORE TRUSTING A CLEAN RESULT ──────────────────────────────────
 *
 * A CLEAN RESULT IS NOT PROOF. This harness under-reports in two ways that have
 * both already bitten:
 *
 * 1. THE HOSTILE INPUT MUST BE AIMED. A pattern only backtracks when the
 *    whitespace run sits exactly where its ambiguity is. A generic hostile
 *    string missed `opportunityNormalizer.js:535` entirely — a regex separately
 *    measured at 3.5 s / 50k chars and 92% of that function's CPU self time.
 *    So each pattern's hostile input is built from ITS OWN literal prefix.
 *
 * 2. AN OPTIONAL LITERAL DEFUSES THE TRIGGER. `\s+ … a? … \s*` collapses to
 *    `\s+\s*` only when the optional token matches EMPTY. A first version of
 *    `literalPrefix()` included the `a`, and reported **0 offenders in a file
 *    with a known 3.5 s regex**. The prefix builder now stops BEFORE any
 *    optional literal.
 *
 * 3. THE CALL SITE IS THE GROUND TRUTH, NOT THE LITERAL. A dangerous pattern
 *    whose caller pre-normalizes whitespace is not exposed. In
 *    `documentIngestion/heuristics.js` the `Plan type` / `Plan name` /
 *    `Insurance provider` patterns carry the shape and are flagged here, yet
 *    are harmless because their caller matches against an already-collapsed
 *    `singleLine`. Measure the EXPORTED function before acting on a hit.
 *
 * Measured on this repo 2026-08-01: 316 literals carry the SHAPE, only 16 are
 * actually superlinear, and 3 of those are in a script nothing imports. Rank by
 * reachability x untrusted input, never by the timing number alone.
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOTS = ['backend', 'src', 'shared']
const SKIP = /node_modules|[.]git|dist|build|coverage/
const OVERLAP = new RegExp('\\\\s[+*][^\\\\]{0,3}?(?:\\\\?.|\\[[^\\]]{0,20}\\]|\\([^)]{0,40}\\))?\\??\\\\s[*+]')

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) walk(p, out)
    else if (/[.](js|jsx|mjs|ts)$/.test(e.name)) out.push(p)
  }
  return out
}

/** Longest literal prefix, stopping BEFORE any optional token (see note 2). */
function literalPrefix(body) {
  let out = ''
  let i = 0
  while (i < body.length) {
    if (body.slice(i, i + 2) === '\\b') { i += 2; continue }
    if (body.slice(i, i + 2) === '\\s') {
      const q = body[i + 2]
      out += ' '
      i += (q === '+' || q === '*') ? 3 : 2
      continue
    }
    const c = body[i]
    if (/[a-z0-9 ]/i.test(c)) {
      if (body[i + 1] === '?') break
      out += c
      i += 1
      continue
    }
    break
  }
  return out
}

const timeMs = (rx, s) => {
  const t0 = process.hrtime.bigint()
  try { rx.test(s) } catch { /* invalid at runtime — ignore */ }
  return Number(process.hrtime.bigint() - t0) / 1e6
}

const target = process.argv[2]
const files = target ? [target] : ROOTS.filter((r) => fs.existsSync(r)).flatMap((r) => walk(r, []))

const candidates = []
for (const f of files) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\/((?:[^/\\\n[]|\\.|\[[^\]\n]*\])+)\/([gimsuy]*)/g)) {
      const body = m[1]
      if (body.length < 6 || !OVERLAP.test(body)) continue
      candidates.push({ file: f.split(path.sep).join('/'), line: i + 1, body, flags: m[2].replace('g', '') })
    }
  })
}

const offenders = []
for (const c of candidates) {
  let rx
  try { rx = new RegExp(c.body, c.flags) } catch { continue }
  const prefix = literalPrefix(c.body).trimEnd()
  for (const base of [prefix.length >= 3 ? prefix : null, '']) {
    if (base === null) continue
    const mk = (n) => base + '\t\t'.repeat(n) + 'x'
    timeMs(rx, mk(50))
    const t1 = timeMs(rx, mk(500))
    const t4 = timeMs(rx, mk(2000))
    const growth = t4 / Math.max(t1, 0.02)
    if (t4 > 2 && growth > 6) {
      offenders.push({ ...c, aim: base, t1: +t1.toFixed(2), t4: +t4.toFixed(2), growth: +growth.toFixed(1) })
      break
    }
  }
}

console.log(`files scanned                     : ${files.length}`)
console.log(`STRUCTURAL candidates (shape only): ${candidates.length}`)
console.log(`MEASURED superlinear (tailored)   : ${offenders.length}`)
console.log('')
for (const o of offenders.sort((a, b) => b.t4 - a.t4)) {
  console.log(`${o.file}:${o.line}  ${o.t1}ms@4k -> ${o.t4}ms@16k  growth=${o.growth}x  aim="${o.aim}"`)
  console.log(`   /${o.body.slice(0, 120)}/`)
}
console.log('')
console.log('A clean result is NOT proof — see the header. Verify at the CALL SITE.')
