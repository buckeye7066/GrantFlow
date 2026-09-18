import { afterEach, expect, it, vi } from 'vitest'
import { invokeFreeJsonRoutes } from '../utils/freeAiRoutes.js'
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })
const route = (id, model = id) => ({ id, model, baseURL: 'https://free-circuit.example.invalid/v1', apiKeyEnv: null })
const completion = { choices: [{ finish_reason: 'stop', message: { content: '{"usable":true}' } }] }
it('honors a model quota cooldown without blocking another model on that account', async () => {
  vi.useFakeTimers()
  const unavailable = vi.fn(async () => { throw Object.assign(new Error('rate limited'), { status: 429, headers: new Headers({'retry-after':'120'}) }) })
  const healthy = vi.fn(async () => completion)
  const options = { circuitState:new Map(), routes:[route('limited'),route('available')],prompt:'JSON',maxTokens:64,timeoutMs:5000,
    clientFactory:r=>({chat:{completions:{create:r.id==='limited'?unavailable:healthy}}}) }
  expect(await invokeFreeJsonRoutes(options)).toMatchObject({ok:true,provider:'free:available'})
  expect(await invokeFreeJsonRoutes(options)).toMatchObject({ok:true,provider:'free:available'})
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(healthy).toHaveBeenCalledTimes(2)
  vi.advanceTimersByTime(120001)
  await invokeFreeJsonRoutes(options)
  expect(unavailable).toHaveBeenCalledTimes(2)
})
it('rotation of a dedicated free credential invalidates its old cooldown', async () => {
  vi.stubEnv('FREE_AI_ROUTE_CIRCUIT_API_KEY','first-fixture-value')
  const create = vi.fn().mockRejectedValueOnce(Object.assign(new Error('rate limited'),{status:429,headers:{'retry-after':'120'}})).mockResolvedValue(completion)
  const options = { circuitState:new Map(),routes:[{...route('rotation'),apiKeyEnv:'FREE_AI_ROUTE_CIRCUIT_API_KEY'}],prompt:'JSON',maxTokens:64,timeoutMs:5000,clientFactory:()=>({chat:{completions:{create}}})}
  expect(await invokeFreeJsonRoutes(options)).toMatchObject({ok:false})
  vi.stubEnv('FREE_AI_ROUTE_CIRCUIT_API_KEY','second-fixture-value')
  expect(await invokeFreeJsonRoutes(options)).toMatchObject({ok:true})
  expect(create).toHaveBeenCalledTimes(2)
})


it.each([400, undefined])('applies cooldown to classified exhausted credit with status %s', async status => {
  const create=vi.fn(async()=>{throw Object.assign(new Error('credit balance is too low'),{status})})
  const options={circuitState:new Map(),routes:[route('exhausted-'+String(status))],prompt:'JSON',maxTokens:64,timeoutMs:5000,clientFactory:()=>({chat:{completions:{create}}})}
  expect(await invokeFreeJsonRoutes(options)).toMatchObject({ok:false})
  expect(await invokeFreeJsonRoutes(options)).toMatchObject({ok:false})
  expect(create).toHaveBeenCalledTimes(1)
})
