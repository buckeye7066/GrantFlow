// Live incident 2026-09-11: production crash-restarted mid Amy crawl on
// `AssertionError: assert(!this.paused)` from Node's bundled undici 7.29.0
// (nodejs/undici#5360). start.js must install userland undici before any other
// module can capture the bundled fetch.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function runFixture(file) {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], { timeout: 50_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? error.signal ?? 'error') : 0, stdout, stderr })
    })
  })
}

describe('userland undici fetch globals', () => {
  it('installs undici as the global fetch and survives a paused parser on socket end', async () => {
    const fixture = path.join(backendDir, 'tests', 'fixtures', 'pausedParserRepro.mjs')
    const result = await runFixture(fixture)
    const report = `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    expect(result.code, report).toBe(0)
    expect(result.stdout, report).toContain('installed=true')
    expect(result.stdout, report).toContain('no crash')
  }, 60_000)

  it('start.js imports the installer before every other module', () => {
    const source = fs.readFileSync(path.join(backendDir, 'start.js'), 'utf8')
    const firstImport = source.split(/\r?\n/).find((line) => /^import\s/.test(line))
    expect(firstImport).toBe("import './installFetchGlobals.js'")
  })
})
