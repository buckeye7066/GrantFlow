import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ configs: [], outcomes: [], warn: vi.fn() }))

// Exercise the default client-construction path, not clientFactory injection:
// injected clients hid the fact that scoped api_key_env names were ignored.
vi.mock('openai', () => ({
  default: class OpenAI {
    constructor(config) {
      state.configs.push(config)
      this.chat = { completions: { create: async () => {
        const outcome = state.outcomes.shift()
        if (outcome instanceof Error) throw outcome
        return { choices: [{ message: { content: outcome ?? '{"ok":true}' } }] }
      } } }
    }
  },
}))

vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({ warn: state.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { getConfiguredFreeAiRoutes, invokeFreeJsonRoutes, resolveFreeAiRoutes, resetFreeAiCircuitStateForTests } from '../utils/freeAiRoutes.js'

function routesFor(key = 'FREE_AI_ROUTE_CUSTOM_API_KEY') {
  return resolveFreeAiRoutes([{
    id: 'primary',
    base_url: 'https://free.example.test/v1',
    model: 'fixture-model',
    api_key_env: key,
  }])
}

beforeEach(() => {
  resetFreeAiCircuitStateForTests()
  state.configs.length = 0
  state.outcomes.length = 0
  state.warn.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('free route credentials through the default SDK client', () => {
  it('reads the custom environment variable named by api_key_env', async () => {
    vi.stubEnv('FREE_AI_ROUTE_CUSTOM_API_KEY', 'fixture-custom-credential')
    const result = await invokeFreeJsonRoutes({ routes: routesFor(), prompt: 'fixture' })
    expect(result.ok).toBe(true)
    expect(state.configs[0].apiKey).toBe('fixture-custom-credential')
  })

  it('reads the current process credential at each client construction', async () => {
    vi.stubEnv('FREE_AI_ROUTE_CUSTOM_API_KEY', 'fixture-first')
    const routes = routesFor()
    await invokeFreeJsonRoutes({ routes, prompt: 'fixture' })
    vi.stubEnv('FREE_AI_ROUTE_CUSTOM_API_KEY', 'fixture-rotated')
    await invokeFreeJsonRoutes({ routes, prompt: 'fixture' })
    expect(state.configs.map(config => config.apiKey)).toEqual(['fixture-first', 'fixture-rotated'])
  })

  it('preserves generic credentials, timeout settings and retry settings', async () => {
    vi.stubEnv('FREE_AI_API_KEY', 'fixture-generic')
    vi.stubEnv('FREE_AI_TIMEOUT_MS', '4500')
    vi.stubEnv('FREE_AI_MAX_RETRIES', '1')
    await invokeFreeJsonRoutes({ routes: routesFor('FREE_AI_API_KEY'), prompt: 'fixture' })
    expect(state.configs[0]).toMatchObject({ apiKey: 'fixture-generic', timeout: 4500, maxRetries: 1 })
  })

  it('preserves unauthenticated self-hosted routes', async () => {
    const result = await invokeFreeJsonRoutes({ routes: routesFor(''), prompt: 'fixture' })
    expect(result.ok).toBe(true)
    expect(state.configs[0].apiKey).toBe('grantflow-local-no-key')
  })

  it('never exposes credential values in route metadata or returned results', async () => {
    vi.stubEnv('FREE_AI_ROUTE_CUSTOM_API_KEY', 'fixture-never-public')
    const routes = routesFor()
    const result = await invokeFreeJsonRoutes({ routes, prompt: 'fixture' })
    expect(JSON.stringify([routes, result, state.warn.mock.calls])).not.toContain('fixture-never-public')
  })
})

describe('safe free-route failure diagnostics', () => {
  it('logs an authentication failure status without the provider payload', async () => {
    state.outcomes.push(Object.assign(
      new Error('rejected bearer fixture-private-key at https://private.example.test'),
      { status: 401 },
    ))
    const result = await invokeFreeJsonRoutes({ routes: routesFor(), prompt: 'fixture' })
    expect(result.ok).toBe(false)
    expect(state.warn).toHaveBeenCalledWith(
      'Free AI route primary failed; trying the next configured route',
      { status: 401, message: 'free route rejected the request', credit_exhausted: false },
    )
    const diagnostics = JSON.stringify([result, state.warn.mock.calls])
    expect(diagnostics).not.toContain('fixture-private-key')
    expect(diagnostics).not.toContain('private.example.test')
  })

  it('logs quota status without exposing account information', async () => {
    state.outcomes.push(Object.assign(
      new Error('quota exceeded for fixture-account-private'),
      { status: 429 },
    ))
    const result = await invokeFreeJsonRoutes({ routes: routesFor(), prompt: 'fixture' })
    expect(result.ok).toBe(false)
    expect(state.warn).toHaveBeenCalledWith(
      'Free AI route primary failed; trying the next configured route',
      { status: 429, message: 'free route quota or rate limit reached', credit_exhausted: true },
    )
    expect(JSON.stringify([result, state.warn.mock.calls])).not.toContain('fixture-account-private')
  })

  it('preserves fallback order and the existing sanitized error response contract', async () => {
    state.outcomes.push(Object.assign(new Error('unauthorized'), { status: 401 }), '{"source":"second"}')
    const routes = [...routesFor(), {
      id: 'second', baseURL: 'https://second.example.test/v1', model: 'two', apiKeyEnv: null,
    }]
    const result = await invokeFreeJsonRoutes({ routes, prompt: 'fixture' })
    expect(result).toMatchObject({ ok: true, provider: 'free:second', json: { source: 'second' } })
    expect(result.freeRouteErrors).toEqual([
      { status: 401, message: 'free route rejected the request', credit_exhausted: false },
    ])
    expect(JSON.stringify(result.freeRouteErrors)).not.toContain('primary')
  })
})


describe('free route credential isolation', () => {
  it.each(['DATABASE_URL', 'AUTH_JWT_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ADMIN_TOKEN', 'FREE_AI_ROUTES'])(
    'rejects unrelated process variable %s before SDK construction', async key => {
      vi.stubEnv(key, 'fixture-unrelated-secret')
      const result = await invokeFreeJsonRoutes({ routes: [{ ...routesFor()[0], apiKeyEnv: key }], prompt: 'fixture' })
      expect(result.ok).toBe(false)
      expect(state.configs).toHaveLength(0)
      expect(result.freeRouteErrors).toEqual([
        { status: 403, message: 'free route rejected the request', credit_exhausted: false },
      ])
      expect(JSON.stringify([result, state.warn.mock.calls])).not.toContain('fixture-unrelated-secret')
    },
  )

  it('guards directly supplied routes even without normalization', async () => {
    vi.stubEnv('AUTH_JWT_SECRET', 'fixture-direct-secret')
    const result = await invokeFreeJsonRoutes({
      routes: [{ id: 'direct', baseURL: 'https://free.example.test/v1', model: 'fixture', apiKeyEnv: 'AUTH_JWT_SECRET' }],
      prompt: 'fixture',
    })
    expect(result.ok).toBe(false)
    expect(state.configs).toHaveLength(0)
    expect(JSON.stringify([result, state.warn.mock.calls])).not.toContain('fixture-direct-secret')
  })

  it('continues to an authorized route after rejecting an unrelated credential', async () => {
    vi.stubEnv('DATABASE_URL', 'fixture-database-secret')
    vi.stubEnv('FREE_AI_API_KEY', 'fixture-free-key')
    const result = await invokeFreeJsonRoutes({
      routes: [{ ...routesFor()[0], apiKeyEnv: 'DATABASE_URL' }, ...routesFor('FREE_AI_API_KEY')], prompt: 'fixture',
    })
    expect(result.ok).toBe(true)
    expect(state.configs).toHaveLength(1)
    expect(state.configs[0].apiKey).toBe('fixture-free-key')
    expect(JSON.stringify([state.configs, result, state.warn.mock.calls])).not.toContain('fixture-database-secret')
  })

  it('preserves the existing Ollama credential', async () => {
    vi.stubEnv('OLLAMA_API_KEY', 'fixture-ollama-key')
    const result = await invokeFreeJsonRoutes({ routes: routesFor('OLLAMA_API_KEY'), prompt: 'fixture' })
    expect(result.ok).toBe(true)
    expect(state.configs[0].apiKey).toBe('fixture-ollama-key')
  })
})


describe('configured free-route health inventory', () => {
  it.each(['DATABASE_URL', 'FREE_TIER_PROVIDER_KEY', 'not_a_valid_key'])(
    'does not count unsupported credential reference %s as usable', key => {
      const config = [{ id: 'invalid', base_url: 'https://free.example.test/v1', model: 'one', api_key_env: key }]
      expect(resolveFreeAiRoutes(config)).toEqual([])
      expect(getConfiguredFreeAiRoutes({ FREE_AI_ROUTES: JSON.stringify(config) })).toEqual([])
    },
  )

  it('preserves valid route order while excluding forbidden credential references', () => {
    const config = [
      { id: 'first', base_url: 'https://one.example.test/v1', model: 'one', api_key_env: 'FREE_AI_ROUTE_ONE_API_KEY' },
      { id: 'invalid', base_url: 'https://invalid.example.test/v1', model: 'invalid', api_key_env: 'AUTH_JWT_SECRET' },
      { id: 'last', base_url: 'https://last.example.test/v1', model: 'last', api_key_env: 'FREE_AI_API_KEY' },
    ]
    expect(getConfiguredFreeAiRoutes({ FREE_AI_ROUTES: JSON.stringify(config) }).map(route => route.id)).toEqual(['first', 'last'])
  })

  it('keeps explicitly unauthenticated local routes in the configured inventory', () => {
    const routes = getConfiguredFreeAiRoutes({ FREE_AI_ROUTES: JSON.stringify([
      { id: 'local', base_url: 'http://ollama.internal:11434/v1', model: 'local', api_key_env: '' },
    ]) })
    expect(routes).toHaveLength(1)
    expect(routes[0].apiKeyEnv).toBeNull()
  })
})
