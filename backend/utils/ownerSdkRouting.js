import { randomUUID } from 'node:crypto'
import { getOwnerAiScope } from '../services/ownerAi/ownerAiScope.js'

const nativeClients = new WeakMap()
export function unwrapOwnerSdkClient(client) { return nativeClients.get(client) || client }
function unavailable() {
  const error = new Error('This owner operation requires a supported subscription or free-model transport; no metered call was made')
  error.code = 'OWNER_SUBSCRIPTION_OPERATION_UNSUPPORTED'
  error.status = 503
  return error
}
function plainText(content) {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (!Array.isArray(content) || content.some(part => !['text', 'input_text', 'output_text'].includes(part?.type) || typeof part.text !== 'string')) throw unavailable()
  return content.map(part => part.text).join('\n')
}
async function invokeOwnerRequest(provider, operation, request = {}, options = {}) {
  getOwnerAiScope({includeAborted:true})?.signal.throwIfAborted()
  if (request.stream || !['chat.completions.create', 'responses.create', 'messages.create'].includes(operation)) throw unavailable()
  const source = operation === 'responses.create' ? request.input : request.messages
  const messages = typeof source === 'string' ? [{role:'user',content:source}] : source
  if (!Array.isArray(messages) || !messages.length) throw unavailable()
  const normalized = messages.map(message => ({...message,content:plainText(message.content)}))
  const system = [plainText(request.system ?? request.instructions), ...normalized.filter(m => ['system','developer'].includes(m.role)).map(m => m.content)].filter(Boolean).join('\n\n')
  const tools = Array.isArray(request.tools) ? request.tools : []
  let result
  let toolCalls = []
  if (tools.length) {
    // Hosted search and other provider-native tools cannot be simulated here.
    const functions = tools.map(tool => {
      if (tool.type === 'function' && tool.function) return tool
      if (provider === 'anthropic' && !tool.type && tool.name && tool.input_schema) return {type:'function',function:{name:tool.name,description:tool.description,parameters:tool.input_schema}}
      throw unavailable()
    })
    const {invokeAnyaToolTurn} = await import('../services/anyaToolTransport.js')
    const planned = await invokeAnyaToolTurn({messages:[{role:'system',content:system},...normalized.filter(m=>!['system','developer'].includes(m.role))],tools:functions,maxTokens:request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens ?? 1800,timeoutMs:options.timeout ?? 30000,signal:options.signal})
    toolCalls = planned.choices[0].message.tool_calls
    result = {ok:true,raw:planned.choices[0].message.content,model:planned.model,provider:planned.provider,billing_mode:planned.billing_mode,usage:planned.usage}
  } else {
    const gateway = await import('./aiProviders.js')
    const format = request.response_format?.type ?? request.text?.format?.type
    if (format && !['text','json_object'].includes(format)) throw unavailable()
    const json = format === 'json_object'
    result = await (json ? gateway.invokeJsonWithFallback : gateway.invokeTextWithFallback)({
      system, prompt:JSON.stringify(normalized.filter(m=>!['system','developer'].includes(m.role))),
      maxTokens:request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens ?? 1200,
      temperature:request.temperature,timeoutMs:options.timeout ?? 30000,signal:options.signal,
    })
    if (result?.ok) result = {...result,raw:json ? JSON.stringify(result.json) : result.text}
  }
  if (!result?.ok || typeof result.raw !== 'string') throw unavailable()
  const metadata = {id:'owner_'+randomUUID(),model:result.model,provider:result.provider,billing_mode:result.billing_mode,usage:result.usage ?? null}
  if (provider === 'anthropic') return {...metadata,type:'message',role:'assistant',stop_reason:toolCalls.length?'tool_use':'end_turn',content:[...(result.raw?[{type:'text',text:result.raw}]:[]),...toolCalls.map(call=>({type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)}))]}
  if (operation === 'responses.create') return {...metadata,status:'completed',output:[...(result.raw?[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:result.raw}]}]:[]),...toolCalls.map(call=>({type:'function_call',call_id:call.id,name:call.function.name,arguments:call.function.arguments,status:'completed'}))],output_text:result.raw}
  return {...metadata,choices:[{index:0,finish_reason:toolCalls.length?'tool_calls':'stop',message:{role:'assistant',content:result.raw,...(toolCalls.length?{tool_calls:toolCalls}:{})}}]}
}

/** Checks identity at invocation, including clients cached before login. */
export function wrapOwnerSdkClient(client, provider = 'openai') {
  if (!client || nativeClients.has(client)) return client
  const proxies = new WeakMap()
  const wrap = (target, parts = []) => {
    if (proxies.has(target)) return proxies.get(target)
    const proxy = new Proxy(target, {
      get(object, property) {
        const value = Reflect.get(object, property, object)
        if (typeof property !== 'string') return value
        const next = [...parts, property]
        if (typeof value === 'function') return function (...args) {
          if (getOwnerAiScope({includeAborted:true})) return invokeOwnerRequest(provider, next.join('.'), args[0], args[1])
          const result = Reflect.apply(value, object, args)
          const operation = next.join('.')
          if (!['chat.completions.create','responses.create','messages.create'].includes(operation) || !result?.catch) return result
          const started = Date.now()
          return result.catch(error => {
            const status = Number(error?.status)
            const quota = /quota|credit balance|billing|rate.limit/i.test(String(error?.message || ''))
            if (args[1]?.signal?.aborted || !([401,402,403,429].includes(status) || status >= 500 || quota)) throw error
            const options = {...(args[1] || {})}
            if (Number.isFinite(options.timeout)) options.timeout = Math.max(0, options.timeout - (Date.now() - started))
            return invokeOwnerRequest(provider, operation, args[0], options)
          })
        }
        if (value && typeof value === 'object') return wrap(value, next)
        return value
      },
    })
    proxies.set(target, proxy)
    return proxy
  }
  const wrapped = wrap(client)
  nativeClients.set(wrapped, client)
  return wrapped
}
