import assert from 'node:assert/strict'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scanner = path.join(root, 'scripts/check-release-language.py')

function runPolicy(...args) {
  return spawnSync('python3', [scanner, ...args], {
    cwd: root,
    encoding: 'utf8',
  })
}

test('delivery-language probes cover wrapping, rendered JSX boundaries, and literal concatenation', () => {
  const result = runPolicy('--self-test')
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('the complete tracked tree satisfies the delivery-language policy', () => {
  const result = runPolicy()
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('the scanner batches root-anchored index reads before worktree replacements', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'grantflow-language-policy-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const fixtureEnv = { ...process.env }
  delete fixtureEnv.GIT_INDEX_FILE

  mkdirSync(path.join(fixture, 'scripts'), { recursive: true })
  copyFileSync(scanner, path.join(fixture, 'scripts/check-release-language.py'))

  mkdirSync(path.join(fixture, 'backend'), { recursive: true })
  writeFileSync(path.join(fixture, '.env.example'), 'ordinary root value')
  const stagedText = ['si', 'gn ', 'off'].join('')
  const fixturePath = path.join(fixture, 'backend/.env.example')
  writeFileSync(fixturePath, stagedText)

  for (const args of [[
    'init', '-q',
  ], [
    'add', 'scripts/check-release-language.py', '.env.example', 'backend/.env.example',
  ]]) {
    const git = spawnSync('git', args, { cwd: fixture, encoding: 'utf8', env: fixtureEnv })
    assert.equal(git.status, 0, git.stderr || git.stdout)
  }

  writeFileSync(fixturePath, 'ordinary deployment evidence')
  const result = spawnSync('python3', ['../scripts/check-release-language.py'], {
    cwd: path.join(fixture, 'backend'),
    encoding: 'utf8',
    env: fixtureEnv,
  })

  assert.equal(result.status, 1, result.stderr || result.stdout)
  assert.match(result.stdout, /backend\/\.env\.example/)
})
