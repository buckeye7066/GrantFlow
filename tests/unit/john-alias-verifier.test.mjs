import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  applyEnv,
  makeFakeOutlookProvider,
  makeJohnDb,
} from './john-test-helpers.mjs'
import { verifyAlias } from '../../backend/services/john/johnAliasVerifier.js'
import { getLatestAliasCheck } from '../../backend/services/john/johnRunStore.js'

test('verifyAlias reports not-configured when MICROSOFT_* env is missing', async () => {
  const restore = applyEnv({
    JOHN_PRIMARY_MAILBOX: 'dr.johnwhite@axiombiolabs.org',
    JOHN_FROM_ALIAS: 'GrantFlow@axiombiolabs.org',
    MICROSOFT_TENANT_ID: undefined,
    MICROSOFT_CLIENT_ID: undefined,
    MICROSOFT_CLIENT_SECRET: undefined,
  })
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'not-configured' })
    const r = await verifyAlias({ db, provider })
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'provider_not_configured')
    const last = await getLatestAliasCheck(db)
    assert.ok(last)
    assert.equal(last.alias_verified, false)
    assert.equal(last.alias_send_supported, false)
  } finally {
    restore()
    db.close()
  }
})

test('verifyAlias records alias_send_supported=true when Graph accepts the From alias', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const r = await verifyAlias({ db, provider })
    assert.equal(r.ok, true)
    assert.equal(r.alias_send_supported, true)
    const last = await getLatestAliasCheck(db)
    assert.equal(last.alias_verified, true)
    assert.equal(last.alias_send_supported, true)
    assert.equal(last.from_alias, 'GrantFlow@axiombiolabs.org')
    assert.ok(last.test_draft_provider_id)
  } finally {
    restore()
    db.close()
  }
})

test('verifyAlias falls back to needs_sender_alias_review when Graph rejects the alias', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'reject' })
    const r = await verifyAlias({ db, provider })
    assert.equal(r.ok, true)
    assert.equal(r.alias_send_supported, false)
    assert.equal(r.report.needs_sender_alias_review, true)
    const last = await getLatestAliasCheck(db)
    assert.equal(last.alias_verified, true) // we did create a draft, just not with alias
    assert.equal(last.alias_send_supported, false)
  } finally {
    restore()
    db.close()
  }
})
