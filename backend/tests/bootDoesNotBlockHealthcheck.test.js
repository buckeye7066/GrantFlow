/**
 * bootDoesNotBlockHealthcheck.test.js
 *
 * THE DEFECT (prod, 2026-07-16): Railway emailed "deployment crashed" for
 * deploys that were fine.
 *
 * `runEnforceInvariants` was `await`ed ~1900 lines BEFORE `app.listen()`. The
 * sweep is ~20 data-repair passes, several doing NETWORK I/O (the amount sweep
 * spends a 20s budget on grants.gov API calls; URL rescue spends 20s on web
 * searches; John's draft purge calls Microsoft Graph). All of it ran before the
 * app could answer a single request.
 *
 * Railway healthchecks `/readyz` with `healthcheckTimeout: 300`. While nothing is
 * listening the edge cannot reach the app at all, so the probe gets a 502 — not
 * the honest 503 `/readyz` itself returns — and once boot outran the deadline
 * Railway declared the deployment CRASHED and emailed the owner. Observed live:
 * `healthz=200` while `readyz=502`.
 *
 * This is a STATIC tripwire on server.js source rather than a boot harness:
 * importing server.js runs the real boot (DB, migrations, schedulers), which is
 * exactly what a unit test must not do. The ordering is the contract; assert it
 * mechanically so a future refactor cannot quietly re-block the port.
 */

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SERVER = fs.readFileSync(path.resolve(process.cwd(), 'backend', 'server.js'), 'utf8')

/** Index of the first match, or -1. */
const at = (re) => {
  const m = re.exec(SERVER)
  return m ? m.index : -1
}

describe('boot must not hold the port shut', () => {
  it('never AWAITS the invariant sweep on the boot path', () => {
    // The exact line that caused it: `await runEnforceInvariants(db, ...)` sitting
    // inline in the boot sequence. Awaiting it INSIDE the deferred wrapper is
    // correct and expected — the wrapper is what runs after listen — so the
    // contract is "every await of it is inside runBootInvariantSweep", not "it is
    // never awaited". (My first version of this test asserted the latter and
    // failed on the fix itself.)
    const wrapper = at(/const\s+runBootInvariantSweep\s*=/)
    expect(wrapper, 'the deferred wrapper must exist').toBeGreaterThan(-1)

    const awaits = [...SERVER.matchAll(/await\s+runEnforceInvariants\s*\(/g)].map((m) => m.index)
    expect(awaits.length, 'the sweep should be awaited exactly once, inside the wrapper').toBe(1)
    expect(
      awaits[0] > wrapper,
      'runEnforceInvariants is awaited on the BOOT PATH — that blocks app.listen(), Railway reads 502 on /readyz and declares the deploy crashed',
    ).toBe(true)
  })

  it('starts the sweep only AFTER the server is listening', () => {
    const listen = at(/server\s*=\s*app\.listen\s*\(/)
    const listeningHook = at(/server\.on\(\s*['"]listening['"]/)
    expect(listen, 'app.listen() not found').toBeGreaterThan(-1)
    expect(listeningHook, "no 'listening' hook found to defer the sweep onto").toBeGreaterThan(-1)
    expect(listeningHook, "the 'listening' hook must come after app.listen()").toBeGreaterThan(listen)
    // Search from the HOOK onward: the wrapper is also referenced at its
    // declaration far earlier (app.locals.runBootInvariantSweep = ...), so a
    // plain first-match would find that and prove nothing about the call site.
    const sweepCallFromHook = SERVER.indexOf('runBootInvariantSweep', listeningHook)
    expect(sweepCallFromHook, 'the sweep must be invoked from the post-listen hook').toBeGreaterThan(-1)
  })

  it('STILL runs the sweep on every boot (the guarantee is unchanged)', () => {
    // Deferring must not become skipping — CLAUDE.md's rule is that boot wires
    // the sweep directly so a self-heal schedule change cannot drop it.
    expect(/runEnforceInvariants/.test(SERVER)).toBe(true)
    expect(/runBootInvariantSweep/.test(SERVER)).toBe(true)
  })

  it('KEEPS migrations blocking listen (serving an unmigrated schema is worse)', () => {
    // The fix is surgical: repairs are deferred, schema is not. Reads against an
    // unmigrated DB would be a correctness bug, not a slow healthcheck.
    const migrate = at(/await\s+runPendingMigrationsOnBoot\s*\(/)
    const listen = at(/server\s*=\s*app\.listen\s*\(/)
    expect(migrate, 'migrations must still be awaited at boot').toBeGreaterThan(-1)
    expect(migrate).toBeLessThan(listen)
  })

  it('a deferred sweep failure is caught, never an unhandled rejection', () => {
    // An unhandled rejection in a non-awaited path can kill the process — which
    // would turn a "slow boot" into a real crash.
    expect(/sweep\(\)\s*\.catch\(/.test(SERVER) || /\.catch\(\(err\)\s*=>\s*\{\s*console\.warn\('\[enforce-invariants\] deferred/.test(SERVER)).toBe(true)
  })
})
