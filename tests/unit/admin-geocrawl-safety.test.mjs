import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const scriptPath = new URL('../../scripts/admin-geocrawl-until-complete.mjs', import.meta.url)
const source = readFileSync(scriptPath, 'utf8')

test('mutating geocrawl script has no live URL or credential defaults', () => {
  assert.doesNotMatch(source, /axiombiolabs\.org/i)
  assert.doesNotMatch(source, /const\s+(?:EMAIL|PASSWORD|ADMIN_TOKEN)\s*=\s*['"][^'"]+['"]/)
  assert.match(source, /requiredEnv\('GF_API'\)/)
  assert.match(source, /GF_CONFIRM_MUTATING_HOST/)
  assert.match(source, /GF_ADMIN_TOKEN/)
  assert.match(source, /GF_ADMIN_EMAIL/)
  assert.match(source, /GF_ADMIN_PASSWORD/)
})

test('mutating geocrawl script fails before network access without explicit target', () => {
  const env = { ...process.env }
  for (const key of [
    'GF_API',
    'GF_CONFIRM_MUTATING_HOST',
    'GF_ADMIN_TOKEN',
    'GF_ADMIN_EMAIL',
    'GF_ADMIN_PASSWORD',
  ]) delete env[key]

  const result = spawnSync(process.execPath, [scriptPath.pathname], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GF_API is required/)
})

test('mutating geocrawl script requires exact host confirmation', () => {
  const env = {
    ...process.env,
    GF_API: 'https://api.example.test/api',
    GF_CONFIRM_MUTATING_HOST: 'different.example.test',
    GF_ADMIN_TOKEN: 'fixture-token',
  }
  const result = spawnSync(process.execPath, [scriptPath.pathname], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must exactly match/)
})
