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

test('the scanner detects rendered wording inside string delimiters and JS escapes', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'grantflow-language-rendered-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const fixtureEnv = { ...process.env }
  delete fixtureEnv.GIT_INDEX_FILE

  mkdirSync(path.join(fixture, 'scripts'), { recursive: true })
  mkdirSync(path.join(fixture, 'src'), { recursive: true })
  copyFileSync(scanner, path.join(fixture, 'scripts/check-release-language.py'))
  writeFileSync(path.join(fixture, 'src/fixture.jsx'), 'ordinary interface copy')
  let git = spawnSync('git', ['init', '-q'], { cwd: fixture, encoding: 'utf8', env: fixtureEnv })
  assert.equal(git.status, 0, git.stderr || git.stdout)
  git = spawnSync('git', ['add', 'scripts/check-release-language.py', 'src/fixture.jsx'], {
    cwd: fixture,
    encoding: 'utf8',
    env: fixtureEnv,
  })
  assert.equal(git.status, 0, git.stderr || git.stdout)

  const completionTail = ['o', 'ff'].join('')
  const slash = String.fromCharCode(92)
  const tick = String.fromCharCode(96)
  const probes = [
    `<p>{"<!-- ${['si', '&#103;', 'n ', completionTail].join('')} -->"}</p>`,
    `const label = "prefix <!-- ${['si', '&#103;', 'n ', completionTail].join('')} --> suffix"; return <p>{label}</p>`,
    `<div aria-label="${['si', '&#103;', 'n ', completionTail].join('')}" />`,
    `<div title={'${['si', '&#103;', 'n ', completionTail].join('')}'} />`,
    `<p>{'${['si', '\\', 'u0067n ', completionTail].join('')}'}</p>`,
    `<p>{'${['si', '\\', 'x67n ', completionTail].join('')}'}</p>`,
    `<p>{'si${slash}u{000067}n ${completionTail}'}</p>`,
    ...['\n', '\r', '\r\n', '\u2028', '\u2029'].map(
      (lineEnd) => `<p>{'si${slash}${lineEnd}gn ${completionTail}'}</p>`,
    ),
    `<p>{'si${slash}gn ${completionTail}'}</p>`,
    `const label = 'si${slash}gn ${completionTail}'`,
    [tick, "si${'gn'} ", completionTail, tick].join(''),
    `const label = 'si' + /* note with 'quotes' */ 'gn ' + '${completionTail}'`,
    `const label = 'si' + // line note\n'gn ' + '${completionTail}'`,
    `owner si\uFE0Fgn ${completionTail}`,
    `owner si\u{E0100}gn ${completionTail}`,
  ]
  for (const probe of probes) {
    writeFileSync(path.join(fixture, 'src/fixture.jsx'), probe)
    git = spawnSync('git', ['add', 'src/fixture.jsx'], { cwd: fixture, encoding: 'utf8', env: fixtureEnv })
    assert.equal(git.status, 0, git.stderr || git.stdout)
    const result = spawnSync('python3', ['scripts/check-release-language.py'], {
      cwd: fixture,
      encoding: 'utf8',
      env: fixtureEnv,
    })
    assert.equal(result.status, 1, result.stderr || result.stdout)
    assert.match(result.stdout, /src\/fixture\.jsx/)
  }
})

test('the rendered projection ignores inert bodies and preserves even-slash and lexical boundaries', (t) => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'grantflow-language-negative-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const fixtureEnv = { ...process.env }
  delete fixtureEnv.GIT_INDEX_FILE

  mkdirSync(path.join(fixture, 'scripts'), { recursive: true })
  mkdirSync(path.join(fixture, 'src'), { recursive: true })
  copyFileSync(scanner, path.join(fixture, 'scripts/check-release-language.py'))
  writeFileSync(path.join(fixture, 'src/fixture.jsx'), 'ordinary interface copy')
  let git = spawnSync('git', ['init', '-q'], { cwd: fixture, encoding: 'utf8', env: fixtureEnv })
  assert.equal(git.status, 0, git.stderr || git.stdout)
  git = spawnSync('git', ['add', 'scripts/check-release-language.py', 'src/fixture.jsx'], {
    cwd: fixture,
    encoding: 'utf8',
    env: fixtureEnv,
  })
  assert.equal(git.status, 0, git.stderr || git.stdout)

  const completionTail = ['o', 'ff'].join('')
  const slash = String.fromCharCode(92)
  const probes = [
    `const label = 'si${slash}${slash}gn ${completionTail}'`,
    `<script>const label = 'si' + 'gn ' + '${completionTail}'</script>`,
    `<style>.label::after { content: 'si' + 'gn ' + '${completionTail}' }</style>`,
    `<template><span>si&#103;n ${completionTail}</span></template>`,
    `<p>Don't <!-- ${['si', '&#103;', 'n ', completionTail].join('')} --> preserve comments that aren't literals.</p>`,
    'The assignment offers deterministic work distribution.',
    'A sign officer witnesses the applicant signature.',
  ]
  for (const probe of probes) {
    writeFileSync(path.join(fixture, 'src/fixture.jsx'), probe)
    git = spawnSync('git', ['add', 'src/fixture.jsx'], { cwd: fixture, encoding: 'utf8', env: fixtureEnv })
    assert.equal(git.status, 0, git.stderr || git.stdout)
    const result = spawnSync('python3', ['scripts/check-release-language.py'], {
      cwd: fixture,
      encoding: 'utf8',
      env: fixtureEnv,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  }
})
