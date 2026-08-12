import test from 'node:test'
import assert from 'node:assert/strict'
import { validateWorkflowNodeRuntime } from '../../scripts/lib/workflow-node-runtime.mjs'

test('accepts an exact inline runtime pin and an .nvmrc pin', () => {
  const workflow = `
jobs:
  inline:
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 20.20.2
  file:
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
`

  assert.deepEqual(validateWorkflowNodeRuntime(workflow), [])
})

test('does not let a matrix node-version satisfy an unpinned setup-node step', () => {
  const workflow = `
jobs:
  build:
    strategy:
      matrix:
        node-version: [20.20.2]
    steps:
      - uses: actions/setup-node@v7
`

  assert.deepEqual(validateWorkflowNodeRuntime(workflow), [
    'workflow.yml job build step 1 must provide exactly one of node-version or node-version-file',
  ])
})

test('ignores node-version inputs belonging to other actions', () => {
  const workflow = `
jobs:
  build:
    steps:
      - uses: example/other-action@v1
        with:
          node-version: 22
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
`

  assert.deepEqual(validateWorkflowNodeRuntime(workflow), [])
})

test('rejects setup-node steps that specify both pin mechanisms', () => {
  const workflow = `
jobs:
  build:
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: 20.20.2
          node-version-file: .nvmrc
`

  assert.equal(validateWorkflowNodeRuntime(workflow).length, 1)
})

test('enforces the active runtime at each mobile command boundary', () => {
  const workflow = `
jobs:
  mobile:
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version-file: .nvmrc
      - run: node scripts/release-gates.mjs
      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version-mobile
      - run: npx cap sync android
`
  const options = {
    allowedNodeVersionFiles: ['.nvmrc', '.node-version-mobile'],
    requiredRuntimeBeforeCommands: [
      { command: 'node scripts/release-gates.mjs', field: 'node-version-file', value: '.nvmrc' },
      { command: 'npx cap sync android', field: 'node-version-file', value: '.node-version-mobile' },
    ],
  }

  assert.deepEqual(validateWorkflowNodeRuntime(workflow, options), [])

  const missingRuntimeSwitch = workflow.replace(`
      - uses: actions/setup-node@v7
        with:
          node-version-file: .node-version-mobile`, '')
  assert.match(
    validateWorkflowNodeRuntime(missingRuntimeSwitch, options).join('\n'),
    /npx cap sync android must run after node-version-file: \.node-version-mobile/,
  )
})
