import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

test('server startup has exactly one generic schema-migration owner', () => {
  const start = fs.readFileSync('backend/start.js', 'utf8')
  const server = fs.readFileSync('backend/server.js', 'utf8')

  assert.doesNotMatch(start, /runMigrationsInBackground/)
  assert.doesNotMatch(start, /new URL\('\.\/db\/migrate\.js'/)
  assert.match(server, /runPendingMigrationsOnBoot/)
  assert.match(server, /shouldMigrateOnBoot/)
})
