import {spawn} from 'node:child_process'
import {mkdir} from 'node:fs/promises'
import {setTimeout as sleep} from 'node:timers/promises'

export const LOCAL_MODEL = 'llama3.2:1b'
export const LOCAL_MODEL_DIGEST = 'baf6a787fdffd633537aa2eb51cfd54cb93ff08e28040095462bb63daf552878'

/** The bundled inference process receives no application or provider secrets. */
export function localModelEnvironment(env = process.env) {
  return {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: '/tmp/grantflow-local-model',
    OLLAMA_MODELS: '/opt/grantflow-models',
    OLLAMA_HOST: '127.0.0.1:11434',
    OLLAMA_NO_CLOUD: '1',
    OLLAMA_NUM_PARALLEL: '2',
    OLLAMA_MAX_LOADED_MODELS: '1',
    OLLAMA_MAX_QUEUE: '8',
    OLLAMA_CONTEXT_LENGTH: '8192',
    OLLAMA_KEEP_ALIVE: '30m',
    OLLAMA_VULKAN: '0',
    CUDA_VISIBLE_DEVICES: '-1',
    GOMAXPROCS: '8',
  }
}

/** A private, non-root, startup-verified engine. Unexpected exit requests normal
 * application shutdown, allowing the existing container restart policy to heal.
 * Models are baked into the image; runtime never downloads arbitrary models.
 */
export function startLocalModel({
  env = process.env, enabled = env.GRANTFLOW_LOCAL_MODEL_ENABLED, platform = process.platform, spawnImpl = spawn,
  fetchImpl = globalThis.fetch, makeDir = mkdir, delay = sleep, now = Date.now,
  startupMs = 30000, onUnexpectedExit = () => {},
} = {}) {
  let state = 'disabled'
  let child = null
  let stopped = false
  let exited = false
  let exitReported = false
  const shutdown = new AbortController()
  const stop = () => {
    if (stopped) return
    stopped = true
    shutdown.abort()
    if (child && !exited) child.kill('SIGTERM')
    if (state !== 'failed' && state !== 'disabled') state = 'stopped'
  }
  const status = () => ({state, model: LOCAL_MODEL, billing_mode: 'free_or_local'})
  const ready = (async () => {
    if (enabled !== '1') return
    state = 'starting'
    if (platform !== 'linux') {
      state = 'failed'
      throw new Error('local_model_platform_unsupported')
    }
    const childEnv = localModelEnvironment(env)
    try {
      await makeDir(childEnv.HOME, {recursive: true, mode: 0o700})
      if (stopped) throw new Error('local_model_stopped')
      child = spawnImpl('/usr/bin/ollama', ['serve'], {
        env: childEnv, shell: false, stdio: ['ignore', 'ignore', 'ignore'],
      })
      const failed = () => {
        exited = true
        if (!stopped) {
          const wasReady = state === 'ready'
          state = 'failed'
          if (wasReady && !exitReported) {
            exitReported = true
            onUnexpectedExit()
          }
        }
      }
      child.once('error', failed)
      child.once('exit', failed)
      const deadline = now() + Math.max(1000, Math.min(60000, startupMs))
      while (!stopped && !exited && now() < deadline) {
        try {
          const response = await fetchImpl('http://127.0.0.1:11434/api/tags', {
            redirect: 'error', signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(1500)]),
          })
          if (response.ok) {
            const body = await response.json()
            if (body.models?.some(model => model.name === LOCAL_MODEL && model.digest === LOCAL_MODEL_DIGEST)) {
              if (stopped || exited) break
              state = 'ready'
              return
            }
          } else await response.body?.cancel()
        } catch { /* Bounded startup polling: neither prompts nor provider errors are logged. */ }
        if (!stopped && !exited) await delay(250, undefined, {signal: shutdown.signal})
      }
      throw new Error('local_model_not_ready')
    } catch (error) {
      state = 'failed'
      stop()
      throw error
    }
  })()
  return {ready, stop, status}
}
