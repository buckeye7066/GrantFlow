import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('package and release gate agree on the Node 24 production runtime', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'))
  const gate = await readFile('scripts/release-gates.mjs', 'utf8')

  assert.equal(pkg.engines.node, '24.x')
  assert.match(gate, /REQUIRED_NODE_MAJOR\s*=\s*24/)
  assert.doesNotMatch(gate, /20\.20\.2|assertNode20Runtime/)
})
