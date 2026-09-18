import { beforeEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
const extract = vi.hoisted(() => vi.fn(async () => ({ fields: [], awards: [], rejected: [], notFound: [], raw: {} })))
vi.mock('../services/hamilton/portalSync/llmPageExtract.js', () => ({ extractPortalDataWithLLM: extract }))
import generic from '../services/hamilton/portalSync/connectors/generic.js'
import { observeGenericAccess, findGenericAccountEntry } from '../services/hamilton/portalSync/genericAccess.js'
const host = 'portal.example.edu', base = 'https://' + host
const ctx = { portalHost: host, hasSession: true }
const signed = { chars: 120, title: 'Account', hasLogout: true, hasAccountNavigation: true }
const publicPage = { chars: 80, title: 'Sign in', hasLogout: false, hasAccountNavigation: false }
beforeEach(() => extract.mockClear())
it('waits for an empty JavaScript shell to render before classifying access', async () => {
  const page = { url: () => base + '/account', evaluate: vi.fn().mockResolvedValueOnce({ chars: 0 }).mockResolvedValue(signed), waitForFunction: vi.fn(async () => {}) }
  expect((await observeGenericAccess(page, ctx)).access).toBe('authenticated')
  expect(page.waitForFunction).toHaveBeenCalledTimes(1)
  expect(page.waitForFunction.mock.calls[0][2].timeout).toBeLessThanOrEqual(5000)
})
it('an unrendered or failed shell never becomes authenticated', async () => {
  const page = { url: () => base, evaluate: vi.fn(async () => ({ chars: 0 })), waitForFunction: vi.fn(async () => { throw Error('timeout') }) }
  expect((await observeGenericAccess(page, ctx)).access).toBe('unknown')
  expect(page.waitForFunction).toHaveBeenCalledTimes(1)
})
it('reuses a session through the bounded public login and campus-ID steps', async () => {
  let url = base + '/'
  const page = { url: () => url, goto: vi.fn(async u => { url = u }), evaluate: vi.fn(async fn => {
    if (String(fn).includes("querySelectorAll('a[href]')")) return [url === base + '/' ? base + '/login' : base + '/secure/']
    return url === base + '/secure/' ? signed : publicPage
  }) }
  expect((await generic.read(page, ctx)).access).toBe('authenticated')
  expect(page.goto.mock.calls.map(([u]) => u)).toEqual([base + '/', base + '/login', base + '/secure/'])
})
it('caps account navigation instead of following an endless login chain', async () => {
  let url = base + '/'; let step = 0
  const page = { url: () => url, goto: vi.fn(async u => { url = u }), evaluate: vi.fn(async fn => String(fn).includes("querySelectorAll('a[href]')") ? [base + '/login?step=' + (++step)] : publicPage) }
  expect((await generic.read(page, ctx)).access).not.toBe('authenticated')
  expect(page.goto.mock.calls.length).toBeLessThanOrEqual(3)
  expect(extract).not.toHaveBeenCalled()
})
it('does not navigate a child portal to a parent credential fallback homepage', async () => {
  let url = ''; const context = { portalHost: 'leic.tennessee.edu', hasSession: true, credential: { portal_host: 'tennessee.edu', login_url: 'https://tennessee.edu/' } }
  const page = { goto: vi.fn(async u => { url = u }), url: () => url, evaluate: vi.fn(async fn => String(fn).includes("querySelectorAll('a[href]')") ? [] : publicPage) }
  await generic.read(page, context)
  expect(page.goto.mock.calls[0][0]).toBe('https://leic.tennessee.edu/')
})
it('a parent credential fallback cannot grant account scope outside the requested portal', async () => {
  const page = { url: () => 'https://tennessee.edu/', evaluate: async () => signed }
  expect((await observeGenericAccess(page, { portalHost: 'leic.tennessee.edu', hasSession: true, credential: { portal_host: 'tennessee.edu', login_url: 'https://tennessee.edu/' } })).access).toBe('unknown')
})
it('recognizes the real campus-ID link label without admitting application actions', async () => {
  const dom = new JSDOM('<a href="/secure/">Log in with Campus ID</a><a href="/apply">Apply</a>', { url: base })
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 10, height: 10 }]
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent } })
  const oldDocument = globalThis.document, oldWindow = globalThis.window
  try {
    globalThis.document = dom.window.document; globalThis.window = dom.window
    expect(await findGenericAccountEntry({ url: () => base, evaluate: fn => fn() }, base)).toBe(base + '/secure/')
  } finally { globalThis.document = oldDocument; globalThis.window = oldWindow; dom.window.close() }
})

it('preserves an explicitly bound federated login destination for the same portal', async () => {
  const context = { ...ctx, credential: { portal_host: host, login_url: 'https://identity.example.edu/login' } }
  const page = { goto: vi.fn(async () => {}), url: () => base + '/account', evaluate: async () => signed }
  expect((await generic.read(page, context)).access).toBe('authenticated')
  expect(page.goto.mock.calls[0][0]).toBe('https://identity.example.edu/login')
})
