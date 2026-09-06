import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'
import { inferExecutableRequirements } from '../src/prereq.mjs'

const directory = new URL('../../../qa/manifests/', import.meta.url)
const read = (name) => JSON.parse(readFileSync(new URL(name, directory), 'utf8'))
const manifest = read('kidney-antigen-discovery.json')

test('Kidney prepares its owned Python environment and never requires global Uvicorn', () => {
  assert.match(manifest.start_command, /cd backend && python eva_start\.py --install --port 45105/)
  assert.doesNotMatch(manifest.start_command, /&& uvicorn\b/)
  const required = inferExecutableRequirements(manifest).map((item) => item.command)
  assert.ok(required.includes('python'))
  assert.ok(!required.includes('uvicorn'))
  assert.equal(manifest.launch_env.KAD_DB_PATH, '.eva-tmp/kidney-antigen-discovery/runs.db')
  assert.equal(manifest.launch_env.KAD_UPLOAD_DIR, '.eva-tmp/kidney-antigen-discovery/uploads')
  assert.equal(manifest.launch_env.KAD_OUTPUT_DIR, '.eva-tmp/kidney-antigen-discovery/outputs')
})

test('Kidney probes backend readiness and its UI uses the same isolated API', () => {
  assert.equal(manifest.readiness_probe.path, '/api/readyz')
  assert.equal(manifest.readiness_probe.port, 45105)
  assert.equal(manifest.launch_env.BACKEND_URL, 'http://127.0.0.1:45105')
  assert.equal(manifest.base_url, 'http://127.0.0.1:45205')
  assert.match(manifest.start_command, /npm run dev -- --hostname 127\.0\.0\.1 --port 45205/)
  assert.ok(manifest.readiness_probe.warm_paths.includes('/'))
  assert.ok(manifest.readiness_probe.timeout_ms < manifest.max_runtime_ms)
  for (const name of readdirSync(directory).filter((name) => name.endsWith('.json') && name !== 'kidney-antigen-discovery.json')) {
    const other = read(name)
    const ports = new Set([other.readiness_probe?.port, Number(new URL(other.base_url || 'http://localhost').port), ...(other.allowlist?.ports || [])])
    assert.ok(!ports.has(45105) && !ports.has(45205), `Kidney must not collide with ${name}`)
  }
})

test('the nightly backend-health journey executes assertions supported by the browser adapter', () => {
  const journey = manifest.journeys.find((item) => item.id === 'backend-health')
  assert.equal(manifest.runtime_type, 'web')
  assert.ok(manifest.nightly_critical_journeys.includes(journey.id))
  assert.equal(journey.command, undefined, 'CLI-only fields are not executed by the web adapter')
  assert.ok(journey.steps.some((step) => step.action === 'goto' && step.url === '/api/readyz'))
  const expected = journey.assert.filter((item) => item.type === 'text_visible').map((item) => item.value)
  for (const value of ['Kidney Antigen Discovery Pipeline', 'research_only', 'writable']) assert.ok(expected.includes(value))
  assert.ok(manifest.allowlist.routes.includes('/api/readyz'))
})
