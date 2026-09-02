import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAT_CALLABLE_TOOL_DOCS,
  CHAT_TOOL_WHITELIST,
} from '../../backend/services/anyaOrchestrator.js'

const REQUIRED_LIVE_STATUS_TOOLS = [
  'system.health',
  'admin.crawler.list',
  'admin.crawler.check',
  'admin.hamilton.sessionReadiness',
  'admin.hamilton.portalAutopilotReadiness',
  'admin.anya.getStatus',
  'owner.get_self_heal_status',
  'owner.get_portal_sync_status',
  'owner.coverage_audit_status',
]

test('Anya chat can ground owner operational answers in live read-only tools', () => {
  const documented = new Map(CHAT_CALLABLE_TOOL_DOCS)
  for (const name of REQUIRED_LIVE_STATUS_TOOLS) {
    assert.ok(CHAT_TOOL_WHITELIST.includes(name), `${name} must be callable from chat`)
    assert.match(documented.get(name) || '', /read-only/i)
  }
})

test('Anya chat tool names remain unique', () => {
  assert.equal(new Set(CHAT_TOOL_WHITELIST).size, CHAT_TOOL_WHITELIST.length)
})
