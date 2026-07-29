import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))
const materializer = fs.readFileSync('scripts/materialize-production-source.mjs', 'utf8')

test('ordinary npm entry points materialize verified product source', () => {
  for (const name of ['prepare', 'pretest', 'prebuild', 'prestart', 'predev']) assert.match(pkg.scripts[name], /materialize-production-source/)
})
test('Docker and Vercel build the materialized product', () => {
  assert.match(dockerfile, /node scripts\/materialize-production-source\.mjs/)
  assert.equal(vercel.installCommand, 'npm ci --include=dev --include=optional')
  assert.equal(vercel.buildCommand, 'npm run release:gates')
})
test('one-shot apply and export scaffolding is absent', () => {
  assert.equal(fs.existsSync('.github/workflows/apply-global-production-hardening.yml'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-export.sh'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-diagnose.sh'), false)
  assert.match(materializer, /generator inputs removed/)
})
