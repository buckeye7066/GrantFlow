import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { executeJob, probeProvider } from './officialCli.mjs'

export function bridgeConfig(env = process.env) {
  const url = new URL(env.GRANTFLOW_OWNER_AI_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('invalid_configuration')
  if (!env.OWNER_AI_BRIDGE_TOKEN || env.OWNER_AI_BRIDGE_TOKEN.length < 32) throw new Error('invalid_configuration')
  return { url, token: env.OWNER_AI_BRIDGE_TOKEN }
}
export async function runBridge({ env = process.env, signal } = {}) {
  const { url, token } = bridgeConfig(env)
  async function post(route, body, requestSignal = signal) {
    const response = await fetch(new URL('/api/owner-ai/worker/' + route, url), {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(requestSignal ? [requestSignal] : [])]),
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('unavailable') }
    let size = 0
    const chunks = []
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 196608) throw new Error('unavailable')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString())
  }
  while (!signal?.aborted) {
    try {
      const probeSignal = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])])
      const states = await Promise.all(['codex', 'claude'].map(provider => probeProvider(provider, { env, signal: probeSignal })))
      const providers = { codex: states[0], claude: states[1] }
      const { job } = await post('poll', { providers })
      if (job) {
        if (!Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0 || job.timeoutMs > 120000 ||
            typeof job.prompt !== 'string' || typeof job.system !== 'string' ||
            !Number.isInteger(job.maxTokens) || job.maxTokens <= 0) throw new Error('invalid_job')
        const controller = new AbortController()
        const jobSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(job.timeoutMs), ...(signal ? [signal] : [])])
        const monitor = (async () => {
          try {
            while (!jobSignal.aborted) {
              await delay(1000, undefined, { signal: jobSignal })
              const reply = await post('poll', { providers, active: { id: job.id, lease: job.lease } }, jobSignal)
              if (!reply.active) controller.abort()
            }
          } catch { controller.abort() }
        })()
        const result = await executeJob(job, { env, signal: jobSignal })
        const cancelled = jobSignal.aborted
        controller.abort()
        await monitor
        if (!cancelled) await post('result', { id: job.id, lease: job.lease, result })
      }
    } catch {
      // Never log prompts, results, native status output, or credentials.
    }
    await delay(1500, undefined, { signal }).catch(() => {})
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController()
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => controller.abort())
  runBridge({ signal: controller.signal }).catch(() => { process.exitCode = 1 })
}
