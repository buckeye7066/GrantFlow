import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/nationwide-zip-closure.yml', 'utf8')

test('ZIP closure is bounded, resumable, serialized, and explicitly production-bound', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /group: nationwide-zip-closure-production/)
  assert.match(workflow, /environment: production-audit/)
  assert.match(workflow, /GF_CONFIRM_MUTATING_HOST: grantflow-production\.up\.railway\.app/)
  assert.match(workflow, /GF_ADMIN_TOKEN: \$\{\{ secrets\.ANYA_ADMIN_TOKEN \}\}/)
  assert.match(workflow, /--max-runs="\$\{\{ inputs\.max_runs \}\}"/)
  assert.match(workflow, /--max-zips="\$\{\{ inputs\.max_zips \}\}"/)
  assert.match(workflow, /--target-percent=100/)
  assert.match(workflow, /--poll-ms=60000/)
})
