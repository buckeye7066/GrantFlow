import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const workflow = fs.readFileSync(new URL('../../.github/workflows/claude.yml', import.meta.url), 'utf8')
const input = (name, secrets) => {
  const match = workflow.match(new RegExp(`^\\s+${name}: \\$\\{\\{ (.+) \\}\\}\\s*$`, 'm'))
  assert.ok(match, `missing ${name} authentication expression`)
  return vm.runInNewContext(match[1], { secrets }, { timeout: 100 })
}

for (const [oauth, api, expectedApi] of [
  ['fixture-plan', 'fixture-api', ''],
  ['fixture-plan', '', ''],
  ['', 'fixture-api', 'fixture-api'],
  ['', '', ''],
]) {
  test(`Claude workflow auth: subscription=${Boolean(oauth)}, API=${Boolean(api)}`, () => {
    const secrets = { CLAUDE_CODE_OAUTH_TOKEN: oauth, ANTHROPIC_API_KEY: api }
    assert.equal(input('claude_code_oauth_token', secrets), oauth)
    assert.equal(input('anthropic_api_key', secrets), expectedApi)
  })
}

test('Claude step blocks inherited metered credential overrides', () => {
  assert.match(workflow, /env:\s*\n\s+ANTHROPIC_API_KEY: ''\s*\n\s+ANTHROPIC_AUTH_TOKEN: ''/)
})
