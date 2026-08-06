// Every chromium.launch() call site in the backend must carry the shared
// CHROMIUM_CONTAINER_ARGS (or live inside browserLaunch.js, which owns them).
// The bare form regressed once: packetPdf.js launched with no args at all,
// dropping --disable-dev-shm-usage — the omission that previously OOM-killed
// the container. This is a totality tripwire, not a behavior test: it greps
// the real tree so a NEW bare launch site fails loudly.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function backendLaunchSites() {
  const files = execFileSync('git', ['ls-files', 'backend/**/*.js'], { cwd: repoRoot })
    .toString()
    .split('\n')
    .filter(Boolean)
    // `git ls-files` includes tracked paths deleted in the current worktree.
    // The tripwire audits source that can actually launch in this checkout; it
    // must not resurrect or try to read a deliberately removed test fixture.
    .filter((rel) => fs.existsSync(path.join(repoRoot, rel)))
  const sites = []
  for (const rel of files) {
    const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8')
    if (!text.includes('chromium.launch(')) continue
    sites.push({ rel, text })
  }
  return sites
}

describe('chromium launch args totality', () => {
  it('every backend chromium.launch site uses CHROMIUM_CONTAINER_ARGS or is the owner module', () => {
    const sites = backendLaunchSites()
    // Sanity: the tripwire must actually see the known launch sites — an empty
    // scan would be a check that cannot fail.
    expect(sites.length).toBeGreaterThanOrEqual(3)
    const offenders = sites
      .filter(({ rel }) => !rel.endsWith('services/hamilton/browserLaunch.js'))
      .filter(({ text }) => !text.includes('CHROMIUM_CONTAINER_ARGS'))
      .map(({ rel }) => rel)
    expect(offenders).toEqual([])
  })

  it('packetPdf launches with the shared container args (the regressed site)', () => {
    const text = fs.readFileSync(path.join(repoRoot, 'backend/services/packetPdf.js'), 'utf8')
    expect(text).toMatch(/chromium\.launch\(\{ headless: true, args: \[\.\.\.CHROMIUM_CONTAINER_ARGS\] \}\)/)
  })
})
