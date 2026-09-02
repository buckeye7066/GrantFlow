import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

test('Anya health counts tool usage through the schema timestamp column', () => {
  const route = readFileSync(path.join(repoRoot, 'backend/routes/anya.js'), 'utf8')
  const schema = readFileSync(path.join(repoRoot, 'backend/db/schema.sql'), 'utf8')
  const table = schema.match(/CREATE TABLE IF NOT EXISTS anya_tool_usage \(([\s\S]*?)\n\);/)

  assert.ok(table, 'anya_tool_usage table definition is missing')
  assert.match(table[1], /\bcreated_at\b/)
  assert.match(
    route,
    /FROM anya_tool_usage WHERE created_at >= \?/,
    'health must query the same timestamp column every writer and cleanup job use',
  )
  assert.doesNotMatch(route, /FROM anya_tool_usage WHERE ts >= \?/)
})
