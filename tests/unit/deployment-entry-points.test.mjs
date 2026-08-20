import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const dockerfile = fs.readFileSync('Dockerfile', 'utf8')
const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'))

/**
 * Expand `npm run <name>` through package.json scripts until no further
 * `npm run` reference remains, so an assertion about what a command DOES
 * survives the command being renamed or wrapped.
 */
function resolveNpmScript(pkgJson, command, seen = new Set()) {
  let out = command
  for (let depth = 0; depth < 10; depth += 1) {
    const next = out.replace(/npm run ([\w:-]+)/g, (whole, name) => {
      if (seen.has(name)) return whole
      const body = pkgJson.scripts?.[name]
      if (body === undefined) return whole
      seen.add(name)
      return body
    })
    if (next === out) break
    out = next
  }
  return out
}

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
  assert.equal(vercel.outputDirectory, 'dist')

  // The invariant is that a Vercel deploy REACHES THE AUTHORITATIVE RELEASE
  // GATES -- not that buildCommand holds one particular literal. The literal
  // equality rejected EVERY change indiscriminately, including a strict
  // SUPERSET of itself (`build:deploy` = `release:gates &&
  // build-mobile-bundle`), so the only way past it was to edit the assertion --
  // which is how a guard gets loosened by whoever is in a hurry. Resolving the
  // script chain states what actually matters, so a correct superset passes
  // untouched while any command that does not reach the gates still fails.
  assert.match(vercel.buildCommand, /^npm run [\w:-]+$/)
  assert.match(resolveNpmScript(pkg, vercel.buildCommand), /release-gates\.mjs/)
})

test('one-shot scaffolding is absent and permanent generators do not ship', () => {
  assert.equal(fs.existsSync('.github/workflows/apply-global-production-hardening.yml'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-export.sh'), false)
  assert.equal(fs.existsSync('scripts/vercel-hardening-diagnose.sh'), false)
})
