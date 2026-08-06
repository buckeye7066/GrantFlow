import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const SEED_PATHS = [
  'backend/utils/seedOnStartup.js',
  'scripts/prepopulate-profile-grants.mjs',
  'scripts/seed-profile-grants.mjs',
  'scripts/seed-matched-grants.mjs',
  'backend/scripts/seed-profile-grants.mjs',
]

function readSource(relativePath) {
  return readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function admissionSource(relativePath) {
  const source = readSource(relativePath)
  if (relativePath !== 'backend/utils/seedOnStartup.js') return source

  const start = source.indexOf('export async function seedProfileGrants')
  const end = source.indexOf('export function cleanupIrrelevantGrants', start)
  assert.ok(start >= 0 && end > start, 'startup seed admission region must remain discoverable')
  return source.slice(start, end)
}

test('seed authority: legacy heuristic and relevance verdicts cannot pre-adjudicate candidates', () => {
  for (const relativePath of SEED_PATHS) {
    const source = admissionSource(relativePath)
    assert.doesNotMatch(source, /\bapplyRelevanceFilter\b/, `${relativePath} uses a retired relevance verdict`)
    assert.doesNotMatch(source, /\bscoreOpportunity\b/, `${relativePath} uses a pre-canonical score verdict`)
    assert.doesNotMatch(
      source,
      /\b(?:score|match_score|heuristicScore)\s*(?:>=|<=|>|<)\s*(?:5|40|80)\b/,
      `${relativePath} retains a retired numeric admission trial`,
    )
    assert.doesNotMatch(
      source,
      /if\s*\(\s*[^)]*\.requires_match\s*\)\s*continue/,
      `${relativePath} hides match-fund candidates before canonical adjudication`,
    )
  }
})

test('seed authority: every seeder ranks only after canonical adjudication', () => {
  for (const relativePath of SEED_PATHS) {
    const source = admissionSource(relativePath)
    const adjudicationIndex = source.indexOf('computeMatchDecision(')
    const rankingIndex = source.indexOf('.sort(', adjudicationIndex)

    assert.ok(adjudicationIndex >= 0, `${relativePath} must call computeMatchDecision`)
    assert.ok(rankingIndex > adjudicationIndex, `${relativePath} must rank only after adjudication`)
    assert.match(
      source,
      /decision\.decision\s*===\s*['"]ACCEPT['"]/,
      `${relativePath} must collect canonical ACCEPT rows explicitly`,
    )
    assert.doesNotMatch(
      source,
      /decision\.decision\s*!==\s*['"]REJECT['"]/,
      `${relativePath} must not auto-admit REVIEW as merely non-REJECT`,
    )
  }
})

test('seed authority: canonical scores are labels, not rendered percentages', () => {
  for (const relativePath of SEED_PATHS) {
    const source = admissionSource(relativePath)
    assert.doesNotMatch(
      source,
      /\$\{[^}\n]*(?:score|Score)[^}\n]*\}\s*%/,
      `${relativePath} renders a versioned canonical score as a percentage`,
    )
    assert.doesNotMatch(
      source,
      /\b(?:5|40|80|100)%\+?\s*(?:match|canonical)/i,
      `${relativePath} advertises a retired percentage threshold`,
    )
  }
})

test('seed authority: every active helper remains fail-closed in production', () => {
  for (const relativePath of SEED_PATHS) {
    const source = readSource(relativePath)
    assert.match(source, /NODE_ENV/, `${relativePath} must inspect NODE_ENV`)
    assert.match(source, /production/i, `${relativePath} must block production`)
    assert.match(source, /DISABLE_SEEDING/, `${relativePath} must honor DISABLE_SEEDING`)
  }
})

test('seed authority: script entry points exit before opening a production database', () => {
  for (const relativePath of SEED_PATHS.filter((entry) => entry !== 'backend/utils/seedOnStartup.js')) {
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, relativePath)], {
      cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'production', DISABLE_SEEDING: '' },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, `${relativePath} must refuse production execution`)
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /seed(?:ing)? disabled|refusing to run in production/i,
      `${relativePath} must explain its production refusal`,
    )
  }
})

test('seed authority: startup profile seeding touches no database in production', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousDisableSeeding = process.env.DISABLE_SEEDING
  process.env.NODE_ENV = 'production'
  delete process.env.DISABLE_SEEDING

  try {
    const { seedProfileGrants } = await import('../../backend/utils/seedOnStartup.js')
    const throwingDb = new Proxy({}, {
      get() {
        throw new Error('production guard touched the database')
      },
    })
    assert.equal(await seedProfileGrants(throwingDb), 0)
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
    if (previousDisableSeeding === undefined) delete process.env.DISABLE_SEEDING
    else process.env.DISABLE_SEEDING = previousDisableSeeding
  }
})
