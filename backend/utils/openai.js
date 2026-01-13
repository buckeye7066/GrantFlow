export function messageContentToString(content) {
  if (!content) return ''

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map((part) => messageContentToString(part)).join('')
  }

  if (typeof content === 'object') {
    // Ignore tool calls or function messages
    if (content.type === 'tool_call' || content.type === 'assistant_tool_call') {
      return ''
    }

    // OpenAI chat responses often return { type: 'text', text: '...' }
    if (typeof content.text === 'string') {
      return content.text
    }

    if (content.type === 'text' && typeof content.text?.value === 'string') {
      return content.text.value
    }

    if (content.type === 'text' && Array.isArray(content.text?.content)) {
      return content.text.content.map((part) => messageContentToString(part)).join('')
    }

    if (typeof content.value === 'string') {
      return content.value
    }

    if (content.content) {
      return messageContentToString(content.content)
    }

    if (content.data) {
      return messageContentToString(content.data)
    }
  }

  return ''
}

export function extractCompletionText(completion) {
  const message = completion?.choices?.[0]?.message
  if (!message) return ''
  const text = messageContentToString(message.content)
  return text.trim()
}
