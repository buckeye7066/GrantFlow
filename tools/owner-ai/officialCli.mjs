import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function childEnvironment(provider, env = process.env) {
  const clean = {}
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'LOCALAPPDATA', 'USERPROFILE', 'HOME']) if (env[key]) clean[key] = env[key]
  if (!env.LOCALAPPDATA) throw new Error('unavailable')
  clean[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = path.join(env.LOCALAPPDATA, 'GrantFlow', 'subscriptions', provider)
  clean.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  clean.CLAUDE_CODE_SAFE_MODE = '1'
  return clean
}
export function subscriptionAuth(provider, raw) {
  if (provider === 'codex') return /^Logged in using ChatGPT\s*$/i.test(raw.trim())
  if (provider !== 'claude') return false
  try {
    const s = JSON.parse(raw)
    return s.loggedIn === true && s.authMethod === 'claude.ai' && ['pro', 'max'].includes(s.subscriptionType?.toLowerCase()) && !s.apiKeySource
  } catch { return false }
}
export function cliArguments(provider) {
  // Read-only sandboxing still permits reads and execution. No proven all-tools-off Codex contract.
  if (provider !== 'claude') throw new Error('unavailable')
  return ['--print', '--output-format', 'json', '--safe', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--no-chrome', '--permission-mode', 'dontAsk', '--permission-prompts', 'none']
}
export function parseResult(provider, raw) {
  if (provider !== 'claude') return null
  try {
    const r = JSON.parse(raw)
    const models = Object.keys(r.modelUsage || {})
    if (r.type !== 'result' || r.subtype !== 'success' || r.is_error !== false || r.stop_reason !== 'end_turn' ||
        typeof r.result !== 'string' || !r.result.trim() || models.length !== 1 || !Number.isFinite(r.usage?.output_tokens) || r.usage.output_tokens <= 0) return null
    return { ok: true, complete: true, provider: 'subscription:claude', billing_mode: 'subscription', model: models[0], raw: r.result, usage: { output_tokens: r.usage.output_tokens } }
  } catch { return null }
}
export function runChild(executable, args, { cwd, env, input = '', signal, spawnImpl = spawn, platform = process.platform } = {}) {
  if (signal?.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    let child
    let output = ''
    let bytes = 0
    let failed = false
    const kill = () => {
      failed = true
      if (platform === 'win32' && Number.isInteger(child?.pid)) {
        const killer = spawnImpl(path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
      } else child?.kill('SIGKILL')
    }
    try {
      child = spawnImpl(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      signal?.addEventListener('abort', kill, { once: true })
      child.on('error', () => { failed = true; signal?.removeEventListener('abort', kill); resolve(null) })
      child.on('close', code => { signal?.removeEventListener('abort', kill); resolve(!failed && code === 0 ? output : null) })
      const collect = (chunk, stdout) => { bytes += chunk.length; if (bytes > 524288) kill(); else if (stdout) output += chunk.toString() }
      child.stdout.on('data', chunk => collect(chunk, true))
      child.stderr.on('data', chunk => collect(chunk, false))
      child.stdin.on('error', () => { failed = true })
      child.stdin.end(input)
      if (signal?.aborted) kill()
    } catch { resolve(null) }
  })
}
export async function probeProvider(provider, { signal, env = process.env, run = runChild } = {}) {
  if (provider !== 'claude') return 'unavailable'
  try {
    const clean = childEnvironment(provider, env)
    const help = await run('claude.exe', [...cliArguments(provider), '--help'], { env: clean, signal })
    if (!help || !['--safe-mode', '--tools', '--strict-mcp-config', '--setting-sources', '--permission-prompts'].every(flag => help.includes(flag))) return 'unavailable'
    const auth = await run('claude.exe', ['auth', 'status', '--json'], { env: clean, signal })
    return auth && subscriptionAuth(provider, auth) ? 'ready' : 'auth_required'
  } catch { return 'unavailable' }
}
export async function executeJob(job, { signal, env = process.env, run = runChild } = {}) {
  let cwd
  try {
    if (signal?.aborted || !job.providers?.includes('claude') || await probeProvider('claude', { signal, env, run }) !== 'ready') return null
    cwd = await mkdtemp(path.join(tmpdir(), 'grantflow-owner-ai-'))
    const clean = childEnvironment('claude', env)
    clean.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.min(job.maxTokens, 32000))
    const raw = await run('claude.exe', cliArguments('claude'), { cwd, env: clean, signal,
      input: JSON.stringify({ system: job.system, prompt: job.prompt, format: job.format }) })
    return raw ? parseResult('claude', raw) : null
  } catch { return null }
  finally { if (cwd) await rm(cwd, { recursive: true, force: true }) }
}
