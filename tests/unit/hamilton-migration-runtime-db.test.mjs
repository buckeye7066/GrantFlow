import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const migrationPaths = [
  '../../backend/db/migrations/1001_live_hamilton_task_truth.mjs',
  '../../backend/db/postgres/migrations/1001_live_hamilton_task_truth.mjs',
]

test('Hamilton reconciliation migrations use the full Postgres adapter and fail closed', () => {
  for (const path of migrationPaths) {
    const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /import \{ getDb \}/)
    assert.match(source, /export default async function up\(migrationDb\)/)
    assert.match(
      source,
      /const db = migrationDb\?\.dialect === 'postgres' \? getDb\(\) : migrationDb/,
    )
    assert.match(source, /await runStrictPipelineReconciliation\(db/)
    assert.doesNotMatch(source, /\bcatch\s*\(/)
  }
})
