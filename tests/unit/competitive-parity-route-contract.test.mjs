import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

test('portable competitor-parity services are mounted and reachable through clients', () => {
  const server = read('backend/server.js')
  const clients = [
    read('src/api/accountingExchange.js'),
    read('src/api/institutionalDissemination.js'),
    read('src/api/researchRecommendations.js'),
  ].join('\n')

  assert.match(server, /app\.use\('\/api\/accounting-exchange', lazyRouter\('\.\/routes\/accountingExchange\.js'\)\)/)
  assert.match(server, /app\.use\('\/api\/institutional-dissemination', lazyRouter\('\.\/routes\/institutionalDissemination\.js'\)\)/)
  assert.match(server, /app\.use\('\/api\/research-recommendations', lazyRouter\('\.\/routes\/researchRecommendations\.js'\)\)/)
  assert.match(clients, /\/api\/accounting-exchange\/\$\{encodeURIComponent\(grantId\)\}\/export/)
  assert.match(clients, /\/api\/institutional-dissemination\/newsletter-bundle/)
  assert.match(clients, /\/api\/research-recommendations\/rank/)
})

test('every portable parity route enforces its required authority boundary', () => {
  const accounting = read('backend/routes/accountingExchange.js')
  const dissemination = read('backend/routes/institutionalDissemination.js')
  const research = read('backend/routes/researchRecommendations.js')

  assert.match(accounting, /router\.use\(requireAuthenticatedUserMiddleware\)/)
  assert.match(accounting, /ensureGrantAccess\(req, res, grantId\)/)
  assert.match(dissemination, /router\.use\(ensureAuth\)/)
  assert.match(dissemination, /router\.use\(ensureAdmin\)/)
  assert.match(research, /router\.use\(requireAuthenticatedUserMiddleware\)/)
  assert.match(research, /ensureProfileAccess\(req, res, profileId\)/)
})

test('route failures flow through the global error handler', () => {
  for (const relativePath of [
    'backend/routes/accountingExchange.js',
    'backend/routes/institutionalDissemination.js',
    'backend/routes/researchRecommendations.js',
  ]) {
    const source = read(relativePath)
    assert.match(source, /\(req, res, next\)/, `${relativePath} receives next`)
    assert.match(source, /next\(error\)/, `${relativePath} forwards errors`)
    assert.doesNotMatch(source, /catch\s*\([^)]*\)\s*\{[^}]*res\.status/s, `${relativePath} has no inline catch response`)
  }
})
