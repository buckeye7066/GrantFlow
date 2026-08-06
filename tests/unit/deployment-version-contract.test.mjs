import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  deploymentVersionPlugin,
  resolveDeploymentCommit,
} from '../../scripts/deployment-version-plugin.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('frontend deployment receipt accepts only an exact provider commit SHA', () => {
  const sha = 'a'.repeat(40)
  assert.deepEqual(resolveDeploymentCommit({ VERCEL_GIT_COMMIT_SHA: sha }), {
    commit: sha,
    source: 'VERCEL_GIT_COMMIT_SHA',
  })
  assert.deepEqual(resolveDeploymentCommit({ VERCEL_GIT_COMMIT_SHA: 'short' }), {
    commit: null,
    source: 'unavailable_local_build',
  })
})

test('Vite emits a privacy-safe exact frontend deployment receipt', () => {
  let emitted = null
  deploymentVersionPlugin({ env: { VERCEL_GIT_COMMIT_SHA: 'b'.repeat(40) } })
    .generateBundle.call({ emitFile: (asset) => { emitted = asset } })

  assert.equal(emitted.fileName, 'assets/deployment-version.json')
  const receipt = JSON.parse(emitted.source)
  assert.deepEqual(receipt, {
    contract: 'grantflow-frontend-deployment-version-v1',
    commit: 'b'.repeat(40),
    source: 'VERCEL_GIT_COMMIT_SHA',
  })
})

test('deployment proof independently checks the frontend artifact and backend API', () => {
  const proof = fs.readFileSync(path.join(repoRoot, 'scripts/production-deployment-proof.mjs'), 'utf8')
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'))
  assert.match(proof, /Vercel frontend commit matches certified branch/)
  assert.match(proof, /Railway backend commit matches certified branch/)
  assert.match(proof, /\/deployment-version\.json/)
  assert.ok(config.rewrites.some((rule) => rule.source === '/deployment-version.json'))
  assert.ok(config.headers.some((rule) =>
    rule.source === '/deployment-version.json'
    && rule.headers?.some((header) => header.key === 'Cache-Control' && /no-store/.test(header.value))))
})
