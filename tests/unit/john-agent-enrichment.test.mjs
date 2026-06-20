/**
 * John — orchestrator behaviour when a lead is too thin to personalize.
 *
 * John should ask Yana for enrichment and defer drafting (giving her a cycle to
 * respond), but never stall forever: past the deferral cap he drafts the best
 * available version.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  applyEnv,
  makeFakeOutlookProvider,
  makeJohnDb,
  makeQualifiedLead,
} from './john-test-helpers.mjs'
import { runJohn } from '../../backend/services/john/johnAgent.js'
import { listDrafts } from '../../backend/services/john/johnRunStore.js'
import { JOHN_MODES } from '../../backend/services/john/johnTypes.js'

// A lead that PASSES the bridge filter (qualified, scored, has evidence + source
// + email) but is too generic to personalize — only a contact evidence item,
// no mission / focus / program / excerpt / usable hook.
function makeThinLead(overrides = {}) {
  return makeQualifiedLead({
    organization_name: 'Jsl Education Foundation',
    public_evidence: [{ type: 'contact', name: null, email: 'info@jsl.test' }],
    contact_points: [{ type: 'email', value: 'info@jsl.test', confidence: 0.7 }],
    ...overrides,
  })
}

function makeTrackingSource(leads) {
  const requests = new Map()
  return {
    name: 'fake',
    requests,
    async listQualifiedLeads() { return leads },
    async markQueuedForReview() { return { ok: true } },
    async requestEnrichment({ leadId, missing, note }) {
      const prev = requests.get(leadId)
      const attempts = (prev?.attempts || 0) + 1
      requests.set(leadId, { attempts, missing, note })
      return { ok: true, supported: true, id: leadId, attempts, created: !prev }
    },
    async getEnrichmentRequest({ leadId }) {
      const r = requests.get(leadId)
      return r ? { candidate_id: leadId, attempts: r.attempts } : null
    },
  }
}

test('runJohn defers a thin lead and files an enrichment request with Yana', async () => {
  const restore = applyDefaultJohnEnv() // JOHN_MAX_ENRICHMENT_DEFERRALS defaults to 1
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const source = makeTrackingSource([makeThinLead({ lead_id: 'thin-1' })])
    const r = await runJohn({ db, mode: JOHN_MODES.DRAFT, provider, leadSource: source })

    assert.equal(r.enrichment_requested, 1)
    assert.equal(r.deferred_for_enrichment, 1)
    assert.equal(r.drafts_created, 0)
    assert.equal(provider.calls.length, 0, 'a deferred lead is never drafted into Outlook')
    assert.equal(source.requests.get('thin-1').attempts, 1)
    assert.equal((await listDrafts(db, { limit: 10 })).length, 0)
  } finally {
    restore()
    db.close()
  }
})

test('past the deferral cap, John drafts the best available version anyway', async () => {
  const restore = applyEnv({
    ...envBase(),
    JOHN_MAX_ENRICHMENT_DEFERRALS: '0', // never defer — draft immediately
  })
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    const source = makeTrackingSource([makeThinLead({ lead_id: 'thin-2' })])
    const r = await runJohn({ db, mode: JOHN_MODES.DRAFT, provider, leadSource: source })

    assert.equal(r.enrichment_requested, 1, 'Yana is still told the lead was thin')
    assert.equal(r.deferred_for_enrichment, 0)
    assert.equal(r.drafts_created, 1)
    assert.equal(provider.calls.length, 1)
  } finally {
    restore()
    db.close()
  }
})

test('a lead with real evidence is drafted immediately, no enrichment request', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })
    // Default makeQualifiedLead has a substantive free-text hook.
    const source = makeTrackingSource([makeQualifiedLead({ lead_id: 'rich-1' })])
    const r = await runJohn({ db, mode: JOHN_MODES.DRAFT, provider, leadSource: source })

    assert.equal(r.enrichment_requested, 0)
    assert.equal(r.deferred_for_enrichment, 0)
    assert.equal(r.drafts_created, 1)
    assert.equal(source.requests.size, 0)
  } finally {
    restore()
    db.close()
  }
})

// The default JOHN env (mirrors applyDefaultJohnEnv) minus the deferral knob so
// the second test can override it cleanly.
function envBase() {
  return {
    JOHN_ENABLED: 'true',
    JOHN_DRAFT_ONLY: 'true',
    JOHN_ALLOW_SEND: 'false',
    JOHN_REQUIRE_HUMAN_REVIEW: 'true',
    JOHN_MAX_DRAFTS_PER_24H: '50',
    JOHN_MAX_DRAFTS_PER_RUN: '50',
    JOHN_MAX_DRAFTS_PER_HOUR: '10',
    JOHN_MIN_LEAD_SCORE: '70',
    JOHN_REQUIRE_YANA_QUALIFIED: 'true',
    JOHN_REQUIRE_PUBLIC_EVIDENCE: 'true',
    JOHN_REQUIRE_CONTACT_SOURCE: 'true',
    JOHN_SUPPRESSION_ENABLED: 'true',
    JOHN_OPT_OUT_LANGUAGE_REQUIRED: 'true',
    JOHN_PHYSICAL_ADDRESS_REQUIRED: 'true',
    JOHN_PHYSICAL_ADDRESS: '123 Mission Way, Anywhere, USA',
    JOHN_AI_DRAFTING: 'off',
    JOHN_PROSPECT_LINK: 'https://app.axiombiolabs.org/start',
    JOHN_PRIMARY_MAILBOX: 'dr.johnwhite@axiombiolabs.org',
    JOHN_FROM_ALIAS: 'GrantFlow@axiombiolabs.org',
    JOHN_REPLY_TO: 'GrantFlow@axiombiolabs.org',
    JOHN_DISPLAY_NAME: 'Dr. John White | GrantFlow',
    JOHN_ALLOW_PRIMARY_MAILBOX_FALLBACK_DRAFTS: 'true',
    JOHN_REQUIRE_ALIAS_REVIEW_IF_FALLBACK: 'true',
    MICROSOFT_TENANT_ID: 'tenant-123',
    MICROSOFT_CLIENT_ID: 'client-123',
    MICROSOFT_CLIENT_SECRET: 'secret-***',
  }
}
