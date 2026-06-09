/**
 * Mission System 8 (RC-11): Anya must not advertise as "directly callable" any
 * tool the chat path will not actually hand the model. The chat path exposes
 * ONLY CHAT_TOOL_WHITELIST to the model, and the prompt's "tools you can call
 * RIGHT NOW" section is generated from CHAT_CALLABLE_TOOL_DOCS — so the two must
 * be identical, and every advertised tool must be a real registered tool.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAT_TOOL_WHITELIST,
  CHAT_CALLABLE_TOOL_DOCS,
} from '../../backend/services/anyaOrchestrator.js'
import { listToolMetadata } from '../../backend/services/anyaToolRegistry.js'

test('the prompt callable-tools list is exactly the chat whitelist (no drift)', () => {
  const docNames = CHAT_CALLABLE_TOOL_DOCS.map(([name]) => name)
  assert.deepEqual(docNames, CHAT_TOOL_WHITELIST)
})

test('every chat-callable tool Anya is told it can call is actually registered', () => {
  const registered = new Set(listToolMetadata().map((t) => t.name))
  for (const name of CHAT_TOOL_WHITELIST) {
    assert.ok(registered.has(name), `whitelisted/advertised tool is not registered: ${name}`)
  }
})

test('each advertised callable tool has a non-empty description', () => {
  for (const [name, desc] of CHAT_CALLABLE_TOOL_DOCS) {
    assert.ok(
      typeof desc === 'string' && desc.trim().length > 0,
      `missing description for advertised tool: ${name}`,
    )
  }
})
