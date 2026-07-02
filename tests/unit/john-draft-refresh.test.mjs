/**
 * John — draft refresh service.
 *
 * Locks in that refreshing an EXISTING Outlook draft:
 *   - regenerates the current (rewritten) copy, never the old bland phrasing;
 *   - preserves the org-specific hook recovered from source_evidence_json
 *     (a regression guard: an empty lead would downgrade to the generic opener);
 *   - PATCHes Outlook in place and persists the new body;
 *   - skips drafts a human already deleted/sent (404).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { applyDefaultJohnEnv, makeJohnDb } from './john-test-helpers.mjs'
import { insertDraft, getDraft } from '../../backend/services/john/johnRunStore.js'
import { refreshDraftBodies } from '../../backend/services/john/johnDraftRefreshService.js'

function makeRefreshProvider({ fail404 = false } = {}) {
  const patches = []
  return {
    ready: true,
    notConfigured: false,
    missing: null,
    patches,
    async updateDraftBody(args) {
      if (fail404) {
        const err = new Error('not found')
        err.status = 404
        err.notFound = true
        throw err
      }
      patches.push(args)
      return { ok: true, provider_draft_id: args.messageId, is_draft: true }
    },
  }
}

async function seedDraft(db, overrides = {}) {
  const id = await insertDraft(db, {
    yana_lead_id: 'lead-scba',
    organization_name: 'Riverbend Volunteer Fire Department',
    recipient_email: 'chief@riverbendvfd.test',
    recipient_name: 'Chief Allen',
    recipient_role: 'Fire Chief',
    subject: 'Old subject',
    // The OLD bland body that the rewrite must replace.
    body_text: 'Hi Chief,\n\nI came across Riverbend while looking at organizations doing meaningful work around community-focused funding work.',
    body_html: '<p>old</p>',
    draft_status: 'created',
    provider_draft_id: 'graph-msg-1',
    personalization_json: { salutation: 'Hi Chief,', organization_name: 'Riverbend Volunteer Fire Department' },
    source_evidence_json: {
      source_urls: ['https://riverbendvfd.test/about'],
      public_evidence: [{ summary: 'replacing 25-year-old SCBA gear', source_url: 'https://riverbendvfd.test/news', specificity: 'high' }],
    },
    ...overrides,
  })
  return id
}

test('refresh rewrites the body to current copy and preserves the org-specific hook', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const id = await seedDraft(db)
    const provider = makeRefreshProvider()
    const r = await refreshDraftBodies(db, { provider })

    assert.equal(r.ok, true)
    assert.equal(r.updated, 1)
    assert.equal(provider.patches.length, 1, 'Outlook draft PATCHed once')

    const after = await getDraft(db, id)
    // Old bland phrasing is gone…
    assert.doesNotMatch(after.body_text, /work around community-focused funding work/i)
    // …replaced with the current copy, still org-specific from source evidence…
    assert.match(after.body_text, /SCBA gear/)
    assert.match(after.body_text, /Anya/)
    // …and a real person/title salutation is preserved.
    assert.match(after.body_text, /^Hi Chief,/)
  } finally {
    restore()
    db.close()
  }
})

test('refresh replaces old generic team salutations with the warm org-specific greeting', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const id = await seedDraft(db, {
      recipient_email: 'info@riverbendvfd.test',
      recipient_name: null,
      recipient_role: null,
      body_text: 'Hey Team,\n\nOld body.',
      personalization_json: { salutation: 'Hey Team,', organization_name: 'Riverbend Volunteer Fire Department' },
    })
    const provider = makeRefreshProvider()
    const r = await refreshDraftBodies(db, { provider })

    assert.equal(r.ok, true)
    assert.equal(r.updated, 1)
    assert.equal(provider.patches.length, 1, 'Outlook draft PATCHed once')

    const after = await getDraft(db, id)
    // Since the Ellie identity pass (#782/#783), a lead with NO named contact
    // gets the warm org-specific greeting — never the old bland "Hey Team,"
    // and not the cold bare "Hello," either.
    assert.match(after.body_text, /^Hello Riverbend Volunteer Fire Department team,/)
    assert.doesNotMatch(after.body_text, /^Hey Team,/i)
    assert.doesNotMatch(after.body_text, /^Hello,/)
  } finally {
    restore()
    db.close()
  }
})

test('refresh is a no-op (dry run) without persisting or patching', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const id = await seedDraft(db)
    const provider = makeRefreshProvider()
    const r = await refreshDraftBodies(db, { provider, dryRun: true })
    assert.equal(r.updated, 1)
    assert.equal(provider.patches.length, 0, 'dry run never patches Outlook')
    const after = await getDraft(db, id)
    assert.match(after.body_text, /community-focused funding work/i, 'dry run leaves the row untouched')
  } finally {
    restore()
    db.close()
  }
})

test('refresh skips a draft a human already deleted in Outlook (404)', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    await seedDraft(db)
    const provider = makeRefreshProvider({ fail404: true })
    const r = await refreshDraftBodies(db, { provider })
    assert.equal(r.updated, 0)
    assert.equal(r.skipped, 1)
    assert.equal(r.results[0].status, 'missing_in_outlook')
  } finally {
    restore()
    db.close()
  }
})
