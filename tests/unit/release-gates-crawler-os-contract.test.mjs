import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const releaseGates = fs.readFileSync('scripts/release-gates.mjs', 'utf8')
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const ciWorkflow = fs.readFileSync('.github/workflows/ci.yml', 'utf8')

test('release gates fail closed outside the verified Node 20 runtime', () => {
  assert.match(releaseGates, /const REQUIRED_NODE_VERSION = '20\.20\.2'/)
  assert.match(releaseGates, /process\.versions\.node !== REQUIRED_NODE_VERSION/)
  assert.match(releaseGates, /assertNode20Runtime\(\)/)
})

test('package exposes authoritative Crawler OS lint and test commands', () => {
  assert.equal(typeof packageJson.scripts?.['crawler-os:lint'], 'string')
  assert.equal(typeof packageJson.scripts?.['crawler-os:test'], 'string')
})

test('release gates run Crawler OS lint as a blocking step', () => {
  assert.match(releaseGates, /\['run', 'crawler-os:lint'\]/)
  assert.match(releaseGates, /label: 'crawler-os-lint'/)
})

test('release gates run the authoritative Crawler OS suite as a blocking isolated step', () => {
  assert.match(releaseGates, /\['run', 'crawler-os:test'\]/)
  assert.match(releaseGates, /label: 'crawler-os-test'/)
  assert.match(releaseGates, /label: 'crawler-os-test',[\s\S]*?isolatedTest: true/)
})

test('Vercel release builds serialize Vitest files to avoid worker teardown races', () => {
  const isolatedVitestRunner = fs.readFileSync('scripts/run-vitest-isolated.mjs', 'utf8')
  assert.match(isolatedVitestRunner, /process\.env\.VERCEL === '1'/)
  assert.match(isolatedVitestRunner, /--no-file-parallelism/)
})

test('Vercel release builds use SPA production build instead of full npm test matrix', () => {
  // Production Vercel deploys were failing Gate 1 with OTP login 503s under the
  // build sandbox. GitHub CI remains the full-matrix authority.
  assert.match(releaseGates, /process\.env\.VERCEL === '1'/)
  assert.match(releaseGates, /\['run', 'build'\]/)
  assert.match(releaseGates, /full npm test matrix is owned by GitHub CI/)
  assert.match(releaseGates, /remaining release gates are owned by GitHub CI/)
  assert.match(releaseGates, /await run\(npmBin\(\), \['test'\], \{ label: 'quality\+build' \}\)/)
})

test('GitHub CI invokes the release gates with a read-only non-persistent token', () => {
  assert.match(ciWorkflow, /permissions:\s*\n\s+contents: read/)
  assert.match(ciWorkflow, /run: npm run release:gates/)
  const checkoutCount = (ciWorkflow.match(/uses: actions\/checkout@/g) || []).length
  const nonPersistentCount = (ciWorkflow.match(/persist-credentials: false/g) || []).length
  assert.ok(checkoutCount > 0)
  assert.equal(nonPersistentCount, checkoutCount)
})
