// Launcher guards, 2026-08-03.
//
// Two failure classes the nightly fleet run hit for weeks, both fixed at the
// launcher choke point:
//
//   1. FREEING A PORT KILLED WHATEVER OWNED IT. On Windows, Docker Desktop
//      publishes container ports through `com.docker.backend`, so a published
//      port's owner IS Docker's backend. With the FSN compose stack up,
//      127.0.0.1:3001 and 127.0.0.1:5180 resolve to it — 3001 being the probe
//      port of three other manifests. EVA would taskkill Docker Desktop before
//      launching, and family-stewardship-navigator (whose only prerequisite is
//      a live Docker daemon) blocks later the same run.
//
//   2. A MANIFEST'S PORT IS A GUESS. sermonsmith's probe polled :3001 while the
//      app printed "SermonSmith API running on 127.0.0.1:3101"; the failure read
//      "not ready at http://localhost:3001/healthz" every night and named no
//      cause.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTECTED_PORT_HOLDERS,
  DEFAULT_KILLABLE_PROCESSES,
  normalizeProcessName,
  resolveKillableProcesses,
  mayKillProcess,
  detectAnnouncedPorts,
  detectPortDrift,
  freePort,
} from '../src/launcher.mjs'

test('a manifest cannot authorize killing shared infrastructure', () => {
  // family-stewardship-navigator's real allowlist lists com.docker.backend —
  // i.e. the manifest explicitly authorized the kill that breaks it.
  const fsn = { allowlist: { processes: ['node', 'npm', 'docker', 'com.docker.backend', 'postgres'] } }
  const killable = resolveKillableProcesses(fsn)
  assert.equal(mayKillProcess('com.docker.backend', killable), false)
  assert.equal(mayKillProcess('docker', killable), false)
  assert.equal(mayKillProcess('postgres', killable), false)
  assert.equal(mayKillProcess('node', killable), true, 'the app’s own dev server is still freeable')
  assert.equal(mayKillProcess('npm', killable), true)
})

test('freePort kills only allowlisted holders and REPORTS the ones it refuses', (t) => {
  if (process.platform !== 'win32') return t.skip('windows-only kill path')
  const killed = []
  // The real measurement: `com.docker.backend` owning FSN's published 3001.
  const holders = [
    { pid: '30516', name: 'com.docker.backend' },
    { pid: '4242', name: 'node' },
  ]
  const refused = freePort(3001, {
    killable: resolveKillableProcesses({ allowlist: { processes: ['node', 'npm', 'com.docker.backend'] } }),
    listHolders: () => holders,
    kill: (pid) => killed.push(pid),
  })
  assert.deepEqual(killed, ['4242'], 'only the node dev server is killed')
  assert.deepEqual(
    refused.map((r) => r.name),
    ['com.docker.backend'],
    'the protected holder is reported, never silently skipped',
  )
})

test('a manifest with no declared processes falls back to dev servers, never to "anything"', () => {
  const killable = resolveKillableProcesses({})
  assert.equal(mayKillProcess('node.exe', killable), true)
  assert.equal(mayKillProcess('python', killable), true)
  assert.equal(mayKillProcess('com.docker.backend', killable), false)
  assert.equal(mayKillProcess('svchost', killable), false)
  assert.equal(mayKillProcess('explorer', killable), false, 'an unknown process is NOT killable by default')
  assert.ok(DEFAULT_KILLABLE_PROCESSES.size > 0 && PROTECTED_PORT_HOLDERS.size > 0)
})

test('process names normalize across .exe and case', () => {
  assert.equal(normalizeProcessName('Node.EXE'), 'node')
  assert.equal(normalizeProcessName('  python3.exe '), 'python3')
  assert.equal(normalizeProcessName(null), '')
})

test('port drift is read from the app’s OWN output, and silence is never drift', () => {
  // Verbatim from the 2026-08-03 sermonsmith launch.
  const output = 'VITE v6.4.3 ready | Local: http://localhost:5173/ | SermonSmith API running on 127.0.0.1:3101'
  assert.deepEqual(detectPortDrift({ output, declaredPorts: [3001, 5173] }), [3101])
  assert.deepEqual(
    detectPortDrift({ output, declaredPorts: [3101, 5173] }),
    [],
    'once the manifest matches reality there is no drift left to report',
  )
  assert.deepEqual(detectPortDrift({ output: '', declaredPorts: [3001] }), [], 'an app that printed nothing is not drift')
})

test('a log timestamp is never read as a port', () => {
  const output = '[2026-08-03T15:35:41.972508100Z] event handler: request cancelled by client'
  assert.deepEqual(detectAnnouncedPorts(output), [], 'no 2-3 digit clock fragment becomes a port')
  assert.deepEqual(detectAnnouncedPorts('listening on port 8501'), [8501])
  assert.deepEqual(detectAnnouncedPorts('http://0.0.0.0:8501'), [8501])
})
