/**
 * Guards the maintenance-window gate for the nightly sweep.
 *
 * The 04:00 ET sweep is read-only (observe Sam) + an idempotent, live-safe
 * self-heal, so it must NOT take the whole app DOWN by default. The window is
 * opt-in via NIGHTLY_MAINTENANCE_USE_WINDOW=true (for when destructive fixes are
 * re-enabled).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { isNightlyMaintenanceWindowEnabled } from '../services/maintenance/nightlySweep.js'

describe('isNightlyMaintenanceWindowEnabled', () => {
  const prev = process.env.NIGHTLY_MAINTENANCE_USE_WINDOW
  afterEach(() => {
    if (prev === undefined) delete process.env.NIGHTLY_MAINTENANCE_USE_WINDOW
    else process.env.NIGHTLY_MAINTENANCE_USE_WINDOW = prev
  })

  it('is OFF by default (no nightly downtime)', () => {
    delete process.env.NIGHTLY_MAINTENANCE_USE_WINDOW
    expect(isNightlyMaintenanceWindowEnabled()).toBe(false)
  })

  it('is OFF for any non-true value', () => {
    process.env.NIGHTLY_MAINTENANCE_USE_WINDOW = 'false'
    expect(isNightlyMaintenanceWindowEnabled()).toBe(false)
    process.env.NIGHTLY_MAINTENANCE_USE_WINDOW = '0'
    expect(isNightlyMaintenanceWindowEnabled()).toBe(false)
  })

  it('is ON only when explicitly set to true', () => {
    process.env.NIGHTLY_MAINTENANCE_USE_WINDOW = 'true'
    expect(isNightlyMaintenanceWindowEnabled()).toBe(true)
    process.env.NIGHTLY_MAINTENANCE_USE_WINDOW = 'TRUE'
    expect(isNightlyMaintenanceWindowEnabled()).toBe(true)
  })
})
