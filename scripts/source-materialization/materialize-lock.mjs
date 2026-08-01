// Cross-process mutex for source materialization.
//
// WHY THIS EXISTS: every `npm run dev`, `npm run backend`, `npm run build` and
// `npm run unit` fires `scripts/materialize-production-source.mjs` from an npm
// pre-hook. `npm run dev:full` runs `concurrently "npm run backend" "npm run dev"`,
// so TWO materializers read-modify-write the SAME product source files at the
// same time. Each individual module is idempotent, but `readFileSync` →
// string-replace → `writeFileSync` is not atomic: one process can read a file
// the other is mid-write, see a truncated/partly-patched buffer, and die with
// `<anchor> missing or ambiguous`. When that kills the `prebackend` hook the
// backend never boots; when it kills `predev` Vite never boots — which is
// exactly how EVA saw GrantFlow "not ready at http://localhost:5173"
// intermittently (measured 2026-08-01: ~1 launch in 5 failed, 1 concurrent
// materializer pair in 6 crashed).
//
// The lock is a directory (mkdir is atomic on every platform we run on) in the
// OS temp dir, keyed by the repo root so worktrees never block each other. It is
// stale-broken so a killed holder can never wedge a developer's `npm run dev`.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

export const MATERIALIZE_LOCK_STALE_MS = 120_000
export const MATERIALIZE_LOCK_TIMEOUT_MS = 180_000

/** Lock directory for a repo root. Distinct roots (worktrees) get distinct locks. */
export function materializeLockPath(repoRoot = process.cwd(), tmpDir = os.tmpdir()) {
  const key = crypto.createHash('sha1').update(path.resolve(repoRoot).toLowerCase()).digest('hex').slice(0, 16)
  return path.join(tmpDir, `grantflow-materialize-${key}.lock`)
}

function sleepSync(ms) {
  // A blocking sleep without a dependency: the script body is synchronous around
  // the lock, and Atomics.wait is the only portable sync sleep in Node.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockAgeMs(lockPath, now) {
  try {
    return now() - fs.statSync(lockPath).mtimeMs
  } catch {
    // Vanished between the failed mkdir and the stat — treat as fresh and retry.
    return 0
  }
}

/** Best-effort removal. Never throws: a lock we cannot break is handled by the deadline. */
export function releaseMaterializeLock(lockPath) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true })
  } catch {
    /* another process may have released it first */
  }
}

/**
 * Block until this process owns the materialization lock.
 * Returns `{ lockPath, waited, release }`. Throws only when the lock could not
 * be obtained within `timeoutMs` — never silently proceeds unserialized,
 * because proceeding unserialized IS the bug.
 */
export function acquireMaterializeLockSync({
  repoRoot = process.cwd(),
  tmpDir = os.tmpdir(),
  timeoutMs = MATERIALIZE_LOCK_TIMEOUT_MS,
  staleMs = MATERIALIZE_LOCK_STALE_MS,
  pollMs = 100,
  now = () => Date.now(),
  sleep = sleepSync,
} = {}) {
  const lockPath = materializeLockPath(repoRoot, tmpDir)
  const deadline = now() + timeoutMs
  let waited = false
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { recursive: false })
      try {
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } catch {
        /* diagnostics only */
      }
      return { lockPath, waited, release: () => releaseMaterializeLock(lockPath) }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
    if (lockAgeMs(lockPath, now) > staleMs) releaseMaterializeLock(lockPath)
    if (now() >= deadline) {
      throw new Error(
        `[source-materialization] timed out after ${timeoutMs}ms waiting for the materialization lock at ${lockPath}. ` +
          'Another materializer is running or wedged; remove that directory to clear it.',
      )
    }
    waited = true
    sleep(pollMs)
  }
}

/** Acquire the lock and register release on process exit/signals. */
export function acquireMaterializeLockForProcess(options = {}) {
  const held = acquireMaterializeLockSync(options)
  const release = () => releaseMaterializeLock(held.lockPath)
  process.on('exit', release)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      release()
      process.exit(130)
    })
  }
  return held
}
