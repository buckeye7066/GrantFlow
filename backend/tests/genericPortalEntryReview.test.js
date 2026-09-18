import { beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ extract: vi.fn(), report: vi.fn() }))
vi.mock('../services/hamilton/portalSync/llmPageExtract.js', () => ({ extractPortalDataWithLLM: calls.extract }))
vi.mock('../services/hamilton/portalSync/outsideAwardReporter.js', () => ({ reportOutsideAwards: calls.report }))
import generic from '../services/hamilton/portalSync/connectors/generic.js'
import { findGenericAccountEntry } from '../services/hamilton/portalSync/genericAccess.js'
const origin = 'https://www.example.org'
const account = { title: 'Account', chars: 200, hasLogout: true, hasAccountNavigation: true, hasPassword: false, hasSignInPrompt: false, blocked: false }
const publicPage = { ...account, hasLogout: false, hasAccountNavigation: false }
const ctx = { portalHost: 'example.org', hasSession: true }
function browser({ prompt = false, password = false } = {}) {
  let here = origin + '/'
  const page = { url: () => here, goto: vi.fn(async url => { here = url === 'https://example.org/' ? origin + '/' : url }),
    evaluate: vi.fn(async fn => String(fn).includes("querySelectorAll('a[href]')")
      ? [origin + '/login'] : here.endsWith('/login') ? account : { ...publicPage, hasSignInPrompt: prompt, hasPassword: password }) }
  return page
}
beforeEach(() => {
  vi.clearAllMocks()
  calls.extract.mockResolvedValue({ fields: [], awards: [], rejected: [], notFound: [], raw: {} })
  calls.report.mockResolvedValue({ written: [], skipped: [], submitted: false })
})
it('follows a login link on the approved canonical www redirect', async () => {
  const page = browser()
  expect((await generic.read(page, ctx)).access).toBe('authenticated')
  expect(page.goto.mock.calls.map(([url]) => url)).toEqual(['https://example.org/', origin + '/login'])
})
it('tries a safe entry on a public sign-in prompt without filling a password', async () => {
  const page = browser({ prompt: true })
  expect((await generic.read(page, { ...ctx, portalHost: 'www.example.org' })).access).toBe('authenticated')
  expect(calls.extract).toHaveBeenCalledTimes(1)
})
it('never attempts an account entry from a visible password wall', async () => {
  const page = browser({ prompt: true, password: true })
  expect((await generic.read(page, ctx)).access).toBe('signin_wall')
  expect(page.goto).toHaveBeenCalledTimes(1)
  expect(calls.extract).not.toHaveBeenCalled()
})
it('skips fragment-only entries and chooses the next actual GET destination', async () => {
  const page = { url: () => origin + '/', evaluate: async () => [origin + '/#login', origin + '/login#form'] }
  expect(await findGenericAccountEntry(page, origin + '/')).toBe(origin + '/login')
})
it('read followed by write preserves the proven account destination', async () => {
  const page = browser()
  await generic.read(page, { ...ctx, portalHost: 'www.example.org' })
  await generic.write(page, { ...ctx, portalHost: 'www.example.org' }, { fundingSources: [] })
  expect(page.url()).toBe(origin + '/login')
  expect(page.goto).toHaveBeenCalledTimes(2)
  expect(calls.report).toHaveBeenCalledTimes(1)
})
it('standalone write uses the same safe entry and requires observed account controls', async () => {
  const page = browser({ prompt: true })
  await generic.write(page, { ...ctx, portalHost: 'www.example.org' }, {})
  expect(page.url()).toBe(origin + '/login')
  expect(calls.report).toHaveBeenCalledTimes(1)
})

it('a write without verified authentication never invokes the form writer', async () => {
  const page = browser({ password: true })
  const result = await generic.write(page, ctx, {})
  expect(result.access).toBe('signin_wall')
  expect(result.submitted).toBe(false)
  expect(calls.report).not.toHaveBeenCalled()
})
