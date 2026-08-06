import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const configUrl = pathToFileURL(path.join(repoRoot, 'backend/config/designatedProfiles.js')).href
const ensureUrl = pathToFileURL(path.join(repoRoot, 'backend/utils/ensureDesignatedProfiles.js')).href

function isolatedEnv(overrides = {}) {
  const env = { ...process.env }
  for (const key of [
    'DESIGNATED_PROFILES_FILE',
    'NODE_ENV',
    'RAILWAY_DEPLOYMENT_ID',
    'RAILWAY_ENVIRONMENT_ID',
  ]) {
    delete env[key]
  }
  return { ...env, ...overrides }
}

function runModule(script, overrides = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: repoRoot,
    env: isolatedEnv(overrides),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}

function inspectConfig(overrides = {}) {
  return runModule(
    `const config = await import(${JSON.stringify(configUrl)});` +
      `process.stdout.write(JSON.stringify({ source: config.DESIGNATED_PROFILES_SOURCE, count: config.DESIGNATED_PROFILES.length }));`,
    overrides,
  )
}

test('production without a private roster never exposes public designated fixtures', () => {
  assert.deepEqual(inspectConfig({ NODE_ENV: 'production' }), {
    source: 'disabled_missing_private_file',
    count: 0,
  })
  assert.deepEqual(
    inspectConfig({
      NODE_ENV: 'production',
      DESIGNATED_PROFILES_FILE: path.join(tmpdir(), 'grantflow-roster-does-not-exist.json'),
    }),
    {
      source: 'disabled_missing_private_file',
      count: 0,
    },
  )
})

test('a Railway deployment also fails closed when NODE_ENV is not set', () => {
  assert.deepEqual(inspectConfig({ RAILWAY_ENVIRONMENT_ID: 'railway-test-environment' }), {
    source: 'disabled_missing_private_file',
    count: 0,
  })
})

test('the disabled production seeder returns before touching the database', () => {
  const result = runModule(
    `const { ensureDesignatedProfiles } = await import(${JSON.stringify(ensureUrl)});` +
      `const db = new Proxy({}, { get() { throw new Error('database_was_touched') } });` +
      `process.stdout.write(JSON.stringify(await ensureDesignatedProfiles(db)));`,
    { NODE_ENV: 'production' },
  )
  assert.deepEqual(result, {
    ok: false,
    skipped: true,
    reason: 'private_designated_profiles_unavailable',
    profiles: 0,
  })
})

test('production resolver still resolves existing rows directly without enabling alias reseeding', () => {
  const result = runModule(
    `const resolver = await import(${JSON.stringify(
      pathToFileURL(path.join(repoRoot, 'backend/utils/profileResolver.js')).href,
    )});` +
      `const db = { prepare(sql) { return { async get(id) {` +
      `return sql.includes('WHERE id = ?') && id === 'existing-private-profile'` +
      ` ? { id, display_name: 'Existing Private Profile', status: 'active' } : null;` +
      `} }; } };` +
      `const direct = await resolver.resolveProfileForId(db, 'existing-private-profile');` +
      `const missing = await resolver.resolveProfileForId(db, 'missing-private-alias');` +
      `process.stdout.write(JSON.stringify({ direct, missing, aliasKnown: resolver.isDesignatedProfileSlug('missing-private-alias') }));`,
    { NODE_ENV: 'production' },
  )
  assert.equal(result.direct.strategy, 'direct')
  assert.equal(result.direct.resolvedId, 'existing-private-profile')
  assert.equal(result.missing, null)
  assert.equal(result.aliasKnown, false)
})

test('production accepts a readable private roster instead of public fixtures', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'grantflow-private-profiles-'))
  try {
    const rosterPath = path.join(directory, 'profiles.json')
    await writeFile(
      rosterPath,
      JSON.stringify({
        profiles: [
          {
            id: 'private-profile-fixture',
            display_name: 'Private Profile Fixture',
            primary_type: 'individual',
            sections: {},
          },
        ],
      }),
      'utf8',
    )
    assert.deepEqual(inspectConfig({ NODE_ENV: 'production', DESIGNATED_PROFILES_FILE: rosterPath }), {
      source: 'private_file',
      count: 1,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('local development retains synthetic public fixtures', () => {
  const result = inspectConfig({ NODE_ENV: 'development' })
  assert.equal(result.source, 'public_fixture')
  assert.ok(result.count > 0)
})
