import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const hamilton = fs.readFileSync('docs/HAMILTON_APPLICATION_AGENT.md', 'utf8')
const canonical = fs.readFileSync('docs/canonical_rules.md', 'utf8')
const server = fs.readFileSync('backend/server.js', 'utf8')
const fullAutomation = fs.readFileSync('backend/services/hamilton/hamiltonFullAutomationMode.js', 'utf8')

test('Hamilton docs preserve the owner-ratified Complete Autonomy submission contract', () => {
  for (const text of [hamilton, canonical]) {
    assert.match(text, /Complete Autonomy/)
    assert.match(text, /allow_auto_submit/)
    assert.match(text, /real portal/i)
    assert.match(text, /durable portal confirmation/i)
  }

  assert.doesNotMatch(hamilton, /every real-domain final submission is\s+completed by the owner/i)
  assert.doesNotMatch(hamilton, /never[\s\S]{0,120}performs final submission on a real portal/i)

  assert.match(server, /requireHamiltonPipelineAutomation[\s\S]*requirePipelineAutomation/)
  assert.match(fullAutomation, /'submit_applications'/)
  assert.match(fullAutomation, /allow_auto_submit: true/)
  assert.match(fullAutomation, /require_human_review: false/)
})
