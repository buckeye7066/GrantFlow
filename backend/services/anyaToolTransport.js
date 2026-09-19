import { randomUUID } from 'node:crypto'
import { invokeJsonWithFallback } from '../utils/aiProviders.js'

// Produces a plan. The existing registry retains all authorization and execution.
export async function invokeAnyaToolTurn({ messages, tools = [], maxTokens = 1800, timeoutMs = 20000, signal, excludedProviders = [] } = {}) {
  const available = new Set(tools.map(tool => tool?.function?.name).filter(Boolean))
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n')
  const result = await invokeJsonWithFallback({
    system,
    prompt: JSON.stringify({
      response_format: { reply: 'string', tool_calls: [{ name: 'available tool name', arguments: 'object' }] },
      response_rules: 'Return a reply with an empty tool_calls array, or at most four authorized tool requests. Tool requests have not executed. Retain all confirmation requirements.',
      conversation: messages.filter(message => message.role !== 'system'), available_tools: tools,
    }),
    temperature: 0.3, maxTokens, timeoutMs, signal, excludedProviders,
  })
  const output = result?.json
  if (!result?.ok || !output || typeof output.reply !== 'string' || !Array.isArray(output.tool_calls) ||
      output.tool_calls.length > 4 || output.reply.length > 16000) throw new Error('Incomplete tool response')
  const toolCalls = output.tool_calls.map(call => {
    if (!call || !available.has(call.name) || !call.arguments || typeof call.arguments !== 'object' ||
        Array.isArray(call.arguments)) throw new Error('Unavailable or malformed tool request')
    const args = JSON.stringify(call.arguments)
    if (args.length > 32000) throw new Error('Tool arguments exceed the request bound')
    return { id: 'call_' + randomUUID(), type: 'function', function: { name: call.name, arguments: args } }
  })
  return { choices: [{ message: { content: output.reply, tool_calls: toolCalls } }], provider: result.provider, billing_mode: result.billing_mode, model: result.model, usage: result.usage }
}
