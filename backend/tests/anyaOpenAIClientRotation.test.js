import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

// Exercise the private production getter without importing Anya's unrelated
// tool registry or making provider calls. The function body is read from the
// actual module, not copied into this test.
const source = readFileSync(new URL('../services/anyaOrchestrator.js', import.meta.url), 'utf8')
const getter = source.match(/function getOpenAIClient\(\) \{[\s\S]*?\n\}/)?.[0]
if (!getter) throw new Error('Cannot locate the production OpenAI getter')

function loadGetter() {
  let activeKey = 'initial-test-key'
  const context = { createOpenAIClient() {
    if (!activeKey) throw new Error('OpenAI is not configured')
    return { openai: { key: activeKey } }
  } }
  vm.createContext(context)
  // The previous implementation used this module-level cache. Retain its
  // declaration in the harness so the old behavior fails on stale credentials,
  // not on an unrelated ReferenceError.
  vm.runInContext('let cachedOpenAI = null;\n' + getter, context)
  return { get: () => context.getOpenAIClient(), setKey: (key) => { activeKey = key } }
}

describe('Anya credential rotation without process restart', () => {
  it('uses the newly active credential after an earlier request', () => {
    const client = loadGetter()
    expect(client.get().key).toBe('initial-test-key')
    client.setKey('replacement-test-key')
    expect(client.get().key).toBe('replacement-test-key')
  })
  it('does not keep using a removed credential', () => {
    const client = loadGetter()
    client.get()
    client.setKey('')
    expect(() => client.get()).toThrow('OpenAI is not configured')
  })
  it('recovers with the next configured credential after clearing', () => {
    const client = loadGetter()
    client.get()
    client.setKey('')
    try { client.get() } catch { /* expected while unconfigured */ }
    client.setKey('restored-test-key')
    expect(client.get().key).toBe('restored-test-key')
  })
})
