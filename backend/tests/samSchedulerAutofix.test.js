/**
 * Unit tests for the autonomous-autofix wiring in samScheduler.js
 *
 * Proves:
 *   - without SAM_SCHEDULE_AUTOFIX the scheduled run is read-only (dryRun, no ctx,
 *     repair-safe is refused → observe)
 *   - with SAM_SCHEDULE_AUTOFIX=true the run is repair-safe, authorised,
 *     dryRun:false, and forces the heavy code/function sweep
 */

import { describe, it, expect, afterEach } from 'vitest'
import { __testing__ } from '../services/sam/samScheduler.js'

const { chooseScheduledMode, shouldAutofix, buildRunArgs } = __testing__

const SAVED = {}
const KEYS = ['SAM_SCHEDULE_AUTOFIX', 'SAM_MODE']
function set(env) {
  for (const k of KEYS) {
    SAVED[k] = process.env[k]
    if (env[k] === undefined) delete process.env[k]
    else process.env[k] = env[k]
  }
}
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED[k]
  }
})

describe('chooseScheduledMode', () => {
  it('defaults to observe', () => {
    set({})
    expect(chooseScheduledMode()).toBe('observe')
  })
  it('honours gatekeeper', () => {
    set({ SAM_MODE: 'gatekeeper' })
    expect(chooseScheduledMode()).toBe('gatekeeper')
  })
  it('refuses repair-safe without autofix → observe', () => {
    set({ SAM_MODE: 'repair-safe' })
    expect(chooseScheduledMode()).toBe('observe')
  })
  it('autofix forces repair-safe regardless of SAM_MODE', () => {
    set({ SAM_SCHEDULE_AUTOFIX: 'true', SAM_MODE: 'observe' })
    expect(shouldAutofix()).toBe(true)
    expect(chooseScheduledMode()).toBe('repair-safe')
  })
})

describe('buildRunArgs', () => {
  it('is read-only when autofix is off', () => {
    set({})
    const args = buildRunArgs({ db: {}, trigger: 'scheduled' })
    expect(args.mode).toBe('observe')
    expect(args.dryRun).toBe(true)
    expect(args.ctx).toBeNull()
    expect(args.includeHeavy).toBeUndefined()
  })

  it('authorises a heavy repair-safe sweep when autofix is on', () => {
    set({ SAM_SCHEDULE_AUTOFIX: 'true' })
    const args = buildRunArgs({ db: {}, trigger: 'scheduled' })
    expect(args.mode).toBe('repair-safe')
    expect(args.dryRun).toBe(false)
    expect(args.includeHeavy).toBe(true)
    expect(args.ctx).toMatchObject({ samAuthorised: true })
  })
})
