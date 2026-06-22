/**
 * Yana → John handoff (DRAFT-ONLY model, owner-authoritative).
 *
 * Proves the canonical pipeline end-to-end with NO network and NO send:
 *   1. Yana DISCOVERS + qualifies leads from organization records
 *      (yanaLeadDiscovery — deterministic, DB-only).
 *   2. The qualified candidates feed John via the real Yana lead source
 *      (makeYanaLeadSource).
 *   3. John DRAFTS outreach and SAVES it to the (mocked) Outlook DRAFT folder
 *      via createDraft — never a send. No send flag is required anywhere.
 *
 * The key assertions encode the corrected model:
 *   - Yana never sends; she only finds leads + hands drafts to John.
 *   - John saves to drafts (createDraft is the only provider method touched;
 *     the provider exposes no send method at all).
 *   - Discovery + drafting run to completion WITHOUT setting any "send" flag.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyDefaultJohnEnv,
  makeFakeOutlookProvider,
  makeJohnDb,
} from './john-test-helpers.mjs'
import {
  discoverLeadCandidates,
  makeYanaLeadSource,
} from '../../backend/services/yana/yanaLeadDiscovery.js'
import { runJohn } from '../../backend/services/john/johnAgent.js'
import { listDrafts } from '../../backend/services/john/johnRunStore.js'
import { JOHN_MODES, RUN_STATUS, DRAFT_STATUS } from '../../backend/services/john/johnTypes.js'

// A loader that hands Yana a strong, qualifiable organization (mission +
// program areas + org email + website + EIN clears the lead-score threshold).
function loadOneQualifiableOrg() {
  return async () => [
    {
      id: 'org-1',
      profile_id: 'profile-1',
      name: 'Riverbend Volunteer Fire Department',
      organization_type: 'volunteer_fire_department',
      applicant_type: 'volunteer_fire_department',
      email: 'chief@riverbendvfd.test',
      website: 'https://riverbendvfd.test',
      mission: 'Protecting Riverbend with volunteer firefighters and rescue services for 40 years.',
      focus_areas: ['fire safety', 'emergency response'],
      program_areas: ['SCBA replacement', 'station expansion'],
      ein: '123456789',
      city: 'Riverbend',
      state: 'OH',
      contact_name: 'Chief Allen',
      contact_title: 'Fire Chief',
    },
  ]
}

test('Yana discovers + John drafts to the Outlook DRAFT folder, with NO send flag and NO real send', async () => {
  const restore = applyDefaultJohnEnv()
  const db = makeJohnDb()
  try {
    // 1. Yana discovery — deterministic, DB-only. Creates yana_lead_candidates
    //    via its own ensureSchema; no network, no send.
    const disc = await discoverLeadCandidates(db, {
      limit: 50,
      runId: 'run-1',
      loadOrganizations: loadOneQualifiableOrg(),
    })
    assert.equal(disc.candidates_total, 1, 'Yana should have evaluated one org')
    assert.equal(disc.candidates_qualified, 1, 'the org should qualify for outreach')

    // 2. John consumes Yana's qualified leads via the REAL Yana lead source.
    const yanaSource = makeYanaLeadSource(db)
    const provider = makeFakeOutlookProvider({ aliasMode: 'accept' })

    // Sanity: this DRAFT-ONLY pipeline must never have a send capability.
    assert.equal(typeof provider.send, 'undefined', 'the draft provider must expose no send method')

    // 3. John drafts. Note: NO allow_send / send flag is passed anywhere.
    const r = await runJohn({
      db,
      mode: JOHN_MODES.DRAFT,
      provider,
      leadSource: yanaSource,
      maxDrafts: 10,
    })

    assert.equal(r.ok, true, `John draft run should succeed, got ${JSON.stringify(r)}`)
    assert.equal(r.status, RUN_STATUS.COMPLETED)
    assert.equal(r.drafts_created, 1, 'John should save exactly one draft from the qualified lead')

    // The draft landed in the (mocked) Outlook draft folder: createDraft was the
    // only provider method invoked, and the saved row carries a real draft id.
    assert.equal(provider.calls.length, 1, 'exactly one Outlook createDraft call')
    assert.ok(provider.calls[0].toEmail, 'the draft was addressed to the lead contact')

    const drafts = await listDrafts(db, { limit: 10 })
    assert.equal(drafts.length, 1)
    assert.equal(drafts[0].draft_status, DRAFT_STATUS.CREATED, 'draft saved, not sent')
    assert.ok(drafts[0].provider_draft_id, 'the saved draft references the Outlook draft id')

    // The candidate is now marked pushed/queued for review (handed off to John),
    // proving the discovery → drafting handoff closed without any send.
    const pushed = await db
      .prepare(`SELECT COUNT(*) AS n FROM yana_lead_candidates WHERE pushed_to_john = 1`)
      .get()
    assert.equal(Number(pushed?.n || 0), 1, 'the drafted lead should be marked queued for review')
  } finally {
    restore()
    db.close()
  }
})
