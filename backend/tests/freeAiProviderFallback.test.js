import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getConfiguredFreeAiRoutes,
  isProviderCreditExhaustion,
} from '../utils/freeAiRoutes.js'
import {
  invokeJsonWithFallback,
  invokeTextWithFallback,
} from '../utils/aiProviders.js'

const priorAnthropicKey = process.env.ANTHROPIC_API_KEY

afterEach(() => {
  if (priorAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = priorAnthropicKey
})

function clientReturning(content) {
  return {
    chat: {
      completions: {
        create: vi.fn(async () => ({
          choices: [{ message: { content } }],
          usage: { total_tokens: 12 },
        })),
      },
    },
  }
}

describe('free AI provider routing', () => {
  it('loads ordered generic and Ollama routes without exposing secret values', () => {
    const routes = getConfiguredFreeAiRoutes({
      FREE_AI_ROUTES: JSON.stringify([
        {
          id: 'community-endpoint',
          base_url: 'https://free.example.test/v1/',
          model: 'community-model',
          api_key_env: 'COMMUNITY_TOKEN',
        },
        {
          id: 'unsafe',
          base_url: 'https://user:password@free.example.test/v1',
          model: 'must-not-load',
        },
      ]),
      FREE_AI_BASE_URL: 'https://compatible.example.test/v1',
      FREE_AI_MODEL: 'free-model',
      FREE_AI_API_KEY: 'must-never-appear',
      OLLAMA_BASE_URL: 'http://ollama.internal:11434/v1',
      OLLAMA_MODEL: 'local-model',
    })

    expect(routes).toEqual([
      {
        id: 'community-endpoint',
        baseURL: 'https://free.example.test/v1',
        model: 'community-model',
        apiKeyEnv: 'COMMUNITY_TOKEN',
      },
      {
        id: 'free-compatible',
        baseURL: 'https://compatible.example.test/v1',
        model: 'free-model',
        apiKeyEnv: 'FREE_AI_API_KEY',
      },
      {
        id: 'ollama',
        baseURL: 'http://ollama.internal:11434/v1',
        model: 'local-model',
        apiKeyEnv: 'OLLAMA_API_KEY',
      },
    ])
    expect(JSON.stringify(routes)).not.toContain('must-never-appear')
    expect(JSON.stringify(routes)).not.toContain('password')
  })

  it('detects paid-provider credit and quota exhaustion', () => {
    expect(isProviderCreditExhaustion({ status: 429, message: 'rate limited' })).toBe(true)
    expect(isProviderCreditExhaustion(new Error('insufficient_quota: credit balance exhausted'))).toBe(true)
    expect(isProviderCreditExhaustion({ status: 500, message: 'temporary upstream error' })).toBe(false)
  })

  it('falls through a paid 429 to a configured free text route with provenance', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const openai = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            const error = new Error('insufficient_quota')
            error.status = 429
            throw error
          }),
        },
      },
    }
    const freeClient = clientReturning('Profile-specific fallback answer')
    const freeClientFactory = vi.fn(async () => freeClient)

    const result = await invokeTextWithFallback({
      openai,
      prompt: 'Help this profile',
      freeRoutes: [{
        id: 'local',
        base_url: 'http://ollama.internal:11434/v1',
        model: 'local-model',
      }],
      freeClientFactory,
    })

    expect(result).toMatchObject({
      ok: true,
      provider: 'free:local',
      route_id: 'local',
      model: 'local-model',
      text: 'Profile-specific fallback answer',
      degraded: true,
      fallback_reason: 'paid_provider_credit_or_quota_exhausted',
    })
    expect(freeClientFactory).toHaveBeenCalledTimes(1)
    expect(freeClient.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'local-model' }),
    )
  })

  it('continues across free routes and parses JSON from the next healthy route', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const bad = {
      chat: {
        completions: {
          create: vi.fn(async () => { throw new Error('local model unavailable') }),
        },
      },
    }
    const good = clientReturning('{"summary":"usable free route","score":7}')
    const factory = vi.fn(async (route) => route.id === 'first' ? bad : good)

    const result = await invokeJsonWithFallback({
      prompt: 'Return structured data',
      freeRoutes: [
        { id: 'first', base_url: 'http://first.internal:11434/v1', model: 'one' },
        { id: 'second', base_url: 'http://second.internal:11434/v1', model: 'two' },
      ],
      freeClientFactory: factory,
    })

    expect(result).toMatchObject({
      ok: true,
      provider: 'free:second',
      route_id: 'second',
      json: { summary: 'usable free route', score: 7 },
      fallback_reason: 'paid_provider_not_configured',
    })
    expect(result.freeRouteErrors).toEqual([
      expect.objectContaining({ route_id: 'first', message: 'local model unavailable' }),
    ])
  })

  it('fails honestly when every paid and free route fails', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const result = await invokeTextWithFallback({
      prompt: 'Do not fabricate',
      freeRoutes: [
        { id: 'offline', base_url: 'http://offline.internal:11434/v1', model: 'none' },
      ],
      freeClientFactory: async () => ({
        chat: { completions: { create: async () => { throw new Error('connection refused') } } },
      }),
    })

    expect(result.ok).toBe(false)
    expect(result.provider).toBe('fallback')
    expect(result.text).toBeNull()
    expect(result.freeRouteErrors).toEqual([
      expect.objectContaining({ route_id: 'offline', message: 'connection refused' }),
    ])
  })

  it('does not call a free route when the paid provider succeeds', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const openai = clientReturning('paid response')
    const freeClientFactory = vi.fn(async () => clientReturning('should not run'))
    const result = await invokeTextWithFallback({
      openai,
      prompt: 'normal path',
      freeRoutes: [
        { id: 'reserve', base_url: 'http://reserve.internal:11434/v1', model: 'reserve' },
      ],
      freeClientFactory,
    })
    expect(result).toMatchObject({ ok: true, provider: 'openai', text: 'paid response' })
    expect(freeClientFactory).not.toHaveBeenCalled()
  })
})
