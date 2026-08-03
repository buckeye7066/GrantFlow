import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))

test('the source-materialization patch stack stays removed', () => {
  // The signature-driven patch system (scripts/source-materialization/*) was
  // retired 2026-08-03: the patched state is ordinary committed source, and no
  // npm lifecycle may rewrite tracked product files again. A reintroduction of
  // a prepare/pre* hook that mutates source is the regression this guards.
  assert.equal(fs.existsSync('scripts/materialize-production-source.mjs'), false)
  assert.equal(fs.existsSync('scripts/source-materialization'), false)
  for (const name of ['prepare', 'pretest', 'prebuild', 'prestart', 'predev', 'preunit', 'prebackend']) {
    const value = pkg.scripts[name]
    if (value !== undefined) {
      assert.doesNotMatch(value, /materialize/, `${name} must not invoke a source materializer`)
    }
  }
})

test('Docker and Vercel build the committed product tree', () => {
  assert.doesNotMatch(dockerfile, /materialize-production-source/)
  assert.match(dockerfile, /COPY \. \./)
  assert.match(dockerfile, /RUN npm run build/)
  assert.equal(vercel.installCommand, 'npm ci --include=dev --include=optional')
  assert.equal(vercel.buildCommand, 'npm run release:gates')
  assert.equal(vercel.outputDirectory, 'dist')
})

test('one-shot scaffolding is absent and permanent generators do not ship', () => {
  assert.equal(fs.existsSync('.github/workflows/apply-global-production-hardening.yml'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-export.sh'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-diagnose.sh'), false)
})
