import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))
const materializer = fs.readFileSync('scripts/materialize-production-source.mjs', 'utf8')
const linkBacklogMaterializer = fs.readFileSync(
  'scripts/source-materialization/apply-link-backlog-resolution.mjs',
  'utf8',
)

test('ordinary npm entry points materialize verified product source', () => {
  for (const name of ['prepare', 'pretest', 'prebuild', 'prestart', 'predev']) {
    assert.match(pkg.scripts[name], /materialize-production-source/)
  }
})

test('Docker and Vercel build the materialized product', () => {
  assert.match(dockerfile, /node scripts\/materialize-production-source\.mjs/)
  assert.equal(vercel.installCommand, 'npm ci --include=dev --include=optional')
  assert.equal(vercel.buildCommand, 'npm run release:gates')
})

test('one-shot scaffolding is absent and permanent generators do not ship', () => {
  assert.equal(fs.existsSync('.github/workflows/apply-global-production-hardening.yml'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-export.sh'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-diagnose.sh'), false)
  assert.match(materializer, /generator inputs retained for verification only/)
  assert.match(dockerfile, /production Docker runtime stage copies/)
  assert.equal(vercel.outputDirectory, 'dist')
})

test('link backlog lifecycle materialization is preflighted and atomic', () => {
  const preflight = linkBacklogMaterializer.indexOf(
    'for (const operation of operations) preflightOperation(operation)',
  )
  const snapshot = linkBacklogMaterializer.indexOf('const originals = new Map')
  const apply = linkBacklogMaterializer.indexOf(
    'for (const operation of operations) applyOperation(operation)',
  )

  assert.ok(preflight >= 0, 'all transformations must be preflighted')
  assert.ok(snapshot > preflight, 'file snapshots must be taken after a clean preflight')
  assert.ok(apply > snapshot, 'writes must begin only after preflight and snapshots')
  assert.match(linkBacklogMaterializer, /prerequisite missing before mutation/)
  assert.match(
    linkBacklogMaterializer,
    /for \(const \[file, original\] of originals\) write\(file, original\)/,
  )
})
