/**
 * STATIC TRIPWIRE — the profile-blind extraction modules are wired ONLY at the
 * sanctioned Phase-1b SHADOW seam, and nowhere near the live scoring path.
 *
 * Phase 1a shipped pure/injectable extraction MODULES (buildLinkInventory,
 * extractPageFactsBlind, mapBlindFactsToCandidate, validateEvidenceSpans).
 * Phase 1b wires them in SHADOW behind WEB_LANE_PROFILE_BLIND (default OFF):
 * `crawlerOsService.makeBlindShadow()` is the ONE seam that imports them, builds a
 * `blindShadow` dep, and injects it into `runWebDiscoveryLane` — which reads it
 * for a read-only delta counter and NEVER lets a blind candidate be scored or
 * persisted. The live extraction/mapping/scoring files must still NOT import a
 * blind module: `webLane.js` receives the shadow by INJECTION (not import), and
 * `webGrantExtractor.js` / `matchEngine.js` / `pipeline.js` stay blind-free so the
 * profile-conditioned live path is untouched.
 *
 * This guard fails if any non-test source file OUTSIDE the allowlist imports a
 * blind module. When a later phase promotes the blind path (e.g. the WRITES flag),
 * it updates this test in the same change that makes the new import real.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const SCAN_ROOTS = ['src', 'backend', 'shared']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage'])
const EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx'])

// The blind module files (by basename). These may import one another; no LIVE
// source may import them yet.
const BLIND_MODULES = [
  'blindLinkInventory',
  'blindPageFactExtractor',
  'blindFactsMapper',
  'blindEvidenceValidator',
]

// Files ALLOWED to reference a blind module: the blind modules themselves, their
// tests, and the ONE Phase-1b shadow-wiring seam (crawlerOsService.makeBlindShadow).
const ALLOWED_BASENAMES = new Set([
  ...BLIND_MODULES.map((m) => `${m}.js`),
  'crawlerOsService.js', // the sanctioned shadow seam (builds + injects blindShadow)
])

// Named "live" sources that must STAY blind-free — the profile-conditioned
// extraction/mapping/scoring path. webLane receives the shadow by INJECTION, so
// it too must not statically import a blind module. Asserted directly so a
// regression is unmistakable even if the general scan is ever weakened.
const NAMED_LIVE_SOURCES = [
  'backend/crawler-os/webLane.js',
  'backend/services/webGrantExtractor.js',
  'backend/crawler-os/matchEngine.js',
  'backend/crawler-os/pipeline.js',
]

// A module SPECIFIER (the quoted path in any import/require/export ... from /
// dynamic import()) that names a blind module. Because every one of those forms
// — static `import ... from`, `import(...)`, `require(...)`, `export ... from`,
// even multiline imports — routes through a QUOTED specifier string, matching the
// basename inside ANY quoted string is a robust superset that a line-oriented
// `import`-prefixed regex would miss (multiline / dynamic / re-export). The
// specifier is single-line even when the import statement spans lines, so a
// whole-file scan with this catches them all.
const SPECIFIER_RE = new RegExp(
  `['"\`][^'"\`\\n]*(?:${BLIND_MODULES.join('|')})[^'"\`\\n]*['"\`]`,
  'g',
)

function listSourceFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(path.join(dir, e.name))
      } else if (EXTENSIONS.has(path.extname(e.name))) {
        out.push(path.join(dir, e.name))
      }
    }
  }
  walk(path.join(REPO_ROOT, root))
  return out
}

function isTestFile(rel) {
  return /\.(test|spec)\./.test(rel) || /[\\/](tests|__tests__|test)[\\/]/.test(rel)
}

describe('blind extraction modules are wired only at the sanctioned shadow seam', () => {
  it('no live source outside the allowlist imports a blind module', () => {
    const violations = []
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/')
        const base = path.basename(file)
        if (ALLOWED_BASENAMES.has(base)) continue // a blind module (may import a sibling)
        if (isTestFile(rel)) continue // tests may import the modules under test
        const text = fs.readFileSync(file, 'utf8')
        // Whole-file scan (not line-by-line) so multiline imports are covered.
        const matches = text.match(SPECIFIER_RE)
        if (matches) {
          for (const m of matches) violations.push(`${rel}  ${m.slice(0, 160)}`)
        }
      }
    }
    expect(
      violations,
      'Blind modules may be imported ONLY by the blind modules themselves and the ' +
        'sanctioned shadow seam (crawlerOsService.makeBlindShadow). A new importer ' +
        'either belongs on the allowlist (with a phase note) or is leaking the blind ' +
        'path into live code:\n' +
        violations.join('\n'),
    ).toEqual([])
  })

  it('each named live source is import-clean of the blind modules', () => {
    for (const rel of NAMED_LIVE_SOURCES) {
      const abs = path.join(REPO_ROOT, rel)
      if (!fs.existsSync(abs)) continue
      const text = fs.readFileSync(abs, 'utf8')
      for (const mod of BLIND_MODULES) {
        expect(text.includes(mod), `${rel} must not reference ${mod} yet`).toBe(false)
      }
    }
  })
})
