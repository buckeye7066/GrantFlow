import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const server = fs.readFileSync(new URL('../../backend/server.js', import.meta.url), 'utf8')

test('production server wires the bounded GitHub OIDC verifier into its actual identity resolver', () => {
  assert.match(server, /verifyZipClosureOidc\(githubOidcToken\)/)
  assert.match(server, /isZipClosureRequest\(req\.method, req\.originalUrl\)/)
  assert.match(server, /userId: 'system_github_zip_closure'/)
  assert.match(server, /'X-GitHub-OIDC-Token'/)
})
