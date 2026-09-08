// Only loaded by the production-shaped authentication test child process.
// Exercise the real SDK against a deterministic transport; never deliver mail.
const originalFetch = globalThis.fetch
const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (localHosts.has(url.hostname)) return originalFetch(input, init)
  if (url.origin !== 'https://api.resend.com' || url.pathname !== '/emails') {
    throw new Error('External network disabled in the email authentication fixture')
  }
  if (new Headers(init.headers).get('authorization') !== 'Bearer test-key') {
    throw new Error('Only the synthetic email API key is accepted by this fixture')
  }
  return Response.json({ id: 'fixture-email-receipt' })
}
