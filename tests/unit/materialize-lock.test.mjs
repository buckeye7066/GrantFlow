// Guard tests for the source-materialization cross-process mutex.
//
// The defect these protect against: `npm run dev:full` runs
// `concurrently "npm run backend" "npm run dev"`, and BOTH npm scripts fire the
// `materialize-production-source.mjs` pre-hook. Two materializers
// read-modify-write the same product source files, so one intermittently reads
// a file the other is mid-write and dies with `<anchor> missing or ambiguous`.
// Whichever dev server lost the race never came up — measured 2026-08-01 as
// EVA's "GrantFlow not ready at http://localhost:5173" (1 launch in 5).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  materializeLockPath,
  acquireMaterializeLockSync,
  releaseMaterializeLock,
} from '../../scripts/source-materialization/materialize-lock.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const lockModule = path.resolve(here, '../../scripts/source-materialization/materialize-lock.mjs')

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('different repo roots get different locks — worktrees never block each other', () => {
  const dir = tmp('mat-lock-key-')
  const a = materializeLockPath('C:/Users/x/GrantFlow', dir)
  const b = materializeLockPath('C:/Users/x/wt-eva', dir)
  assert.notEqual(a, b)
  // …and the same root is stable across calls and case-insensitive on Windows paths.
  assert.equal(materializeLockPath('C:/Users/x/GrantFlow', dir), a)
  assert.equal(materializeLockPath('c:/users/x/grantflow', dir), a)
})

test('a held lock is NOT granted twice, and the waiter fails loudly instead of proceeding unserialized', () => {
  const dir = tmp('mat-lock-held-')
  const held = acquireMaterializeLockSync({ repoRoot: '/repo', tmpDir: dir, timeoutMs: 500, staleMs: 60_000, sleep: () => {} })
  let clock = 0
  assert.throws(
    () =>
      acquireMaterializeLockSync({
        repoRoot: '/repo',
        tmpDir: dir,
        timeoutMs: 500,
        staleMs: 60_000,
        now: () => (clock += 200),
        sleep: () => {},
      }),
    /timed out .* waiting for the materialization lock/,
    'a second materializer must never quietly proceed while the first holds the lock',
  )
  held.release()
})

test('releasing hands the lock to the next caller', () => {
  const dir = tmp('mat-lock-release-')
  const first = acquireMaterializeLockSync({ repoRoot: '/repo', tmpDir: dir, sleep: () => {} })
  first.release()
  const second = acquireMaterializeLockSync({ repoRoot: '/repo', tmpDir: dir, timeoutMs: 500, sleep: () => {} })
  assert.equal(second.waited, false)
  second.release()
})

test('a lock left behind by a killed holder is broken, never wedging npm run dev forever', () => {
  const dir = tmp('mat-lock-stale-')
  const lockPath = materializeLockPath('/repo', dir)
  fs.mkdirSync(lockPath)
  const old = Date.now() - 10 * 60_000
  fs.utimesSync(lockPath, new Date(old), new Date(old))
  const held = acquireMaterializeLockSync({ repoRoot: '/repo', tmpDir: dir, timeoutMs: 2000, staleMs: 60_000, sleep: () => {} })
  assert.ok(fs.existsSync(held.lockPath))
  held.release()
  assert.equal(fs.existsSync(lockPath), false)
})

test('release is idempotent and never throws on an already-gone lock', () => {
  const dir = tmp('mat-lock-idem-')
  const lockPath = materializeLockPath('/repo', dir)
  releaseMaterializeLock(lockPath)
  releaseMaterializeLock(lockPath)
  assert.equal(fs.existsSync(lockPath), false)
})

test('two REAL processes never hold the lock at the same time', async () => {
  const dir = tmp('mat-lock-procs-')
  const journal = path.join(dir, 'journal.txt')
  fs.writeFileSync(journal, '')
  const worker = path.join(dir, 'worker.mjs')
  fs.writeFileSync(
    worker,
    `import fs from 'node:fs'
import { acquireMaterializeLockSync } from ${JSON.stringify(new URL(`file:///${lockModule.replace(/\\/g, '/')}`).href)}
const [, , tmpDir, journal, tag] = process.argv
const held = acquireMaterializeLockSync({ repoRoot: '/repo', tmpDir, timeoutMs: 30000 })
fs.appendFileSync(journal, 'IN' + tag + '\\n')
await new Promise((r) => setTimeout(r, 400))
fs.appendFileSync(journal, 'OUT' + tag + '\\n')
held.release()
`,
    'utf8',
  )
  const run = (tag) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, dir, journal, tag], { stdio: 'ignore' })
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${tag} exited ${code}`))))
      child.on('error', reject)
    })
  await Promise.all([run('A'), run('B'), run('C')])

  const lines = fs.readFileSync(journal, 'utf8').split(/\r?\n/).filter(Boolean)
  assert.equal(lines.length, 6, 'every worker recorded an enter and an exit')
  // The critical section must never be entered while another holds it: every
  // IN is immediately followed by its own OUT.
  for (let i = 0; i < lines.length; i += 2) {
    assert.ok(lines[i].startsWith('IN'), `expected an enter at ${i}, got ${lines.join(',')}`)
    assert.equal(lines[i + 1], `OUT${lines[i].slice(2)}`, `overlapping critical sections: ${lines.join(',')}`)
  }
})
