import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  deploymentVersionPlugin,
  resolveDeploymentCommit,
} from '../../scripts/deployment-version-plugin.mjs'
import { buildRepositoryReleaseIdentity } from '../../shared/releaseIdentity.js'

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

test('Vite emits matching deployment and release-identity receipts', () => {
  const commit = 'b'.repeat(40)
  const emitted = []
  deploymentVersionPlugin({
    env: { VERCEL_GIT_COMMIT_SHA: commit },
    repoRoot,
  }).generateBundle.call({
    emitFile(asset) {
      emitted.push(asset)
    },
  })

  const byName = new Map(emitted.map((asset) => [asset.fileName, asset]))
  assert.deepEqual([...byName.keys()].sort(), [
    'assets/deployment-version.json',
    'assets/release-identity.json',
  ])

  const releaseIdentity = JSON.parse(byName.get('assets/release-identity.json').source)
  const expectedIdentity = buildRepositoryReleaseIdentity({ repoRoot, commit })
  assert.deepEqual(releaseIdentity, expectedIdentity)

  const receipt = JSON.parse(byName.get('assets/deployment-version.json').source)
  assert.deepEqual(receipt, {
    contract: 'grantflow-frontend-deployment-version-v2',
    commit,
    source: 'VERCEL_GIT_COMMIT_SHA',
    release_manifest_sha256: expectedIdentity.manifest_sha256,
    evidence_artifact_sha256: expectedIdentity.evidence_artifact.sha256,
  })
})

test('deployment proof binds frontend, backend, database migrations, and evidence artifact', () => {
  const proof = fs.readFileSync(
    path.join(repoRoot, 'scripts/production-deployment-proof.mjs'),
    'utf8',
  )
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vercel.json'), 'utf8'))
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')

  assert.match(proof, /Vercel frontend release manifest matches local release/)
  assert.match(proof, /Railway backend release manifest matches Vercel/)
  assert.match(proof, /Production database migration identity matches release/)
  assert.match(proof, /Release evidence artifact hash matches/)
  assert.match(proof, /\/release-identity\.json/)
  assert.ok(config.rewrites.some((rule) => rule.source === '/deployment-version.json'))
  assert.ok(config.rewrites.some((rule) => rule.source === '/release-identity.json'))
  for (const source of ['/deployment-version.json', '/release-identity.json']) {
    assert.ok(config.headers.some((rule) =>
      rule.source === source
      && rule.headers?.some((header) =>
        header.key === 'Cache-Control' && /no-store/.test(header.value))))
  }
  assert.match(
    dockerfile,
    /docs\/production-readiness\/grantflow\.md\s+\.\/docs\/production-readiness\/grantflow\.md/,
  )
})
