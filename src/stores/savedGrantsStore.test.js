// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ api: vi.fn(), state: { user: { id: 'u1' }, activeProfileId: 'p1' }, listener: null }))
vi.mock('@/api/client', () => ({ apiFetch: mocks.api, default: { getActiveProfileId: () => mocks.state.activeProfileId } }))
vi.mock('@/stores/authStore', () => ({ useAuthStore: Object.assign((select) => select(mocks.state), {
  getState: () => mocks.state,
  subscribe: (fn) => { mocks.listener = fn; return () => {} },
}) }))
import { useSavedGrantsStore as store } from './savedGrantsStore'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function switchScope(userId, profileId) {
  const previous = mocks.state
  mocks.state = { user: { id: userId }, activeProfileId: profileId }
  mocks.listener(mocks.state, previous)
}
beforeEach(() => {
  mocks.api.mockReset()
  localStorage.clear()
  switchScope('u1', 'p1')
  store.getState().resetForScope()
})
describe('confirmed and isolated saved work', () => {
  it('does not claim saved before the server confirms', async () => {
    const request = deferred(); mocks.api.mockReturnValueOnce(request.promise)
    const saving = store.getState().saveGrant('o1')
    expect(store.getState().writing.o1).toBe(true)
    expect(store.getState().savedIds).toEqual([])
    request.resolve({ saved: true })
    expect(await saving).toBe(true)
    expect(store.getState().savedIds).toEqual(['o1'])
    expect(store.getState().pending).toEqual({})
  })
  it('keeps failed note text for retry without changing the saved note', async () => {
    store.setState({ notesMap: { o1: 'previous' } })
    mocks.api.mockRejectedValueOnce(new Error('offline'))
    expect(await store.getState().updateNote('o1', 'unsaved text')).toBe(false)
    expect(store.getState().getNote('o1')).toBe('previous')
    expect(store.getState().pending.o1).toEqual({ kind: 'note', notes: 'unsaved text' })
    expect(store.getState().writing).toEqual({})
    mocks.api.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ids: ['o1'], saved: [{ opportunity_id: 'o1', notes: 'unsaved text' }] })
    expect(await store.getState().retryPending()).toBe(true)
    expect(store.getState().getNote('o1')).toBe('unsaved text')
    expect(store.getState().pending).toEqual({})
  })
  it('never reuploads server-deleted bookmarks from a local cache', async () => {
    store.setState({ savedIds: ['removed'], synced: true })
    mocks.api.mockResolvedValueOnce({ ids: [], saved: [] })
    await store.getState().sync()
    expect(store.getState().savedIds).toEqual([])
    expect(mocks.api).toHaveBeenCalledTimes(1)
    expect(mocks.api.mock.calls[0][0]).toBe('/api/saved-grants?profile_id=p1')
  })
  it('clears records immediately on profile switch and ignores a late old response', async () => {
    const first = deferred(); mocks.api.mockReturnValueOnce(first.promise)
    const old = store.getState().sync()
    switchScope('u2', 'p2')
    expect(store.getState().savedIds).toEqual([])
    mocks.api.mockResolvedValueOnce({ ids: ['new'], saved: [{ opportunity_id: 'new' }] })
    await store.getState().sync()
    first.resolve({ ids: ['private-old'], saved: [{ opportunity_id: 'private-old' }] })
    await old
    expect(store.getState().savedIds).toEqual(['new'])
  })
  it('confirms concurrent writes to different bookmarks independently', async () => {
    const a = deferred(), b = deferred()
    mocks.api.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise)
    const one = store.getState().saveGrant('o1'), two = store.getState().saveGrant('o2')
    a.resolve({ saved: true }); expect(await one).toBe(true)
    b.resolve({ saved: true }); expect(await two).toBe(true)
    expect(store.getState().savedIds).toEqual(['o1', 'o2'])
    expect(store.getState().pending).toEqual({})
  })
  it('a stale read cannot overwrite a confirmed save', async () => {
    const reading = deferred(); mocks.api.mockReturnValueOnce(reading.promise).mockResolvedValueOnce({ saved: true })
    const sync = store.getState().sync()
    await store.getState().saveGrant('o1')
    reading.resolve({ ids: [], saved: [] }); await sync
    expect(store.getState().savedIds).toEqual(['o1'])
  })
  it('prevents duplicate in-flight writes and labels unavailable reads', async () => {
    const request = deferred(); mocks.api.mockReturnValueOnce(request.promise)
    const first = store.getState().saveGrant('o1')
    expect(await store.getState().saveGrant('o1')).toBe(false)
    expect(mocks.api).toHaveBeenCalledTimes(1)
    request.resolve({ saved: true }); await first
    mocks.api.mockRejectedValueOnce(new Error('offline'))
    expect(await store.getState().sync()).toBe(false)
    expect(store.getState().synced).toBe(false)
    expect(store.getState().syncError).toMatch(/could not be checked/)
    expect(store.getState().savedIds).toEqual(['o1'])
  })
  it('does not write without an active authenticated scope', async () => {
    switchScope('u1', null)
    expect(await store.getState().saveGrant('o1')).toBe(false)
    expect(mocks.api).not.toHaveBeenCalled()
  })
})
