import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { enumerateSourceFiles } from '../../scripts/generate-env-examples.mjs'

function write(root, relative, content = '') {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

test('env generator has a deterministic no-git filesystem fallback for Docker builds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grantflow-env-fallback-'))
  try {
    write(root, 'backend/server.js', 'process.env.BACKEND_SAMPLE')
    write(root, 'src/config/env.js', 'import.meta.env.VITE_SAMPLE')
    write(root, 'scripts/materialize-production-source.mjs', 'process.env.BUILD_SAMPLE')
    write(root, 'tests/unit/example.test.mjs', 'process.env.TEST_SAMPLE')
    write(root, 'node_modules/pkg/index.js', 'process.env.MUST_NOT_SCAN')
    write(root, 'dist/bundle.js', 'process.env.MUST_NOT_SCAN')
    write(root, '.cursor/worktree/agent.js', 'process.env.MUST_NOT_SCAN')

    const relative = enumerateSourceFiles({ forceFilesystem: true, root })
      .map((file) => path.relative(root, file).replace(/\\/g, '/'))

    assert.deepEqual(relative, [
      'backend/server.js',
      'scripts/materialize-production-source.mjs',
      'src/config/env.js',
      'tests/unit/example.test.mjs',
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Docker build context retains every source-materializer input', () => {
  const dockerignore = fs.readFileSync('.dockerignore', 'utf8')
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8')

  assert.doesNotMatch(dockerignore, /^scripts\/?$/m)
  assert.doesNotMatch(dockerignore, /^tests\/?$/m)
  assert.doesNotMatch(dockerignore, /^\*\.test\.\*$/m)
  assert.match(dockerfile, /RUN node scripts\/materialize-production-source\.mjs/)
  assert.match(dockerfile, /COPY \. \./)
})
