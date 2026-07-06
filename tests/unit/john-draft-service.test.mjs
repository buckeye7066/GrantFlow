import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  applyEnv,
  makeFakeOutlookProvider,
  makeJohnDb,
  makeQualifiedLead,
} from './john-test-helpers.mjs'
import {
  draftEmailForLead,
  archiveDraft,
} from '../../backend/services/john/johnDraftService.js'
import {
  getDraft,
  insertAudit,
  listAudit,
  listDrafts,
  recordAliasCheck,
} from '../../backend/services/john/johnRunStore.js'
import { addSuppression } from '../../backend/services/john/johnSuppressionService.js'
import { AUDIT_STATUS, BLOCK_REASONS, DRAFT_STATUS } from '../../backend/services/john/johnTypes.js'

async function seedAliasCheck(db, supported = true) {
  await recordAliasCheck(db, {
    primary_mailbox: 'dr.johnwhite@axiombiolabs.org',
    from_alias: 'Annie@axiombiolabs.org',
    alias_verified: true,
    alias_send_supported: supported,
    test_draft_provider_id: 'tdraft-1',
  })
}

test('draftEmailForLead creates a draft and an audit row when the alias is supported', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    await seedAliasCheck(db, true)
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const lead = makeQualifiedLead({})
    const r = await draftEmailForLead({ db, lead, provider })
    assert.equal(r.ok, true)
    assert.equal(r.status, DRAFT_STATUS.CREATED)
    assert.ok(r.provider_draft_id)
    const drafts = await listDrafts(db, { limit: 50 })
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].draft_status, DRAFT_STATUS.CREATED)
    assert.equal(drafts[0].from_alias, 'Annie@axiombiolabs.org')
    assert.equal(drafts[0].fallback_used, false)

    const audit = await listAudit(db, { limit: 10 })
    assert.equal(audit.length, 1)
    assert.equal(audit[0].status, AUDIT_STATUS.DRAFT_CREATED)
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead marks the draft as needs_sender_alias_review when alias is rejected and fallback is allowed', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'reject' })
    const lead = makeQualifiedLead({ lead_id: 'lead-fallback' })
    const r = await draftEmailForLead({ db, lead, provider })
    assert.equal(r.ok, true)
    assert.equal(r.status, DRAFT_STATUS.NEEDS_SENDER_ALIAS_REVIEW)
    assert.equal(r.alias_report.fallback_used, true)
    assert.equal(r.alias_report.needs_sender_alias_review, true)
    assert.equal(r.alias_report.alias_send_supported, false)

    const drafts = await listDrafts(db, { limit: 5 })
    assert.equal(drafts[0].draft_status, DRAFT_STATUS.NEEDS_SENDER_ALIAS_REVIEW)
    assert.equal(drafts[0].fallback_used, true)
    assert.equal(drafts[0].from_alias, null)
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead refuses suppressed recipients and records draft_blocked', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    await addSuppression(db, { type: 'email', value: 'chief@riverbendvfd.test', reason: 'admin' })
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const lead = makeQualifiedLead({})
    const r = await draftEmailForLead({ db, lead, provider })
    assert.equal(r.ok, false)
    assert.equal(r.status, DRAFT_STATUS.BLOCKED)
    assert.ok(r.blocked_reasons.includes(BLOCK_REASONS.SUPPRESSED_EMAIL))
    assert.equal(provider.calls.length, 0, 'Outlook provider must not be called for blocked drafts')

    const audit = await listAudit(db, { limit: 5 })
    assert.equal(audit[0].status, AUDIT_STATUS.DRAFT_BLOCKED)
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead refuses leads without public evidence', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const lead = makeQualifiedLead({ public_evidence: [] })
    const r = await draftEmailForLead({ db, lead, provider })
    assert.equal(r.ok, false)
    assert.equal(r.status, DRAFT_STATUS.BLOCKED)
    assert.ok(r.blocked_reasons.includes(BLOCK_REASONS.MISSING_PUBLIC_EVIDENCE))
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead refuses when the contact source is missing', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const lead = makeQualifiedLead({ source_urls: [] })
    const r = await draftEmailForLead({ db, lead, provider })
    assert.equal(r.ok, false)
    assert.ok(r.blocked_reasons.includes(BLOCK_REASONS.MISSING_CONTACT_SOURCE))
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead never sends — no `send` method exists on the provider used by draft service', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    assert.equal(typeof provider.send, 'undefined', 'fake provider should not expose a send method')
    const lead = makeQualifiedLead({})
    await draftEmailForLead({ db, lead, provider })
    // Make sure the only provider method called was createDraft.
    for (const call of provider.calls) {
      assert.ok(call.toEmail, 'createDraft was called with a recipient')
    }
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead refuses to draft twice for the same Yana lead', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const lead = makeQualifiedLead({ lead_id: 'lead-dedup-1' })
    const first = await draftEmailForLead({ db, lead, provider })
    assert.equal(first.ok, true)
    const second = await draftEmailForLead({ db, lead, provider })
    assert.equal(second.ok, false)
    assert.ok(second.blocked_reasons.includes(BLOCK_REASONS.ALREADY_DRAFTED))
    assert.equal(provider.calls.length, 1, 'second attempt must not hit the provider')
  } finally {
    restore()
    db.close()
  }
})

test('draftEmailForLead blocks when provider is not configured', async () => {
  const restore = applyEnv({
    JOHN_DRAFT_ONLY: 'true',
    MICROSOFT_TENANT_ID: undefined,
    MICROSOFT_CLIENT_ID: undefined,
    MICROSOFT_CLIENT_SECRET: undefined,
    JOHN_PHYSICAL_ADDRESS: '123 Mission Way',
  })
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'not-configured' })
    const lead = makeQualifiedLead({})
    const r = await draftEmailForLead({ db, lead, provider })
    assert.equal(r.ok, false)
    assert.ok(r.blocked_reasons.includes(BLOCK_REASONS.PROVIDER_NOT_CONFIGURED))
  } finally {
    restore()
    db.close()
  }
})

test('archiveDraft sets the draft to archived', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const lead = makeQualifiedLead({})
    const r = await draftEmailForLead({ db, lead, provider })
    await archiveDraft(db, r.draft_id, 'manual')
    const updated = await getDraft(db, r.draft_id)
    assert.equal(updated.draft_status, DRAFT_STATUS.ARCHIVED)
  } finally {
    restore()
    db.close()
  }
})

test('John records a blocked-audit row for every blocked draft', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    await draftEmailForLead({
      db,
      lead: makeQualifiedLead({ lead_score: 10 }),
      provider,
    })
    const audit = await listAudit(db, { limit: 10 })
    assert.ok(audit.length >= 1)
    assert.equal(audit[0].status, AUDIT_STATUS.DRAFT_BLOCKED)
    assert.ok(Array.isArray(audit[0].safety_report_json?.reasons))
  } finally {
    restore()
    db.close()
  }
})

test('audit insertion records the John agent name', async () => {
  const db = makeJohnDb()
  try {
    await insertAudit(db, { status: AUDIT_STATUS.REVIEWED })
    const audit = await listAudit(db, { limit: 5 })
    assert.equal(audit[0].agent_name, 'John')
  } finally {
    db.close()
  }
})
