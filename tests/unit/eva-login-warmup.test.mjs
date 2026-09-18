import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadConfigFromFile } from 'vite'

test('cold login warms application modules, not only Vites own client', async () => {
  const loaded = await loadConfigFromFile({ command:'serve', mode:'development' })
  assert.ok(loaded, 'Vite configuration must load')
  const files = loaded.config.server?.warmup?.clientFiles || []
  assert.ok(files.includes('./index.html'), 'HTML entry must warm its application import graph')
  assert.ok(files.includes('./src/pages/Login.jsx'), 'lazy sign-in route must be warmed explicitly')
  const manifest = JSON.parse(readFileSync(new URL('../../qa/manifests/grantflow.json', import.meta.url), 'utf8'))
  assert.ok(manifest.readiness_probe.warm_paths.includes('/src/main.jsx'))
  assert.ok(manifest.readiness_probe.warm_paths.includes('/src/pages/Login.jsx'))
  const standalone = JSON.parse(readFileSync(new URL('../../qa/user-journeys.json', import.meta.url), 'utf8'))
  assert.deepEqual(standalone.readiness_probe.warm_paths, manifest.readiness_probe.warm_paths)
  const journey = manifest.journeys.find(row => row.id === 'app-identifies-itself')
  assert.deepEqual(journey.assert, [{type:'text_visible',selector:'body',value:'GrantFlow'}])
  assert.equal(manifest.readiness_probe.timeout_ms,120000)
})


test('standalone EVA preserves the migrated disposable database contract', () => {
  const canonical = JSON.parse(readFileSync(new URL('../../qa/manifests/grantflow.json', import.meta.url), 'utf8'))
  const standalone = JSON.parse(readFileSync(new URL('../../qa/user-journeys.json', import.meta.url), 'utf8'))
  assert.deepEqual(standalone.launch_env, canonical.launch_env)
  assert.equal(standalone.launch_env.MIGRATE_ON_BOOT, '1')
})
