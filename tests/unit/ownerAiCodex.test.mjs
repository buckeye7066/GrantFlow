import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { cliArguments, parseResult, probeProvider, runChild, executeJob, subscriptionAuth } from '../../tools/owner-ai/officialCli.mjs'
import { isCanonicalOwner, runWithOwnerAiScope } from '../../backend/services/ownerAi/ownerAiScope.js'
import { createOwnerAiBroker } from '../../backend/services/ownerAi/ownerAiBroker.js'

const disabled = 'shell_tool unified_exec apps plugins remote_plugin browser_use browser_use_external image_generation view_image multi_agent tool_suggest skill_search skill_mcp_dependency_install in_app_browser memories sleep_tool'.split(' ')
const help = '--sandbox --ephemeral --ignore-user-config --strict-config --skip-git-repo-check --json --model --config --disable'
const features = disabled.map(name => `${name}\texperimental\ttrue`).join('\n')
const events = [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: '1', type: 'agent_message', text: '{"answer":42}' } }, { type: 'turn.completed', usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 6 } }]
const ndjson = list => list.map(x => JSON.stringify(x)).join('\n') + '\n'
const env = { LOCALAPPDATA: 'C:/Local', OPENAI_API_KEY: 'synthetic', ANTHROPIC_API_KEY: 'synthetic', CODEX_API_KEY: 'synthetic', OPENAI_BASE_URL: 'synthetic', OWNER_AI_BRIDGE_TOKEN: 'synthetic' }
const job = { providers: ['codex', 'claude'], timeoutMs: 1000, maxTokens: 100, prompt: 'synthetic private input', system: '', format: 'json' }
const claudeHelp = '--safe-mode --tools --strict-mcp-config --setting-sources --permission-prompts'
function fakeRun(calls, inference = () => ndjson(events)) {
  return async (exe, args, options) => {
    calls.push({ exe, args, options })
    if (args.includes('--help')) return exe === 'codex.exe' ? help : claudeHelp
    if (args.includes('features')) return features
    if (args.includes('status')) return exe === 'codex.exe' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
    return inference(exe, options)
  }
}
const claudeResult = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', result: '{"answer":43}', modelUsage: { 'claude-test': {} }, usage: { output_tokens: 6 } })

test('Codex strict argument policy and safe explicit model', () => {
  const args = cliArguments('codex', { OWNER_AI_CODEX_MODEL: 'gpt-5.6-sol' })
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-sol')
  for (const flag of help.split(' ').filter(x => x !== '--config')) assert.ok(args.includes(flag), flag)
  for (const feature of disabled) assert.ok(args.some((x, i) => x === '--disable' && args[i + 1] === feature), feature)
  for (const config of ['forced_login_method=chatgpt', 'model_reasoning_effort="low"', 'web_search="disabled"', 'agents.enabled=false', 'mcp_servers={}', 'tools.update_plan.enabled=false']) assert.ok(args.includes(config), config)
  assert.ok(!args.includes('memory_tool'))
  assert.equal(cliArguments('codex', {})[cliArguments('codex', {}).indexOf('--model') + 1], 'gpt-6-astra')
  for (const model of ['', '--evil', 'x y', 'x\ny', 'x;evil', 'x'.repeat(121)]) assert.throws(() => cliArguments('codex', { OWNER_AI_CODEX_MODEL: model }))
})

test('native ChatGPT auth can arrive on stderr only with explicit metadata capture', async () => {
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    queueMicrotask(() => { child.stderr.write('Logged in using ChatGPT'); child.emit('close', 0) })
    return child
  }
  const run = (exe, args, options) => args.includes('status') ? runChild(exe, args, { ...options, spawnImpl }) : Promise.resolve(args.includes('--help') ? help : features)
  assert.equal(await probeProvider('codex', { env, run }), 'ready')
  assert.equal(await runChild('codex.exe', [], { spawnImpl }), '')
})

test('Codex recognizes ChatGPT status after known nonfatal launcher housekeeping warnings', async () => {
  const warnings = 'WARNING: failed to clean up stale arg0 temp dirs: Access is denied. (os error 5)\n' +
    'WARNING: proceeding, even though we could not create PATH aliases: Access is denied. (os error 5) at path "C:/Local/GrantFlow/subscriptions/codex/tmp/arg0/example"\n'
  const auth = warnings + 'Logged in using ChatGPT\n'
  assert.equal(subscriptionAuth('codex', auth), true)
  assert.equal(await probeProvider('codex', { env, run: async (exe, args) => args.includes('--help') ? help : args.includes('features') ? features : auth }), 'ready')
  for (const raw of [warnings, warnings + 'Logged in using an API key', warnings + 'Not logged in',
    'WARNING: unknown authentication failure\nLogged in using ChatGPT',
    'Logged in using an API key\nLogged in using ChatGPT',
    auth + 'Logged in using ChatGPT', auth + 'unexpected']) {
    assert.equal(subscriptionAuth('codex', raw), false, raw)
  }
})

test('Codex probe fails closed for each missing safety flag/feature and unknown native status', async () => {
  for (const flag of help.split(' ')) {
    assert.equal(await probeProvider('codex', { env, run: async (exe, args) => args.includes('--help') ? help.replace(flag, '') : features }), 'unavailable')
  }
  for (const feature of disabled) {
    const run = async (exe, args) => args.includes('--help') ? help : features.split('\n').filter(line => !line.startsWith(feature + '\t')).join('\n')
    assert.equal(await probeProvider('codex', { env, run }), 'unavailable')
  }
  for (const auth of [null, '', 'unexpected']) assert.equal(await probeProvider('codex', { env, run: async (exe, args) => args.includes('--help') ? help : args.includes('features') ? features : auth }), 'unavailable')
  assert.equal(await probeProvider('codex', { env, run: async (exe, args) => args.includes('--help') ? help : args.includes('features') ? features : 'Logged in using an API key' }), 'auth_required')
})

test('Codex accepts only bounded complete agent message NDJSON with terminal usage and honest model source', () => {
  const result = parseResult('codex', ndjson(events), 'gpt-6-astra')
  assert.equal(result?.raw, '{"answer":42}')
  assert.equal(result.model, 'gpt-6-astra'); assert.equal(result.model_source, 'explicit_cli_argument')
  assert.deepEqual(result.usage, events.at(-1).usage)
  const invalid = ['', '{', ndjson(events.slice(0, -1)), ndjson(events.slice(0, 2).concat(events.at(-1))), 'x'.repeat(524289), ndjson([...events, { type: 'error' }])]
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'browser']) invalid.push(ndjson([...events.slice(0, 2), { type: 'item.completed', item: { type, text: 'bad' } }, ...events.slice(2)]))
  for (const type of ['error', 'turn.failed', 'item.started', 'item.updated', 'unknown']) invalid.push(ndjson([...events.slice(0, 2), { type, item: { type: 'agent_message', text: 'partial' } }, ...events.slice(2)]))
  invalid.push(ndjson([...events.slice(0, -1), { type: 'turn.completed', usage: { output_tokens: 0 } }]))
  for (const raw of invalid) assert.equal(parseResult('codex', raw, 'gpt-6-astra'), null)
  assert.equal(parseResult('codex', ndjson(events)), null)
})

test('Codex success stops before Claude and no child receives API credentials', async () => {
  const calls = []
  const result = await executeJob(job, { env, run: fakeRun(calls) })
  assert.equal(result?.provider, 'subscription:codex')
  assert.ok(calls.every(c => c.exe === 'codex.exe'))
  for (const call of calls) {
    for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'OWNER_AI_BRIDGE_TOKEN']) assert.equal(call.options.env[key], undefined)
    assert.ok(!call.args.includes(job.prompt))
  }
})

test('Codex failure or slice timeout leaves Claude time inside original whole deadline', async () => {
  for (const hang of [false, true]) {
    const calls = []; const start = Date.now()
    const run = fakeRun(calls, async (exe, options) => {
      if (exe === 'claude.exe') { assert.equal(options.signal.aborted, false); return claudeResult }
      if (hang) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return null
    })
    const result = await executeJob({ ...job, timeoutMs: 200 }, { env, run })
    assert.equal(result?.provider, 'subscription:claude')
    assert.ok(Date.now() - start < 200)
    assert.deepEqual(calls.filter(c => c.options.input).map(c => c.exe), ['codex.exe', 'claude.exe'])
  }
})

test('auth probing shares slice budget, output cap and cancellation refuse results', async () => {
  const calls = []
  const base = fakeRun(calls, () => claudeResult)
  const run = async (exe, args, options) => {
    if (exe === 'codex.exe') { await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); return null }
    return base(exe, args, options)
  }
  assert.equal((await executeJob({ ...job, timeoutMs: 200 }, { env, run }))?.provider, 'subscription:claude')
  assert.equal((await executeJob({ ...job, maxTokens: 6 }, { env, run: fakeRun([], () => ndjson(events)) }))?.complete, true)
  assert.equal(await executeJob(job, { env, signal: AbortSignal.abort(), run: () => assert.fail('must not spawn') }), null)
})

test('normalize only configured owner email, never request authority', () => {
  const previous = process.env.AGENT_CONTROL_ADMIN_EMAIL
  try {
    process.env.AGENT_CONTROL_ADMIN_EMAIL = ' Owner@Example.Test '
    const req = { ctx: { identityResolved: true, isAdmin: true, userId: 'real-owner', email: 'owner@example.test' } }
    assert.equal(isCanonicalOwner(req), true)
    req.ctx.email = ' Owner@Example.Test '; assert.equal(isCanonicalOwner(req), false)
  } finally { if (previous === undefined) delete process.env.AGENT_CONTROL_ADMIN_EMAIL; else process.env.AGENT_CONTROL_ADMIN_EMAIL = previous }
})

test('fake subprocess execution through broker retains Codex provenance and terminal usage', async () => {
  const previous = process.env.AGENT_CONTROL_ADMIN_EMAIL
  process.env.AGENT_CONTROL_ADMIN_EMAIL = 'owner@example.test'
  const calls = []
  const spawnImpl = (exe, args, options) => {
    calls.push({ exe, args, options })
    assert.equal(options.shell, false)
    const child = new EventEmitter()
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    queueMicrotask(() => {
      if (args.includes('status')) child.stderr.write('Logged in using ChatGPT')
      else child.stdout.write(args.includes('--help') ? help : args.includes('features') ? features : ndjson(events))
      child.emit('close', 0)
    })
    return child
  }
  try {
    const broker = createOwnerAiBroker({ env: { OWNER_AI_BRIDGE_ENABLED: 'true', OWNER_AI_BRIDGE_TOKEN: 'x'.repeat(48) } })
    const heartbeat = { providers: { codex: 'ready', claude: 'ready' } }
    broker.poll(heartbeat)
    const req = { ctx: { identityResolved: true, isAdmin: true, userId: 'owner', email: 'owner@example.test' }, res: new EventEmitter() }
    await runWithOwnerAiScope(req, async () => {
      const pending = broker.trySubscription(job)
      const { job: claimed } = broker.poll(heartbeat)
      assert.deepEqual(claimed.providers, ['codex', 'claude'])
      const result = await executeJob(claimed, { env, run: (exe, args, options) => runChild(exe, args, { ...options, spawnImpl }) })
      broker.result({ id: claimed.id, lease: claimed.lease, result })
      const answer = await pending
      assert.equal(answer.model_source, 'explicit_cli_argument')
      assert.deepEqual(answer.usage, events.at(-1).usage)
      assert.deepEqual(answer.json, { answer: 42 })
    })
    req.res.emit('finish')
    assert.ok(calls.every(call => call.exe === 'codex.exe'))
  } finally { if (previous === undefined) delete process.env.AGENT_CONTROL_ADMIN_EMAIL; else process.env.AGENT_CONTROL_ADMIN_EMAIL = previous }
})

test('failed subscriptions return null; server provider order and whole-deadline abort remain authoritative', async () => {
  const calls = []
  assert.equal(await executeJob(job, { env, run: fakeRun(calls, () => null) }), null)
  assert.deepEqual(calls.filter(c => c.options.input).map(c => c.exe), ['codex.exe', 'claude.exe'])
  calls.length = 0
  assert.equal((await executeJob({ ...job, providers: ['claude', 'codex'] }, { env, run: fakeRun(calls, () => claudeResult) }))?.provider, 'subscription:claude')
  assert.ok(calls.every(c => c.exe === 'claude.exe'))
  const controller = new AbortController()
  const run = fakeRun([], async () => { controller.abort(); return ndjson(events) })
  assert.equal(await executeJob(job, { env, signal: controller.signal, run }), null)
})

 test('a second ready subscription does not halve the viable primary slice', async () => {
  const calls = []
  const base = fakeRun(calls)
  const run = async (exe, args, options) => {
    if (exe === 'codex.exe' && args[0] === 'exec' && !args.includes('--help')) {
      await new Promise(resolve => { const timer = setTimeout(resolve, 260); options.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
      return options.signal.aborted ? null : ndjson(events)
    }
    return base(exe, args, options)
  }
  const result = await executeJob({ ...job, timeoutMs: 400 }, { env, run })
  assert.equal(result?.provider, 'subscription:codex')
})

test('Codex completed reasoning summaries are accepted but excluded from output', async () => {
  const withReasoning = [...events.slice(0, 2), { type: 'item.completed', item: { type: 'reasoning', text: 'Non-output summary' } }, ...events.slice(2)]
  const result = parseResult('codex', ndjson(withReasoning), 'gpt-6-astra')
  assert.equal(result?.raw, '{"answer":42}')
  assert.equal(parseResult('codex', ndjson(withReasoning.filter(event => event.item?.type !== 'agent_message')), 'gpt-6-astra'), null)
  for (const item of [{ type: 'reasoning', text: 42 }, { type: 'reasoning', text: 'failed', status: 'failed' }, { type: 'reasoning', text: 'failed', error: 'failure' }]) {
    assert.equal(parseResult('codex', ndjson([...events.slice(0, 2), { type: 'item.completed', item }, ...events.slice(2)]), 'gpt-6-astra'), null)
  }
  const calls = []
  const answer = await executeJob(job, { env, run: fakeRun(calls, () => ndjson(withReasoning)) })
  assert.equal(answer?.provider, 'subscription:codex')
  assert.equal(answer?.raw, '{"answer":42}')
  assert.ok(calls.every(call => call.exe === 'codex.exe'))
})
