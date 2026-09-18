import { beforeEach, expect, it, vi } from 'vitest'
const extract = vi.hoisted(() => vi.fn(async () => ({ fields: [], awards: [], rejected: [], notFound: [], raw: { provider: 'fixture' } })))
vi.mock('../services/hamilton/portalSync/llmPageExtract.js', () => ({ extractPortalDataWithLLM: extract }))
import generic from '../services/hamilton/portalSync/connectors/generic.js'
const origin = 'https://portal.fixture.invalid'
const authenticated = { title: 'Applicant home', chars: 500, hasLogout: true, hasAccountNavigation: true, hasPassword: false, hasSignInPrompt: false, blocked: false }
function pageWith(snapshot, url = origin + '/dashboard') {
  return { goto: vi.fn(async () => {}), url: () => url, evaluate: vi.fn(async () => snapshot) }
}
const context = () => ({ portalHost: 'portal.fixture.invalid', hasSession: true, credential: { login_url: origin + '/dashboard' } })
beforeEach(() => extract.mockClear())
it('records observed authenticated access and its exact page provenance', async () => {
  const result = await generic.read(pageWith(authenticated), context())
  expect(result.access).toBe('authenticated')
  expect(result.raw.pages).toEqual([expect.objectContaining({ url: origin + '/dashboard', landed: origin + '/dashboard', access: 'authenticated' })])
  expect(extract).toHaveBeenCalledTimes(1)
  expect(extract.mock.calls[0][1]).toMatchObject({ maxPages: 1 })
})
it.each([
  ['unknown', { ...authenticated, hasLogout: false }],
  ['unknown', { ...authenticated, hasAccountNavigation: false }],
  ['signin_wall', { ...authenticated, hasPassword: true }],
  ['signin_wall', { ...authenticated, hasSignInPrompt: true, hasLogout: false }],
  ['blocked', { ...authenticated, blocked: true }],
])('does not extract or claim signed-in success on %s', async (access, snapshot) => {
  const result = await generic.read(pageWith(snapshot), context())
  expect(result.access).toBe(access)
  expect(result.fields).toEqual([]); expect(result.awards).toEqual([])
  expect(result.notFound.join(' ')).not.toMatch(/signed in successfully/i)
  expect(extract).not.toHaveBeenCalled()
})
it('a public cross-origin redirect cannot prove access to the requested portal', async () => {
  const result = await generic.read(pageWith(authenticated, 'https://other.fixture.invalid/dashboard'), context())
  expect(result.access).not.toBe('authenticated')
  expect(extract).not.toHaveBeenCalled()
})
it('a stale captured-session label without session authority is not proof', async () => {
  const result = await generic.read(pageWith(authenticated), { ...context(), hasSession: false })
  expect(result.access).not.toBe('authenticated')
  expect(extract).not.toHaveBeenCalled()
})
it('unknown navigation results never expose guessed user awards', async () => {
  const p = pageWith(authenticated); p.evaluate.mockRejectedValue(new Error('page unavailable'))
  const result = await generic.read(p, context())
  expect(result.access).toBe('unknown'); expect(extract).not.toHaveBeenCalled()
})
it('discard data if extraction navigation ends at a sign-in wall', async () => {
  const p = pageWith(authenticated)
  p.evaluate.mockResolvedValueOnce(authenticated).mockResolvedValueOnce({ ...authenticated, hasPassword: true })
  extract.mockResolvedValueOnce({ fields: [{ field: 'fixture', value: 'not persisted' }], awards: [{ title: 'not persisted' }], raw: {} })
  const result = await generic.read(p, context())
  expect(result.access).toBe('signin_wall'); expect(result.fields).toEqual([]); expect(result.awards).toEqual([])
})
