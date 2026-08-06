import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const SOURCE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'recovery', 'build-file-audit.mjs')

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function runAudit(cwd, ...args) {
  return spawnSync(process.execPath, ['scripts/recovery/build-file-audit.mjs', ...args], {
    cwd,
    encoding: 'utf8',
  })
}

test('FILE_AUDIT verifies a clean source commit through one ledger-only child commit', () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'grantflow-file-audit-'))
  try {
    mkdirSync(path.join(fixtureRoot, 'scripts', 'recovery'), { recursive: true })
    mkdirSync(path.join(fixtureRoot, 'docs', 'recovery'), { recursive: true })
    copyFileSync(SOURCE_SCRIPT, path.join(fixtureRoot, 'scripts', 'recovery', 'build-file-audit.mjs'))
    writeFileSync(path.join(fixtureRoot, 'app.js'), 'export const ready = true\n')

    git(fixtureRoot, ['init', '--quiet'])
    git(fixtureRoot, ['config', 'user.name', 'GrantFlow Test'])
    git(fixtureRoot, ['config', 'user.email', 'grantflow-test@example.invalid'])
    git(fixtureRoot, ['add', '.'])
    git(fixtureRoot, ['commit', '--quiet', '-m', 'source'])
    const sourceSha = git(fixtureRoot, ['rev-parse', 'HEAD'])

    const generated = runAudit(fixtureRoot)
    assert.equal(generated.status, 0, generated.stderr)
    const ledgerPath = path.join(fixtureRoot, 'docs', 'recovery', 'FILE_AUDIT.csv')
    const ledger = readFileSync(ledgerPath, 'utf8')
    assert.doesNotMatch(ledger, /^docs\/recovery\/FILE_AUDIT\.csv,/m)
    assert.match(ledger, new RegExp(`${sourceSha}$`, 'm'))

    git(fixtureRoot, ['add', 'docs/recovery/FILE_AUDIT.csv'])
    git(fixtureRoot, ['commit', '--quiet', '-m', 'ledger'])
    const verified = runAudit(fixtureRoot, '--verify')
    assert.equal(verified.status, 0, verified.stderr)
    assert.match(verified.stdout, /reconciles/)

    writeFileSync(path.join(fixtureRoot, 'app.js'), 'export const ready = false\n')
    const dirty = runAudit(fixtureRoot, '--verify')
    assert.equal(dirty.status, 1)
    assert.match(dirty.stderr, /clean committed source tree/)

    writeFileSync(path.join(fixtureRoot, 'app.js'), 'export const ready = true\n')
    writeFileSync(path.join(fixtureRoot, 'next.js'), 'export const next = true\n')
    git(fixtureRoot, ['add', 'next.js'])
    git(fixtureRoot, ['commit', '--quiet', '-m', 'source drift'])
    const stale = runAudit(fixtureRoot, '--verify')
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /neither HEAD nor its ledger-only parent/)
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
