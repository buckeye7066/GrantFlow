/**
 * MEASURED on the prod container 2026-09-06 as the app user (`node`), one
 * fresh process each: HOME=/home/node → full Chromium; HOME=/ , unset, /tmp,
 * /nonexistent → the browser dies at launch and the launcher downgrades to
 * headless-shell. The server ran without a usable HOME, so every prod run
 * was on the engine Akamai-class walls kill and Microsoft's sign-in could
 * not be advanced. launchEnv gives the browser a HOME it can use.
 */
import { describe, it, expect } from 'vitest'
import { launchEnv } from '../services/hamilton/browserLaunch.js'

function fakeFs(writable) {
  const set = new Set(writable)
  return {
    constants: { W_OK: 2 },
    statSync: (d) => { if (!set.has(d) && !d.startsWith('/mk/')) throw new Error('ENOENT'); return { isDirectory: () => true } },
    accessSync: (d) => { if (!set.has(d) && !d.startsWith('/mk/')) throw new Error('EACCES') },
    mkdirSync: (d) => { set.add(d) },
  }
}
const os = { userInfo: () => ({ homedir: '/home/node' }), tmpdir: () => '/mk' }

describe('launchEnv — the browser gets a HOME full Chromium can use', () => {
  it('keeps a real, writable HOME', () => {
    const env = launchEnv({ HOME: '/home/node', PATH: '/bin' }, { fs: fakeFs(['/home/node']), os })
    expect(env.HOME).toBe('/home/node')
    expect(env.PATH).toBe('/bin')
    expect(env.XDG_CONFIG_HOME).toBe('/home/node/.config')
  })

  it.each([['/'], [''], ['/nonexistent'], [undefined]])('HOME=%s falls back to the passwd home', (home) => {
    const base = home === undefined ? {} : { HOME: home }
    const env = launchEnv(base, { fs: fakeFs(['/home/node']), os })
    expect(env.HOME).toBe('/home/node')
  })

  it('an unwritable HOME (the "/tmp" and read-only cases) yields to the passwd home', () => {
    const env = launchEnv({ HOME: '/tmp' }, { fs: fakeFs(['/home/node']), os })
    expect(env.HOME).toBe('/home/node')
  })

  it('with no passwd home either, creates and uses its own directory under the OS tmp root', () => {
    const env = launchEnv({ HOME: '/' }, { fs: fakeFs([]), os: { userInfo: () => { throw new Error('no passwd') }, tmpdir: () => '/mk' } })
    expect(env.HOME).toBe('/mk/hamilton-browser-home')
    expect(env.XDG_CACHE_HOME).toBe('/mk/hamilton-browser-home/.cache')
  })

  it('never overrides XDG dirs the process already set', () => {
    const env = launchEnv({ HOME: '/home/node', XDG_CONFIG_HOME: '/etc/x' }, { fs: fakeFs(['/home/node']), os })
    expect(env.XDG_CONFIG_HOME).toBe('/etc/x')
  })
})
