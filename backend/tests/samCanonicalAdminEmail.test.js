/**
 * Regression test for the recurring "Sam HTTP probe → 401/403 on
 * /api/admin/agent-control/* and other canonical-admin-gated routes" failure
 * mode.
 *
 * Root cause: the synthetic user that backend/server.js materialises when a
 * request authenticates with ADMIN_TOKEN / ANYA_ADMIN_TOKEN used to carry the
 * throwaway email 'admin@grantflow.app'. The Agent Control Center gate
 * (`isControlCenterAdmin`) compares `user.email` against
 *   AGENT_CONTROL_ADMIN_EMAIL || ADMIN_EMAIL || CANONICAL_ADMIN_EMAIL_DEFAULT
 * which defaults to 'buckeye7066@gmail.com'. Those two never matched, so every
 * server-internal probe (Sam, codeGuard.endpointHealth, Hamilton telemetry)
 * was rejected with 403 — surfacing as recurring HIGH "Authentication
 * required" findings on the admin Production-Readiness panel.
 *
 * The fix aligns the synthetic-admin email with the canonical-admin default
 * so the same chain `AGENT_CONTROL_ADMIN_EMAIL || ADMIN_EMAIL || CANONICAL_DEFAULT`
 * is the source of truth on both sides.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  isControlCenterAdmin,
  getCanonicalAdminEmail,
} from '../services/agentControl/agentControlOrchestrator.js'
import { CANONICAL_ADMIN_EMAIL_DEFAULT } from '../services/agentControl/agentControlTypes.js'

describe('Synthetic ADMIN_TOKEN user matches canonical-admin gate (regression)', () => {
  const SAVED = {
    AGENT_CONTROL_ADMIN_EMAIL: process.env.AGENT_CONTROL_ADMIN_EMAIL,
    ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  }

  beforeEach(() => {
    delete process.env.AGENT_CONTROL_ADMIN_EMAIL
    delete process.env.ADMIN_EMAIL
  })
  afterEach(() => {
    if (SAVED.AGENT_CONTROL_ADMIN_EMAIL !== undefined) {
      process.env.AGENT_CONTROL_ADMIN_EMAIL = SAVED.AGENT_CONTROL_ADMIN_EMAIL
    } else delete process.env.AGENT_CONTROL_ADMIN_EMAIL
    if (SAVED.ADMIN_EMAIL !== undefined) {
      process.env.ADMIN_EMAIL = SAVED.ADMIN_EMAIL
    } else delete process.env.ADMIN_EMAIL
  })

  // The canonical default is what server.js falls back to when neither override
  // is set. If this changes, every other admin-gated subsystem must change too.
  it('CANONICAL_ADMIN_EMAIL_DEFAULT is buckeye7066@gmail.com', () => {
    expect(CANONICAL_ADMIN_EMAIL_DEFAULT).toBe('buckeye7066@gmail.com')
  })

  // Mirrors the expression in backend/server.js for the synthetic admin user
  // (kept in sync deliberately — not extracted to a helper to avoid coupling
  // the auth middleware to the agent-control module at server boot).
  function syntheticAdminEmail() {
    return (
      process.env.AGENT_CONTROL_ADMIN_EMAIL ||
      process.env.ADMIN_EMAIL ||
      CANONICAL_ADMIN_EMAIL_DEFAULT
    )
  }

  it('with no overrides, the synthetic-admin email passes isControlCenterAdmin', () => {
    const synth = { role: 'admin', is_admin: true, userId: 'system_admin_token', email: syntheticAdminEmail() }
    expect(isControlCenterAdmin(synth)).toBe(true)
  })

  it('respects an AGENT_CONTROL_ADMIN_EMAIL override (operator can re-target)', () => {
    process.env.AGENT_CONTROL_ADMIN_EMAIL = 'ops@example.com'
    const synth = { role: 'admin', is_admin: true, userId: 'system_admin_token', email: syntheticAdminEmail() }
    expect(synth.email).toBe('ops@example.com')
    // The orchestrator caches its ADMIN_EMAIL at import time, so it still
    // recognises the original canonical default. We only assert the synthetic
    // email is overridable here; the orchestrator-side override is covered by
    // tests/unit/agent-control-orchestrator.test.mjs.
  })

  it('falls back to ADMIN_EMAIL when only that is set', () => {
    process.env.ADMIN_EMAIL = 'admin@example.com'
    const synth = { email: syntheticAdminEmail() }
    expect(synth.email).toBe('admin@example.com')
  })

  it('getCanonicalAdminEmail() agrees with the synthetic chain on a clean env', () => {
    // getCanonicalAdminEmail is computed at module import time; on a clean
    // env this ought to equal the canonical default (modulo case).
    expect(getCanonicalAdminEmail().toLowerCase()).toBe(CANONICAL_ADMIN_EMAIL_DEFAULT.toLowerCase())
  })
})
