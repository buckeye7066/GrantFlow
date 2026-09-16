import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const hamilton = fs.readFileSync('docs/HAMILTON_APPLICATION_AGENT.md', 'utf8')
const canonical = fs.readFileSync('docs/canonical_rules.md', 'utf8')
const charter = fs.readFileSync('docs/AGENT_AUTOMATION_CHARTER.md', 'utf8')
const server = fs.readFileSync('backend/server.js', 'utf8')
const orchestrator = fs.readFileSync('backend/services/hamilton/hamiltonAutomationOrchestrator.js', 'utf8')

test('Hamilton docs preserve the owner-ratified Complete Autonomy submission contract', () => {
  for (const text of [hamilton, canonical]) {
    assert.match(text, /Complete Autonomy/)
    assert.match(text, /allow_auto_submit/)
    assert.match(text, /real portal/i)
    assert.match(text, /durable portal confirmation/i)
  }

  assert.doesNotMatch(hamilton, /every real-domain final submission is\s+completed by the owner/i)
  assert.doesNotMatch(hamilton, /never[\s\S]{0,120}performs final submission on a real portal/i)
  assert.doesNotMatch(hamilton, /only executable browser path is the reserved synthetic fixture/i)
  assert.doesNotMatch(hamilton, /does not launch a server browser/i)
  assert.match(charter, /configured, compliant helpers/)
  assert.match(charter, /standing Complete Autonomy\s+consent/)

  assert.match(
    server,
    /app\.use\('\/api\/hamilton\/automation', requireHamiltonPipelineAutomation, lazyRouter\('\.\/routes\/hamiltonAutomation\.js'\)\)/,
  )
  assert.match(orchestrator, /const beforeSubmit = async[\s\S]*resolveSubmissionDecision\(db,[\s\S]*taskAllowAutoSubmit: liveTask\.allow_auto_submit/)
  assert.match(orchestrator, /runAutopilot\([\s\S]*beforeSubmit,/)
})
