import { apiFetch } from '@/api/client'

/**
 * Turn free-text funding needs into search terms for the matcher catalog.
 * @param {string} text
 */
export async function interpretMatcherIntent(text) {
  return apiFetch('/api/matching/interpret-intent', {
    method: 'POST',
    body: JSON.stringify({ text: String(text || '').trim() }),
  })
}
