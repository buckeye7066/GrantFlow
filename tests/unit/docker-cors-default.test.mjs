import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const EXPECTED = [
  'https://grant-flow-three.vercel.app',
  'https://app.axiombiolabs.org',
  'https://grantflow.axiombiolabs.org',
]

test('final runtime stage carries only explicit owned HTTPS origins', async () => {
  const dockerfile = await readFile(new URL('../../Dockerfile', import.meta.url), 'utf8')
  const stages = dockerfile.split(/^FROM\s+/m)
  const runtime = stages.at(-1)
  const matches = [...runtime.matchAll(/^ENV\s+CORS_ORIGIN=(.+)$/gm)]
  assert.equal(matches.length, 1, 'CORS defaults must exist in the runtime, not just the builder')
  const origins = matches[0][1].trim().split(',')
  assert.deepEqual(origins, EXPECTED)
  for (const origin of origins) {
    const parsed = new URL(origin)
    assert.equal(parsed.protocol, 'https:')
    assert.equal(parsed.origin, origin)
    assert.equal(origin.includes('*'), false)
  }
})
