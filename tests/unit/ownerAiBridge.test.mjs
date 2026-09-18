import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { runWithOwnerAiScope, getOwnerAiScope, isCanonicalOwner } from '../../backend/services/ownerAi/ownerAiScope.js'
import { createOwnerAiBroker } from '../../backend/services/ownerAi/ownerAiBroker.js'
import { subscriptionAuth, childEnvironment, cliArguments, parseResult } from '../../tools/owner-ai/officialCli.mjs'

process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
const req = () => ({ ctx: { identityResolved: true, isAdmin: true, userId: 'real-owner', email: 'owner@example.test' }, res: new EventEmitter() })
const env = { OWNER_AI_BRIDGE_ENABLED: 'true', OWNER_AI_BRIDGE_TOKEN: 'x'.repeat(48) }
const options = { format: 'json', prompt: 'private input', system: '', maxTokens: 100, timeoutMs: 1000 }
const heartbeat = { providers: { codex: 'unavailable', claude: 'ready' } }
const result = { ok: true, provider: 'subscription:claude', model: 'claude-test', billing_mode: 'subscription', complete: true, raw: '{"answer":42}', usage: { output_tokens: 6 } }

test('authority comes only from exact canonical owner, never raw claims or service identities', () => {
  assert.equal(isCanonicalOwner(req()), true)
  for (const patch of [{ email: 'other@example.test' }, { isAdmin: false }, { identityResolved: false }, { userId: 'system_admin_token' }, { userId: '' }]) {
    const r = req(); Object.assign(r.ctx, patch); r.user = { email: 'owner@example.test', role: 'admin' }; r.body = req().ctx
    assert.equal(isCanonicalOwner(r), false)
  }
  for (const flag of ['serviceToken', 'profileTokenAuth']) { const r = req(); r.user = { [flag]: true }; assert.equal(isCanonicalOwner(r), false) }
  process.env.OWNER_AI_USER_ID = 'different'; assert.equal(isCanonicalOwner(req()), false); delete process.env.OWNER_AI_USER_ID
})
test('response close revokes inherited scope and cancels pending work', async () => {
  const r = req(); const b = createOwnerAiBroker({ env }); b.poll(heartbeat)
  await runWithOwnerAiScope(r, async () => { assert.ok(getOwnerAiScope()); const p = b.trySubscription(options); r.res.emit('close'); assert.equal(getOwnerAiScope(), null); assert.equal(await p, null); assert.equal(b.poll(heartbeat).job, null) })
})
test('no scope, disabled, missing secret, offline, zero budget and pre-abort never queue', async () => {
  const b = createOwnerAiBroker({ env }); b.poll(heartbeat); assert.equal(await b.trySubscription(options), null)
  await runWithOwnerAiScope(req(), async () => {
    for (const config of [{}, { OWNER_AI_BRIDGE_ENABLED: 'true' }, env]) assert.equal(await createOwnerAiBroker({ env: config }).trySubscription(options), null)
    assert.equal(await b.trySubscription({ ...options, timeoutMs: 0 }), null)
    assert.equal(await b.trySubscription({ ...options, signal: AbortSignal.abort() }), null)
    assert.equal(b.poll(heartbeat).job, null)
  })
})
test('single claim, busy refusal, lease fencing, complete JSON, replay rejection', async () => {
  const b = createOwnerAiBroker({ env }); b.poll(heartbeat)
  await runWithOwnerAiScope(req(), async () => {
    const p = b.trySubscription(options); assert.equal(await b.trySubscription(options), null)
    const { job } = b.poll(heartbeat); assert.equal(job.prompt, options.prompt); assert.equal(b.poll(heartbeat).job, null)
    assert.equal(b.result({ id: job.id, lease: 'wrong', result }), false)
    assert.equal(b.result({ id: job.id, lease: job.lease, result }), true)
    assert.deepEqual((await p).json, { answer: 42 }); assert.equal(b.result({ id: job.id, lease: job.lease, result }), false)
    assert.equal(JSON.stringify(b.status()).includes('private input'), false)
  })
})
for (const invalid of [{ ...result, ok: false }, { ...result, complete: false }, { ...result, raw: '' }, { ...result, raw: '{' }, { ...result, provider: 'subscription:codex' }, { ...result, usage: { output_tokens: 100 } }]) {
  test('reject invalid/truncated/quota output ' + JSON.stringify(invalid), async () => {
    const b = createOwnerAiBroker({ env }); b.poll(heartbeat)
    await runWithOwnerAiScope(req(), async () => { const p = b.trySubscription(options); const { job } = b.poll(heartbeat); b.result({ id: job.id, lease: job.lease, result: invalid }); assert.equal(await p, null) })
  })
}
test('abort and expiration delete jobs and reject late results', async () => {
  for (const abort of [true, false]) {
    const b = createOwnerAiBroker({ env }); b.poll(heartbeat)
    await runWithOwnerAiScope(req(), async () => { const c = new AbortController(); const p = b.trySubscription({ ...options, signal: c.signal, timeoutMs: 10 }); const { job } = b.poll(heartbeat); if (abort) c.abort(); assert.equal(await p, null); assert.equal(b.result({ id: job.id, lease: job.lease, result }), false) })
  }
})
test('native auth rejects API and ambiguous Claude plans', () => {
  assert.equal(subscriptionAuth('codex', 'Logged in using ChatGPT'), true)
  assert.equal(subscriptionAuth('codex', 'Logged in using an API key'), false)
  for (const subscriptionType of [null, '', 'unknown']) assert.equal(subscriptionAuth('claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType, apiKeySource: 'managed' })), false)
  assert.equal(subscriptionAuth('claude', JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })), true)
})
test('CLI environment allowlist strips secrets/overrides; prompts never become arguments', () => {
  const clean = childEnvironment('claude', { LOCALAPPDATA: 'C:/Local', PATH: 'bin', ANTHROPIC_API_KEY: 'secret', AUTH_TOKEN: 'secret', NODE_OPTIONS: '--require evil', OPENAI_BASE_URL: 'evil', apiKeyHelper: 'evil', OWNER_AI_BRIDGE_TOKEN: 'secret' })
  assert.equal(clean.PATH, 'bin'); assert.equal(clean.CLAUDE_CONFIG_DIR, 'C:/Local/GrantFlow/subscriptions/claude'.replaceAll('/', process.platform === 'win32' ? '\\' : '/'))
  for (const key of ['ANTHROPIC_API_KEY', 'AUTH_TOKEN', 'NODE_OPTIONS', 'OPENAI_BASE_URL', 'apiKeyHelper', 'OWNER_AI_BRIDGE_TOKEN']) assert.equal(clean[key], undefined)
  const args = cliArguments('claude'); assert.equal(args[args.indexOf('--tools') + 1], ''); assert.ok(args.includes('--safe')); assert.ok(args.includes('--strict-mcp-config')); assert.equal(args.some(x => x.includes('private input')), false)
  assert.ok(cliArguments('codex').includes('forced_login_method=chatgpt'))
})
test('CLI result requires successful terminal event and known model; quotas fail', () => {
  const good = { type: 'result', subtype: 'success', is_error: false, result: '{"a":1}', stop_reason: 'end_turn', modelUsage: { 'claude-test': {} }, usage: { output_tokens: 10 } }
  assert.equal(parseResult('claude', JSON.stringify(good)).ok, true)
  for (const patch of [{ subtype: 'error_max_turns' }, { is_error: true }, { stop_reason: 'max_tokens' }, { result: '' }, { modelUsage: {} }]) assert.equal(parseResult('claude', JSON.stringify({ ...good, ...patch })), null)
})
test('worker mount precedes normal identity; owner status follows canonical context', () => {
  const src = readFileSync(new URL('../../backend/server.js', import.meta.url), 'utf8')
  const worker = src.indexOf("app.use('/api/owner-ai/worker'")
  assert.ok(worker > 0 && worker < src.indexOf('app.use(attachRequestContext())'))
  assert.ok(src.indexOf("app.use('/api/admin/owner-ai'") > src.indexOf('app.use(attachRequestContext())'))
  const context = readFileSync(new URL('../../backend/middleware/requestContext.js', import.meta.url), 'utf8')
  assert.match(context, /runWithOwnerAiScope\(req,/)
})
