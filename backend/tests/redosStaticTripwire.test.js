/**
 * STATIC TRIPWIRE for the whitespace-ReDoS class in the files this PR hardened.
 *
 * A timing test alone HANGS the suite instead of failing cleanly when the shape
 * comes back (a reintroduced cubic can take 25 s on one input), so the shape is
 * also asserted statically — the same precedent the farm PR (#1079) set for its
 * own pattern arrays.
 *
 * SCOPE IS DELIBERATELY NARROW. A repo-wide ban would be wrong: the measured
 * survey found 316 literals with this SHAPE but only 16 actually superlinear,
 * and in `documentIngestion/heuristics.js` the `Plan type` / `Plan name` /
 * `Insurance provider` patterns carry the shape yet are not exposed, because
 * their caller pre-normalizes whitespace. Banning a shape that is usually
 * harmless produces noise and teaches people to suppress the check. This
 * tripwire therefore guards the SPECIFIC constructs that were measured
 * superlinear at their call site and then fixed.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readRaw = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

/**
 * Strip comments before scanning. The fix commentary necessarily QUOTES the
 * patterns it replaced — a tripwire that reads prose fires on its own
 * documentation, which is how a guard gets suppressed instead of obeyed.
 */
const read = (rel) =>
  readRaw(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

describe('ReDoS static tripwire — the fixed constructs must not come back', () => {
  it('documentIngestion/heuristics.js uses no ANCHORED trailing-class trim', () => {
    const src = read('services/documentIngestion/heuristics.js')
    // /\s+$/ , /[\s.;]+$/ , /[\s);,.]+$/ … — an anchored trim over a class that
    // includes whitespace. Linear replacements: trimEnd() or stripTrailing().
    const offenders = [...src.matchAll(/\/(?:\\s|\[[^\]]*\\s[^\]]*\])\+\$\//g)].map((m) => m[0])
    expect(offenders, `use trimEnd()/stripTrailing() instead: ${offenders.join(', ')}`).toEqual([])
  })

  it('documentIngestion/heuristics.js has no leading \\s* before a required literal class', () => {
    const src = read('services/documentIngestion/heuristics.js')
    // /\s*[/|].*$/ — the \s* is redundant before a .trim() and makes it quadratic.
    const offenders = [...src.matchAll(/\/\\s\*\[[^\]]+\]\.\*\$\//g)].map((m) => m[0])
    expect(offenders, `drop the leading \\s* (the trim already handles it): ${offenders.join(', ')}`).toEqual([])
  })

  it('the linear helpers are still exported and used', () => {
    const src = readRaw('services/documentIngestion/heuristics.js')
    expect(src).toMatch(/export function stripTrailing\(/)
    expect(src).toMatch(/stripTrailing\(websiteRaw, '\);,\.'\)/)
    expect(src).toMatch(/\.map\(\(l\) => l\.trimEnd\(\)\)/)
  })

  it('emailGrantIngestor caps the `from` header before the cubic pattern', () => {
    const src = readRaw('services/emailGrants/emailGrantIngestor.js')
    expect(src).toMatch(/export const MAX_FROM_HEADER_LENGTH = \d+/)
    // The cap must be APPLIED, not merely declared.
    expect(src).toMatch(/const raw = str\(from, MAX_FROM_HEADER_LENGTH\)/)
  })
})
