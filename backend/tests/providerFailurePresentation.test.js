import { it, expect } from 'vitest'
import { translatePacketContent } from '../services/hamilton/packetTranslation.js'
it('keeps sanitized structured provider messages in translation errors', async () => {
  const invoke = async () => ({ ok: false, provider: 'fallback', anthropicError: { status: 529, message: 'provider_request_failed', transient: true } })
  await expect(translatePacketContent({ title: 'Test', sections: [] }, 'es', { invoke, openai: null })).rejects.toThrow('provider_request_failed')
})
