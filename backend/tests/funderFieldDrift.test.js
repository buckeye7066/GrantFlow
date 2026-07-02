/**
 * STATIC GUARD — funder/sponsor naming-drift tripwire (#725 bug class).
 *
 * Ground truth (backend/db/schema.sql):
 *   - grants                → the funder's name is `funder` (contact via
 *     `contact_email`/`contact_phone`; `funder_fax`/`funder_address` exist).
 *     There is NO `funder_name`, `funder_email`, or `funder_phone` column.
 *   - funding_opportunities → the funder's name is `sponsor`.
 *   - grant_applications    → genuinely has `funder_name` (reads on
 *     application-shaped objects, e.g. `app.funder_name`, are fine and are
 *     not matched by this guard).
 *
 * Past regressions this guard would have caught:
 *   - routes/ai.js reading `grant.funder_name` (showed the applicant's own
 *     org as the "Funder" in AI application packets).
 *   - hamiltonApplicationPacketGenerator reading `opp.funder_name || …`
 *     with no `sponsor`/`funder` in the chain (rendered the literal string
 *     "Funder" in every packet).
 *   - useGrantTools print sheet reading `grant.sponsor` with no `funder`
 *     fallback (blank funder on printed sheets — fixed in PR #816).
 *
 * Rules enforced over non-test source in src/ and backend/:
 *   1. A read of `grant.`/`opp.`/`opportunity.` + `funder_name|funder_email|
 *      funder_phone` (columns that do not exist on grants/opportunity rows)
 *      is only allowed on a line that ALSO reads the canonical `.funder` or
 *      `.sponsor` (i.e. the phantom field is a last-resort alias, never the
 *      primary read).
 *   2. In src/ (user-facing), a read of `grant.sponsor` must have a `funder`
 *      fallback on the same line — pipeline grant rows carry `funder`, not
 *      `sponsor`, so a bare `grant.sponsor` renders blank.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

const SCAN_ROOTS = ['src', 'backend', 'shared']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'tests', '__tests__', 'test'])
const EXTENSIONS = new Set(['.js', '.jsx'])

// Known-legitimate phantom-alias reads (each must justify itself here).
const ALLOWLIST = [
  {
    // The single ingest choke point that ACCEPTS drift aliases on purpose,
    // normalizing them into funding_opportunities.sponsor.
    file: 'backend/services/opportunityInserter.js',
    lineIncludes: 'normalizeNonEmptyString(opportunity.funder_name)',
  },
]

function listSourceFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        walk(path.join(dir, e.name))
      } else if (EXTENSIONS.has(path.extname(e.name)) && !/\.(test|spec)\./.test(e.name)) {
        out.push(path.join(dir, e.name))
      }
    }
  }
  walk(path.join(REPO_ROOT, root))
  return out
}

function isAllowlisted(relFile, line) {
  return ALLOWLIST.some(
    (a) => relFile.split(path.sep).join('/') === a.file && line.includes(a.lineIncludes),
  )
}

const PHANTOM_READ = /\b(?:grant|opp|opportunity)\.(?:funder_name|funder_email|funder_phone)\b/
const CANONICAL_READ = /\.(?:funder|sponsor)\b/
const BARE_GRANT_SPONSOR = /\bgrant\.sponsor\b/

describe('funder field drift guard (static)', () => {
  it('never reads phantom funder_name/funder_email/funder_phone off a grant/opportunity row without the canonical field first', () => {
    const violations = []
    for (const root of SCAN_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const rel = path.relative(REPO_ROOT, file)
        const lines = fs.readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (!PHANTOM_READ.test(line)) return
          if (CANONICAL_READ.test(line)) return // phantom is only a trailing alias
          if (isAllowlisted(rel, line)) return
          violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 160)}`)
        })
      }
    }
    expect(
      violations,
      `grants rows carry \`funder\` (+contact_email/contact_phone); funding_opportunities rows carry \`sponsor\`. ` +
        `These reads reference columns that DO NOT EXIST on those rows (always undefined in prod). ` +
        `Read the canonical field (with the phantom only as a trailing alias), or extend ALLOWLIST with a justification:\n` +
        violations.join('\n'),
    ).toEqual([])
  })

  it('user-facing grant.sponsor reads always carry a funder fallback (PR #816 lesson)', () => {
    const violations = []
    for (const file of listSourceFiles('src')) {
      const rel = path.relative(REPO_ROOT, file)
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!BARE_GRANT_SPONSOR.test(line)) return
        if (/funder/.test(line)) return // has the fallback (or maps from funder)
        violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 160)}`)
      })
    }
    expect(
      violations,
      `Pipeline grant rows have \`funder\`, not \`sponsor\` — a bare grant.sponsor read renders blank. ` +
        `Use \`grant.funder || grant.sponsor\` (or vice versa):\n` + violations.join('\n'),
    ).toEqual([])
  })
})
