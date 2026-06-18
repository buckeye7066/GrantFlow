/**
 * Sam admin-tool invocation auth (regression for the audit fix).
 *
 * Sam's production-readiness run invokes admin tools (admin.health.check,
 * admin.code.scan, admin.codeGuard.*, …) through anyaOrchestrator.invokeTool.
 * That path runs assertAuthenticated(user) — which requires a non-null userId —
 * before delegating to anyaToolRegistry, which authorises on ctx.isAdmin.
 *
 * The bug: samAgentAdapter passed ctx { isAdmin: true, userId: null }, so every
 * admin tool 401'd and Sam reported ~16 "Tool invocation failed" findings.
 *
 * The fix: Sam runs as an explicit internal admin principal (non-null synthetic
 * userId + isAdmin). These tests pin both halves: a null userId is still
 * rejected (auth is real), and Sam's principal is accepted and the tool runs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { wrapSqlite } from '../helpers/sqliteTestDb.mjs'

// Importing the orchestrator registers the Anya tools as a side effect.
import { invokeTool } from '../../backend/services/anyaOrchestrator.js'

// Mirrors SAM_ADMIN_CTX in samAgentAdapter.js — the internal admin principal.
const SAM_ADMIN_CTX = {
  isAdmin: true,
  is_admin: true,
  role: 'admin',
  userId: 'agent:sam',
  id: 'agent:sam',
  email: 'buckeye7066@gmail.com',
}

function makeDb() {
  return wrapSqlite(new Database(':memory:'))
}

test('the original bug: a null-userId ctx is rejected with 401 (auth is real)', async () => {
  await assert.rejects(
    invokeTool(null, { isAdmin: true, userId: null }, 'admin.code.scan', {}, {}),
    (err) => err?.status === 401,
    'a principal without a userId must not be able to invoke admin tools',
  )
})

test('Sam internal admin principal passes auth and runs an admin tool (no 401/403)', async () => {
  const db = makeDb()
  let result
  try {
    result = await invokeTool(
      db,
      SAM_ADMIN_CTX,
      'admin.code.scan',
      { directory: 'backend/services/sam', issueTypes: ['todo'] },
      {},
    )
  } catch (err) {
    // The tool must not fail on authentication/authorisation. A genuine
    // runtime error from the scanner would be a different (non-401/403) status.
    assert.notEqual(err?.status, 401, `admin tool 401'd for Sam: ${err?.message}`)
    assert.notEqual(err?.status, 403, `admin tool 403'd for Sam: ${err?.message}`)
    throw err
  }
  assert.ok(result, 'admin.code.scan returned a result envelope for Sam')
})

test('a non-admin principal is rejected with 403 by the admin gate', async () => {
  const db = makeDb()
  await assert.rejects(
    invokeTool(db, { isAdmin: false, userId: 'someone' }, 'admin.code.scan', {}, {}),
    (err) => err?.status === 403,
    'admin tools must reject a non-admin principal',
  )
})
