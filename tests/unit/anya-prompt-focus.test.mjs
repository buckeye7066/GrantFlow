import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Regression tests for Anya's system prompt. Pins the rules that fix the
 * "Anya doesn't follow along with what the user asks" bug:
 *
 *  1. CURRENT-TURN FOCUS: the reply must address the LAST user message,
 *     not a different topic from history.
 *  2. CROSS-PROFILE GUARD: Anya may only act on the active profile.
 *  3. NO VAGUE PROMISES: "let me run a diagnostic" without actually
 *     calling a tool is banned.
 *  4. pipeline.getTotals must be in the chat tool whitelist and the
 *     prompt must reference it for pipeline-total questions.
 *
 * These tests intentionally read the source file, not import the module,
 * because the orchestrator pulls in OpenAI/Anthropic clients at import
 * time and we want the contract check to be cheap and offline.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const ORCHESTRATOR = path.join(REPO_ROOT, 'backend', 'services', 'anyaOrchestrator.js')

const SOURCE = fs.readFileSync(ORCHESTRATOR, 'utf8')

test('system prompt contains CURRENT-TURN FOCUS rule', () => {
  assert.ok(
    SOURCE.includes('CURRENT-TURN FOCUS'),
    'Anya system prompt MUST start with a CURRENT-TURN FOCUS rule so she answers the user\'s latest message',
  )
  assert.ok(
    SOURCE.includes('most recent message') || SOURCE.includes('MOST RECENT message'),
    'CURRENT-TURN FOCUS rule must explicitly tell Anya to address the most recent message',
  )
})

test('system prompt contains CROSS-PROFILE GUARD rule', () => {
  assert.ok(
    SOURCE.includes('CROSS-PROFILE GUARD'),
    'Anya system prompt MUST include a CROSS-PROFILE GUARD so she does not switch profiles mid-turn',
  )
  assert.ok(
    SOURCE.includes('ACTIVE PROFILE'),
    'CROSS-PROFILE GUARD must reference the ACTIVE PROFILE so Anya knows the scope of "valid" data',
  )
})

test('system prompt bans vague "let me run a diagnostic" without a tool call', () => {
  assert.ok(
    SOURCE.includes('NO VAGUE PROMISES'),
    'Anya prompt MUST include NO VAGUE PROMISES rule banning "let me run a diagnostic" without a tool call',
  )
  assert.ok(
    SOURCE.includes('let me run a diagnostic') || SOURCE.includes('run a diagnostic'),
    'NO VAGUE PROMISES rule should explicitly call out the "diagnostic" phrasing the user reported',
  )
})

test('pipeline.getTotals is in the chat tool whitelist', () => {
  const whitelistMatch = SOURCE.match(/const CHAT_TOOL_WHITELIST = \[([\s\S]*?)\]/)
  assert.ok(whitelistMatch, 'CHAT_TOOL_WHITELIST literal must exist')
  const whitelist = [...whitelistMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  assert.ok(
    whitelist.includes('pipeline.getTotals'),
    'pipeline.getTotals must be whitelisted so Anya can actually call it when the user asks about pipeline totals',
  )
})

test('static prompt references pipeline.getTotals tool', () => {
  assert.ok(
    SOURCE.includes('pipeline.getTotals'),
    'Anya prompt must mention pipeline.getTotals so she knows to call it for total/count questions',
  )
})

test('pipeline.getTotals tool is registered with the right shape', () => {
  const registry = fs.readFileSync(
    path.join(REPO_ROOT, 'backend', 'services', 'anyaToolRegistry.js'),
    'utf8',
  )
  assert.ok(
    registry.includes("name: 'pipeline.getTotals'"),
    'pipeline.getTotals tool must be registered in anyaToolRegistry.js',
  )
  assert.ok(
    /pipeline\.getTotals[\s\S]{0,2000}handler:\s*async/.test(registry),
    'pipeline.getTotals must have an async handler',
  )
})
