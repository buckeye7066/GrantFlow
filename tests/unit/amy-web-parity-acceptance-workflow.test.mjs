import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const workflow = fs.readFileSync('.github/workflows/amy-web-parity-acceptance.yml', 'utf8')

test('manual Amy/parity acceptance runs the hermetic exact-50 command', () => {
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /node-version-file: \.nvmrc/)
  assert.match(workflow, /scripts\/grantflow-acceptance-50\.mjs/)
  assert.match(workflow, /--expected-sha="\$\(git rev-parse HEAD\)"/)
  assert.doesNotMatch(workflow, /GRANTFLOW_PROD_AUDIT_DATABASE_URL|DATABASE_URL:/)
  assert.match(workflow, /openai_web_search/)
})

test('failed acceptance uploads its receipt before keeping the workflow red', () => {
  const runIndex = workflow.indexOf('name: Run isolated exact-50 acceptance')
  const uploadIndex = workflow.indexOf('name: Upload immutable acceptance receipt')
  const enforceIndex = workflow.indexOf('name: Require acceptance to pass')
  assert.ok(runIndex >= 0 && uploadIndex > runIndex && enforceIndex > uploadIndex)
  assert.match(workflow, /continue-on-error: true/)
  assert.match(workflow, /steps\.acceptance\.outcome != 'success'/)
})

test('paid route configuration is passed through a repository variable in env', () => {
  assert.match(workflow, /AI_PAID_ROUTES: \$\{\{ vars\.AI_PAID_ROUTES \}\}/)
  assert.doesNotMatch(workflow, /run:[\s\S]*\$\{\{ vars\.AI_PAID_ROUTES/)
})
