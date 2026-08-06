import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { launchGuardedPortalBrowser } from '../services/hamilton/browserLaunch.js'

const ROOT = path.resolve(process.cwd(), 'backend/services/hamilton')

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return jsFiles(full)
    return entry.isFile() && entry.name.endsWith('.js') ? [full] : []
  })
}

function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('Hamilton mandatory guarded browser factory', () => {
  it('installs the network guard before returning any external portal context', async () => {
    const calls = []
    const context = {}
    const browser = {
      newContext: vi.fn(async () => { calls.push('newContext'); return context }),
      close: vi.fn(async () => {}),
    }
    const launchBrowser = vi.fn(async () => { calls.push('launch'); return { browser, engine: 'fixture' } })
    const prepareEgress = vi.fn(async () => {
      calls.push('prepare')
      return { extra_args: ['--host-resolver-rules=MAP portal.example 93.184.216.34,MAP * ~NOTFOUND'], context_options: { serviceWorkers: 'block' } }
    })
    const installGuard = vi.fn(async () => { calls.push('guard') })
    const result = await launchGuardedPortalBrowser({}, {
      targetUrl: 'https://portal.example/apply', prepareEgress, installGuard, launchBrowser,
    })
    expect(result).toMatchObject({ browser, context })
    expect(calls).toEqual(['prepare', 'launch', 'newContext', 'guard'])
  })

  it('forbids direct external launches, contexts, CDP, and navigation outside the guarded choke points', () => {
    const allowed = new Set([
      path.join(ROOT, 'browserLaunch.js'),
      path.join(ROOT, 'hamiltonBrowserNetworkGuard.js'),
      path.join(ROOT, 'hamiltonApplicationPacketGenerator.js'),
    ])
    const forbidden = /\bconnectOverCDP\s*\(|\bchromium\.launch\s*\(|\.newContext\s*\(|\.goto\s*\(/g
    const offenders = []
    for (const file of jsFiles(ROOT)) {
      if (allowed.has(file)) continue
      const source = withoutComments(fs.readFileSync(file, 'utf8'))
      if (forbidden.test(source)) offenders.push(path.relative(ROOT, file))
      forbidden.lastIndex = 0
    }
    expect(offenders).toEqual([])

    const localRenderer = fs.readFileSync(path.join(ROOT, 'hamiltonApplicationPacketGenerator.js'), 'utf8')
    expect(localRenderer).toContain('page.setContent(')
    expect(withoutComments(localRenderer)).not.toMatch(/\.goto\s*\(|\bconnectOverCDP\s*\(/)
  })

  it('keeps every external flow visibly bound to the guarded factory/navigation helpers', () => {
    const required = {
      'hamiltonAutopilotEngine.js': ['launchGuardedPortalBrowser', 'navigateHamiltonPortalPage'],
      'hamiltonCloudLogin.js': ['launchGuardedPortalBrowser', 'navigateHamiltonPortalPage'],
      'hamiltonPortalSignupAdapter.js': ['launchGuardedPortalBrowser', 'navigateHamiltonPortalPage'],
      'hamiltonSessionKeepAlive.js': ['launchGuardedPortalBrowser', 'navigateHamiltonPortalPage'],
      'hamiltonSubmissionReconciler.js': ['launchGuardedPortalBrowser', 'navigateHamiltonPortalPage'],
      'portalSync/index.js': ['launchGuardedPortalBrowser'],
      'portalSync/llmPageExtract.js': ['navigateHamiltonPortalPage'],
      'portalSync/connectors/generic.js': ['navigateHamiltonPortalPage'],
      'portalSync/connectors/mtsu.js': ['navigateHamiltonPortalPage'],
      'portalSync/connectors/ngwebScholarshipManager.js': ['navigateHamiltonPortalPage'],
      'portalSync/connectors/studentaid.js': ['navigateHamiltonPortalPage'],
    }
    for (const [relative, symbols] of Object.entries(required)) {
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8')
      for (const symbol of symbols) expect(source, `${relative} must use ${symbol}`).toContain(symbol)
    }
  })
})
