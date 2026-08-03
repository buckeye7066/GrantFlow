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

// ── Warm-path readiness (the FSN Vite-reload race, 2026-08-03) ──────────────
// "Answers" ≠ "can serve the app": FSN's recreated web container serves "/"
// seconds after start, readiness went green, then Vite reloaded for dependency
// re-optimization and dropped the journeys' module requests
// (ERR_EMPTY_RESPONSE on /src/pages/Login.jsx). waitForWarmPath requires an
// OK, NON-EMPTY body on consecutive polls, so a cold or flapping transform
// pipeline is not "ready".
import http from 'node:http'
import { waitForWarmPath } from '../src/launcher.mjs'

function serveScript(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => {
      resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/@vite/client` })
    })
  })
}

test('warm path passes only after consecutive stable non-empty responses', async () => {
  let hits = 0
  const { srv, url } = await serveScript((req, res) => {
    hits += 1
    if (hits <= 2) {
      // Cold/reloading Vite: connection answers but the module body is empty
      // (the ERR_EMPTY_RESPONSE class).
      res.writeHead(200)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end('export {}\n')
  })
  try {
    const warm = await waitForWarmPath(url, { timeoutMs: 15000, intervalMs: 50, consecutive: 2 })
    assert.equal(warm, true)
    assert.ok(hits >= 4, `needs 2 consecutive good bodies after the cold ones (hits=${hits})`)
  } finally {
    srv.close()
  }
})

test('a flapping server (reload loop) never reads as warm', async () => {
  let hits = 0
  const { srv, url } = await serveScript((req, res) => {
    hits += 1
    if (hits % 2 === 1) {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end('export {}\n')
      return
    }
    res.writeHead(200)
    res.end() // every second response drops the body — a reload mid-flight
  })
  try {
    const warm = await waitForWarmPath(url, { timeoutMs: 900, intervalMs: 50, consecutive: 2 })
    assert.equal(warm, false, 'alternating good/empty must never satisfy consecutive=2')
  } finally {
    srv.close()
  }
})

test('a dead start_command aborts the warm wait instead of burning the timeout', async () => {
  const { srv, url } = await serveScript((req, res) => { res.writeHead(200); res.end('x') })
  try {
    const warm = await waitForWarmPath(url, { timeoutMs: 5000, intervalMs: 50, consecutive: 3, isDead: () => true })
    assert.equal(warm, false)
  } finally {
    srv.close()
  }
})
