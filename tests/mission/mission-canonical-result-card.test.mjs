/**
 * Mission test suite — Phase J: canonical FundingResultCard surfaces.
 *
 * Mission rule: every funding-result surface must render through the
 * canonical FundingResultCard so the user sees the same kind /
 * source_trust / link_status / score / why-matched metadata across the
 * app. Domain-specific cards (pipeline kanban, scoring debugger,
 * profile-matcher diagnostic) are allow-listed below with the reason
 * they are intentionally distinct surfaces, not generic
 * FundingResultCard substitutes.
 *
 * If a new file in src/pages/** or src/components/discovery/** starts
 * rendering grant cards without going through FundingResultCard, this
 * test trips and the build fails until the file is either:
 *   (a) wired to render through FundingResultCard, or
 *   (b) added to ALLOWED_NON_CANONICAL with a documented reason.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// Files that MUST render through FundingResultCard.
const CANONICAL_SURFACES = [
  'src/pages/FundingResults.jsx',
  'src/pages/SavedGrants.jsx',
  'src/components/discovery/SearchResults.jsx',
  'src/pages/DiscoverGrants.jsx',
]

// Files that intentionally render their own card. Each entry MUST
// include a short, factual reason so the mission audit can verify the
// page is not just an old discovery surface bypassing the canonical
// shape.
const ALLOWED_NON_CANONICAL = {
  'src/components/pipeline/GrantCard.jsx':
    'Pipeline-only card: status pills, drag handle, and pipeline-stage actions, not a discovery surface.',
  'src/components/pipeline/KanbanBoard.jsx':
    'Pipeline kanban board — composes pipeline GrantCard, not a discovery surface.',
  'src/components/scoring/ScoringResultCard.jsx':
    'Admin scoring debugger — surfaces raw matcher diagnostics, not a user-facing funding result.',
  'src/pages/AIGrantScorer.jsx':
    'Admin scoring tool — wraps ScoringResultCard, not a user-facing funding result.',
  'src/pages/ProfileMatcher.jsx':
    'Profile-side matcher diagnostic — surfaces score deltas, not a discovery card.',
  'src/pages/SmartMatcher.jsx':
    'Profile-side smart-matcher tool — kept as a diagnostic surface; not a discovery card.',
  'src/pages/ItemFunding.jsx':
    'Item-funding lookup — search-by-item flow with item context, not a generic discovery card.',
  'src/pages/FundingOpportunities.jsx':
    'Admin opportunities table — raw catalog browser, not a discovery card.',
  'src/pages/Automation.jsx':
    'Automation runner: surfaces match_score in run history rows, not a discovery card.',
  'src/pages/Calendar.jsx':
    'Deadline calendar: links out via application_url buttons; not a grant-result card list.',
  'src/pages/DataSources.jsx':
    'Admin data-sources health view: lists crawler sources, not opportunities.',
  'src/pages/Diagnostics.jsx':
    'Admin diagnostics: surfaces opportunity health metrics, not a discovery card.',
  'src/pages/NOFOParser.jsx':
    'NOFO parser tool: extracts a single opportunity from uploaded text; not a discovery card list.',
}

function readIfExists(file) {
  const abs = path.resolve(file)
  if (!fs.existsSync(abs)) return null
  return fs.readFileSync(abs, 'utf8')
}

// ── Locks: every canonical surface imports + renders FundingResultCard ─
for (const file of CANONICAL_SURFACES) {
  test(`phase-j: ${file} imports FundingResultCard`, () => {
    const text = readIfExists(file)
    assert.ok(text, `${file} must exist`)
    const importsCanonical =
      /from\s+['"]@?\/?components\/funding\/FundingResultCard['"]/.test(text) ||
      /from\s+['"][^'"]*funding\/FundingResultCard['"]/.test(text) ||
      // Some surfaces re-render via SearchResults which itself uses the card —
      // accept that as a transitive use as long as SearchResults is imported.
      /from\s+['"][^'"]*discovery\/SearchResults['"]/.test(text)
    assert.ok(
      importsCanonical,
      `${file} must import FundingResultCard (or SearchResults which imports it).`,
    )
  })
}

test('phase-j: SearchResults.jsx renders FundingResultCard (transitive lock)', () => {
  const text = readIfExists('src/components/discovery/SearchResults.jsx')
  assert.ok(text, 'SearchResults.jsx must exist')
  assert.match(text, /<FundingResultCard\b/, 'SearchResults must render <FundingResultCard ... />')
})

// ── Inventory: every ALLOWED_NON_CANONICAL exception is documented ─────
test('phase-j: ALLOWED_NON_CANONICAL entries each have a non-empty reason', () => {
  for (const [file, reason] of Object.entries(ALLOWED_NON_CANONICAL)) {
    assert.ok(typeof reason === 'string' && reason.length >= 20,
      `ALLOWED_NON_CANONICAL[${file}] must include a documented reason (>=20 chars). Got: ${JSON.stringify(reason)}`)
  }
})

// ── Drift detector: any new src/pages/** that renders a "GrantCard"
//    -shaped block without going through FundingResultCard MUST be in
//    ALLOWED_NON_CANONICAL with a reason.
function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
    } else if (entry.isFile() && /\.jsx?$/.test(entry.name)) {
      out.push(full.replace(/\\/g, '/'))
    }
  }
  return out
}

function listSourceFiles() {
  const roots = [
    path.resolve('src/pages'),
    path.resolve('src/components/discovery'),
    path.resolve('src/components/funding'),
  ]
  const seen = new Set()
  for (const root of roots) {
    for (const f of walk(root)) {
      // strip the absolute prefix back to a repo-relative path
      const rel = f.split(/\/src\//)[1]
      if (rel) seen.add('src/' + rel)
    }
  }
  return [...seen].sort()
}

function looksLikeGrantSurface(text) {
  if (!text) return false
  // Heuristic: any file that renders a "card"-shaped element AND
  // contains identifiable funding fields (application_url + match_score
  // / opportunity_kind / source_trust). Keeps the false-positive rate
  // low — generic <Card>s without funding fields don't trip.
  const hasCardElement = /<\s*(Card|FundingResultCard|GrantCard|OpportunityCard)\b/.test(text)
  const hasFundingFields =
    /\b(application_url|opportunity_kind|source_trust|match_score)\b/.test(text)
  return hasCardElement && hasFundingFields
}

test('phase-j: every grant-rendering page is canonical OR explicitly allow-listed', () => {
  const canonicalSet = new Set(CANONICAL_SURFACES.map((p) => p.replace(/\\/g, '/')))
  const allowedSet = new Set(Object.keys(ALLOWED_NON_CANONICAL).map((p) => p.replace(/\\/g, '/')))
  const offenders = []

  for (const file of listSourceFiles()) {
    if (canonicalSet.has(file)) continue
    if (allowedSet.has(file)) continue
    if (file.startsWith('src/components/funding/')) continue // FundingResultCard module + tests
    const text = readIfExists(file)
    if (!looksLikeGrantSurface(text)) continue
    offenders.push(file)
  }

  assert.equal(
    offenders.length,
    0,
    `Phase J drift: the following files render grant-style cards but are neither canonical ` +
      `surfaces nor in ALLOWED_NON_CANONICAL. Add them to one or the other.\n` +
      offenders.map((f) => `  - ${f}`).join('\n'),
  )
})

// ── canonical card itself surfaces every required field ───────────────
test('phase-j: FundingResultCard.jsx renders kind + source_trust_tier + link_status', () => {
  const text = readIfExists('src/components/funding/FundingResultCard.jsx')
  assert.ok(text)
  for (const token of ['kind', 'source_trust_tier', 'link_status']) {
    assert.ok(text.includes(token), `FundingResultCard.jsx must render the canonical ${token} metadata`)
  }
})
