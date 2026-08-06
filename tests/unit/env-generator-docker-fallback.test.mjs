import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  enumerateSourceFiles,
  extractEnvReferences,
} from '../../scripts/generate-env-examples.mjs'
import { parseEnvExample } from '../../scripts/inventory-env.mjs'

function write(root, relative, content = '') {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('env generator has a deterministic no-git filesystem fallback for Docker builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-env-fallback-'))
  try {
    const processEnv = 'process' + '.env'
    const importMetaEnv = 'import.meta' + '.env'
    write(root, 'backend/server.js', `${processEnv}.BACKEND_SAMPLE`)
    write(root, 'src/config/env.js', `${importMetaEnv}.VITE_SAMPLE`)
    write(root, 'scripts/example-build-tool.mjs', `${processEnv}.BUILD_SAMPLE`)
    write(root, 'tests/unit/example.test.mjs', `${processEnv}.TEST_SAMPLE`)
    write(root, 'node_modules/pkg/index.js', `${processEnv}.MUST_NOT_SCAN`)
    write(root, 'dist/bundle.js', `${processEnv}.MUST_NOT_SCAN`)
    write(root, '.cursor/worktree/agent.js', `${processEnv}.MUST_NOT_SCAN`)

    const relative = enumerateSourceFiles({ forceFilesystem: true, root })
      .map((file) => path.relative(root, file).replace(/\\/g, '/'))

    assert.deepEqual(relative, [
      'backend/server.js',
      'scripts/example-build-tool.mjs',
      'src/config/env.js',
      'tests/unit/example.test.mjs',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Docker build context retains the env-generator scan surface', () => {
  const dockerignore = fs.readFileSync('.dockerignore', 'utf8')
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')

  assert.doesNotMatch(dockerignore, /^scripts\/?$/m)
  assert.doesNotMatch(dockerignore, /^tests\/?$/m)
  assert.doesNotMatch(dockerignore, /^\*\.test\.\*$/m)
  assert.match(dockerfile, /COPY \. \./)
})

test('env extraction shares dot, bracket, helper, Vite, and key-registry contracts', () => {
  const processEnv = 'process' + '.env'
  const importMetaEnv = 'import.meta' + '.env'
  const helper = 'readEnv' + 'Bool'
  const registry = 'PRICING_' + 'ENV_KEYS'
  const references = extractEnvReferences([
    `${processEnv}.DOT_NAME`,
    `${processEnv}['BRACKET_NAME']`,
    `${importMetaEnv}.VITE_PUBLIC_NAME`,
    `${helper}('HELPER_NAME', false)`,
    `const ${registry} = Object.freeze({ FLAG: 'REGISTRY_NAME' })`,
  ].join('\n'))
  assert.deepEqual(
    references.map((reference) => reference.varName).sort(),
    ['BRACKET_NAME', 'DOT_NAME', 'HELPER_NAME', 'REGISTRY_NAME', 'VITE_PUBLIC_NAME'],
  )
})

test('env inventory treats commented generated assignments as listed options', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-env-template-'))
  try {
    const example = path.join(root, '.env.example')
    write(root, '.env.example', [
      'ACTIVE_NAME=value',
      '# OPTIONAL_NAME=',
      '# OPTIONAL_SECRET=<REPLACE_ME>',
      '# prose only',
    ].join('\n'))
    assert.deepEqual(
      parseEnvExample(example).map((entry) => entry.varName),
      ['ACTIVE_NAME', 'OPTIONAL_NAME', 'OPTIONAL_SECRET'],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
